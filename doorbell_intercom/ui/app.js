'use strict';

// ── Ingress-aware base URL ────────────────────────────────────────────────────
// The server injects window.INGRESS_PATH (e.g. "/api/hassio_ingress/TOKEN")
// so all URLs work correctly whether accessed via HA ingress or directly.
const ingressPath = (window.INGRESS_PATH || '').replace(/\/+$/, '');
const proto     = location.protocol === 'https:' ? 'https' : 'http';
const wsProto   = location.protocol === 'https:' ? 'wss'   : 'ws';
const apiBase   = `${proto}://${location.host}${ingressPath}`;
const wsUrl     = `${wsProto}://${location.host}${ingressPath}/ws`;

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  ws:               null,
  pc:               null,       // RTCPeerConnection (HA WebRTC relay)
  localStream:      null,       // getUserMedia stream (microphone)
  muted:            false,
  speakerMuted:     false,
  currentDoorbell:  null,
  pendingCamera:    null,
  pendingGo2rtc:    null,       // go2rtc stream name for WebRTC
  pendingSpeaker:   null,
  haSessionId:      null,
  config:           null,
  audioCtx:         null,
  ringTimer:        null,
  haWebRtcUnsupported: true,
  snapshotTimer:    null,
  hasWebRTC:        false,      // Flag to track active WebRTC
};

// ── DOM ───────────────────────────────────────────────────────────────────────
const screen = {
  idle:    document.getElementById('screen-idle'),
  ringing: document.getElementById('screen-ringing'),
  call:    document.getElementById('screen-call'),
};

const el = {
  doorbellList:  document.getElementById('doorbell-list'),
  connStatus:    document.getElementById('conn-status'),
  ringName:      document.getElementById('ring-name'),
  ringImg:       document.getElementById('ring-img'),
  callVideo:     document.getElementById('call-video'),
  callMjpeg:     document.getElementById('call-mjpeg'),
  callNoVideo:   document.getElementById('call-no-video'),
  callStatusTxt: document.getElementById('call-status-text'),
  callDbName:    document.getElementById('call-doorbell-name'),
  iconMic:       document.getElementById('icon-mic'),
  iconMicOff:    document.getElementById('icon-mic-off'),
};

let mediaReady = false;

// ── Screen routing ────────────────────────────────────────────────────────────
function showScreen(name) {
  Object.entries(screen).forEach(([k, el]) => el.classList.toggle('active', k === name));
}

// ── Ring tone (Web Audio API — no audio files required) ───────────────────────
function startRingTone() {
  if (state.ringTimer) return;
  playBeep();
  state.ringTimer = setInterval(playBeep, 2200);
}

function stopRingTone() {
  clearInterval(state.ringTimer);
  state.ringTimer = null;
}

function playBeep() {
  try {
    if (!state.audioCtx) state.audioCtx = new AudioContext();
    const ctx = state.audioCtx;
    // Two-tone doorbell: high note then low note
    [
      { freq: 1046, start: 0,    end: 0.22 },
      { freq:  784, start: 0.25, end: 0.45 },
    ].forEach(({ freq, start, end }) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0, ctx.currentTime + start);
      gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + start + 0.03);
      gain.gain.linearRampToValueAtTime(0.0,  ctx.currentTime + end);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + end + 0.05);
    });
  } catch { /* AudioContext may be suspended before user gesture */ }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => setConnStatus(true);

  state.ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleMessage(msg);
  };

  state.ws.onclose = () => {
    setConnStatus(false);
    setTimeout(connectWS, 3000);
  };

  state.ws.onerror = () => state.ws.close();
}

function wsSend(msg) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

function setConnStatus(up) {
  el.connStatus.textContent = up ? 'Connected' : 'Reconnecting…';
  el.connStatus.className   = `conn-status ${up ? 'connected' : 'disconnected'}`;
}

// ── Server message handler ────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'hello':
      // Store the hello payload so we can replay active rings after config loads.
      state._helloMsg = msg;
      loadConfig().then(async () => {
        const rings = state._helloMsg?.active_rings || [];
        if (rings.length > 0) {
          // Panel opened while a ring is already active (e.g. user tapped the
          // notification). Skip the ringing screen and go straight to the video
          // call — this is what the user wants when they tap "Answer".
          const ring = rings[0];
          state.currentDoorbell = ring.doorbell;
          state.pendingCamera   = ring.camera_entity;
          state.pendingGo2rtc   = ring.go2rtc_stream || null;
          state.pendingSpeaker  = ring.speaker_entity || null;
          await answerCall();
        }
        // If no active ring, loadConfig() already left us on the idle screen.
      });
      break;

    case 'doorbell_ring':
      onDoorbellRing(msg);
      sendBrowserNotification(msg.doorbell);
      break;

    case 'doorbell_timeout':
      if (state.currentDoorbell === msg.doorbell) dismissRinging();
      break;

    // Another client answered — hide ringing overlay on this device
    case 'call_answered':
      if (screen.ringing.classList.contains('active')) dismissRinging();
      break;

    case 'call_ended':
      endCall();
      break;

    case 'webrtc_answer':
      applyWebRTCAnswer(msg);
      break;

    case 'webrtc_error':
      if (/Unknown command|unsupported/i.test(msg.error || '')) {
        state.haWebRtcUnsupported = true;
      }
      console.warn('WebRTC relay failed, falling back to MJPEG:', msg.error);
      startMjpegFallback();
      break;
  }
}

// ── Doorbell ring ─────────────────────────────────────────────────────────────
function onDoorbellRing(msg) {
  state.currentDoorbell = msg.doorbell;
  state.pendingCamera   = msg.camera_entity;
  state.pendingGo2rtc   = msg.go2rtc_stream;
  state.pendingSpeaker  = msg.speaker_entity;

  el.ringName.textContent = msg.doorbell;

  if (msg.camera_entity) {
    el.ringImg.src = `${apiBase}/api/snapshot/${msg.camera_entity}?t=${Date.now()}`;
    document.getElementById('ring-snapshot').classList.remove('hidden');
  } else {
    document.getElementById('ring-snapshot').classList.add('hidden');
  }

  showScreen('ringing');
  startRingTone();
}

function dismissRinging() {
  stopRingTone();
  state.currentDoorbell = null;
  showScreen('idle');
}

// ── Answer / Decline ──────────────────────────────────────────────────────────
document.getElementById('btn-answer').addEventListener('click', answerCall);

document.getElementById('btn-decline').addEventListener('click', () => {
  wsSend({ type: 'call_ended', doorbell: state.currentDoorbell });
  dismissRinging();
});

document.getElementById('btn-dismiss').addEventListener('click', () => {
  wsSend({ type: 'call_ended', doorbell: state.currentDoorbell });
  dismissRinging();
});

async function answerCall() {
  stopRingTone();
  const doorbell = state.currentDoorbell;
  const camera   = state.pendingCamera;
  const go2rtc   = state.pendingGo2rtc;

  wsSend({ type: 'call_answered', doorbell });

  el.callDbName.textContent    = doorbell;
  el.callStatusTxt.textContent = 'Connecting…';
  el.callVideo.classList.add('hidden');
  el.callMjpeg.classList.add('hidden');
  el.callNoVideo.classList.remove('hidden');
  showScreen('call');

  if (go2rtc && state.config?.go2rtc_url) {
    // go2rtc WebRTC — lowest latency, two-way audio via configured go2rtc
    console.log('🎥 Starting go2rtc WebRTC...');
    await startGo2rtcWebRTC(go2rtc, state.config.go2rtc_url);
  } else if (camera && !state.haWebRtcUnsupported) {
    // HA native WebRTC — uses HA's internal go2rtc (full build, supports reolink://)
    // Falls back automatically if HA returns an unsupported error
    console.log('🎥 Starting HA native WebRTC for', camera);
    await startHAWebRTC(camera);
  } else if (camera) {
    startSnapshotFallback(camera);
    el.callStatusTxt.textContent = 'Live (snapshot mode)';
  } else {
    el.callStatusTxt.textContent = 'No camera configured';
  }
}

// ── go2rtc WebRTC (direct — best quality + two-way audio)
async function startGo2rtcWebRTC(streamName, go2rtcUrl) {
  try {
    console.log('🚀 Starting go2rtc WebRTC:', streamName, 'at', go2rtcUrl);
    const pc = buildPeerConnection();
    state.pc = pc;

    // Monitor connection state
    pc.onconnectionstatechange = () => {
      console.log('🔗 PC connection state:', pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        console.error('❌ WebRTC connection failed/disconnected, ICE state:', pc.iceConnectionState);
      }
    };
    pc.oniceconnectionstatechange = () => {
      console.log('❄️ ICE connection state:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        console.error('❌ ICE failed - checking ICE candidates...');
      }
    };
    
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        const cand = e.candidate.candidate;
        console.log('🧊 ICE candidate:', cand.substring(0, 100));
      } else {
        console.log('✅ ICE gathering complete');
      }
    };

    await attachMicrophone(pc);
    // Create a combined media stream to hold both audio and video tracks
    const combinedStream = new MediaStream();
    
    // Request audio and video using offer constraints (more compatible with go2rtc)
    pc.ontrack = (e) => {
      console.log('📹 Got track:', e.track.kind, 'ready state:', e.track.readyState);
      
      // Add the track to our combined stream
      combinedStream.addTrack(e.track);
      console.log('✅ Added', e.track.kind, 'track to stream. Stream now has', 
                  combinedStream.getVideoTracks().length, 'video,',
                  combinedStream.getAudioTracks().length, 'audio');
      
      // Show video stream with combined audio + video
      if (combinedStream.getVideoTracks().length > 0) {
        console.log('🎬 Ready to display: video + audio bundled');
        showVideoStream(combinedStream);
      }
    };

    // Create offer requesting both audio and video using legacy constraints
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    // Use server proxy to avoid CORS + ingress isolation issues
    const webrtcUrl = `${apiBase}/api/webrtc-proxy/${encodeURIComponent(streamName)}`;
    console.log('📤 POST SDP to server proxy:', webrtcUrl);
    
    const resp = await fetch(webrtcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp
    });
    
    console.log('📥 server response:', resp.status, resp.statusText);
    
    let sdp;
    try {
      sdp = await resp.text();
    } catch (e) {
      throw new Error(`Failed to read response body: ${e.message}`);
    }
    
    if (!resp.ok) {
      throw new Error(`Server HTTP ${resp.status}: ${sdp.substring(0, 100)}`);
    }
    
    if (!sdp || sdp.length < 10) throw new Error('Empty SDP response from server');
    
    // Log candidates from go2rtc answer
    const candidateLines = sdp.split('\n').filter(line => line.startsWith('a=candidate:'));
    console.log(`📊 SDP answer contains ${candidateLines.length} candidates from go2rtc:`);
    candidateLines.forEach((line, i) => {
      console.log(`  [${i}] ${line.substring(0, 120)}`);
    });
    
    await pc.setRemoteDescription({ type: 'answer', sdp });
    console.log('✅ WebRTC answer accepted from go2rtc!');
    el.callStatusTxt.textContent = 'Live';

    // Diagnostic only — do NOT fall back to MJPEG if video is working.
    // If there is no audio track, it means go2rtc is not encoding audio
    // (camera sends G.711 which needs ffmpeg re-encoding — see Frigate config).
    setTimeout(() => {
      const audioTracks = combinedStream.getAudioTracks();
      if (audioTracks.length === 0) {
        console.warn('⚠️ WebRTC: no audio track from go2rtc. ' +
          'Fix: change your Frigate go2rtc stream source to ' +
          'ffmpeg:rtsp://...#video=copy#audio=aac');
        el.callStatusTxt.textContent = 'Live (no audio — check go2rtc)';
      } else {
        console.log('\u2705 WebRTC audio track active:', audioTracks[0].label || audioTracks[0].kind);
        el.callStatusTxt.textContent = 'Live';
      }
    }, 3000);

  } catch (e) {
    console.error('❌ WebRTC failed:', e.message);
    el.callStatusTxt.textContent = `Error: ${e.message}`;
  }
}

// ── HA native WebRTC relay (uses HA's internal go2rtc — full build with reolink://) ──
async function startHAWebRTC(entityId) {
  try {
    const pc = buildPeerConnection();
    state.pc = pc;

    await attachMicrophone(pc);

    // Combined stream captures both audio and video from HA's WebRTC
    const combinedStream = new MediaStream();
    pc.ontrack = (e) => {
      console.log('📡 HA WebRTC track:', e.track.kind);
      combinedStream.addTrack(e.track);
      if (combinedStream.getVideoTracks().length > 0) {
        showVideoStream(combinedStream);
      }
    };

    // Add video receive transceiver (audio handled by attachMicrophone)
    pc.addTransceiver('video', { direction: 'recvonly' });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    const sessionId = `intercom_${Date.now()}`;
    state.haSessionId = sessionId;

    console.log('📤 Sending WebRTC offer to HA for', entityId);
    wsSend({
      type:       'webrtc_offer',
      entity_id:  entityId,
      offer:      pc.localDescription.sdp,
      session_id: sessionId,
    });
    el.callStatusTxt.textContent = 'Connecting via HA…';
    // Answer arrives asynchronously via applyWebRTCAnswer()

  } catch (e) {
    console.error('HA WebRTC failed:', e.message);
    startMjpegFallback();
  }
}

async function applyWebRTCAnswer(msg) {
  if (!state.pc || state.pc.connectionState === 'closed') {
    console.warn('WebRTC peer connection closed, ignoring answer');
    return;
  }
  try {
    if (state.pc.signalingState !== 'have-local-offer') {
      console.warn('Unexpected signaling state:', state.pc.signalingState);
      return;
    }
    await state.pc.setRemoteDescription({ type: 'answer', sdp: msg.answer });
    for (const c of msg.candidates || []) {
      await state.pc.addIceCandidate(c).catch(() => {});
    }
    el.callStatusTxt.textContent = 'Live';
  } catch (e) {
    console.error('setRemoteDescription failed:', e.message);
    startMjpegFallback();
  }
}

// ── go2rtc HTTP streaming fallback (used only when WebRTC is unavailable) ─────
// Tries formats in order: generic → mjpeg. Stops at the first format that
// successfully plays. NOTE: el.callVideo.audioTracks is NOT supported in
// Chrome, so we do NOT use it for audio detection — the browser will play
// audio automatically if it is present in the stream.
function startGo2rtcMjpeg(streamName) {
  if (!streamName) { console.error('❌ No stream name for HTTP fallback'); return; }

  stopSnapshotFallback();
  mediaReady   = false;
  state.hasWebRTC = false;

  el.callVideo.classList.remove('hidden');
  el.callNoVideo.classList.add('hidden');
  el.callMjpeg.classList.add('hidden');
  el.callVideo.muted = false;
  el.callStatusTxt.textContent = 'Live (streaming)';

  // generic: let go2rtc pick the best container (includes audio when available)
  // mjpeg:   universal video-only fallback
  tryStreamFormat(streamName, ['generic', 'mjpeg'], 0);
}

function tryStreamFormat(streamName, formats, index) {
  if (index >= formats.length) {
    console.error('❌ All stream formats failed — no playable stream from go2rtc');
    el.callStatusTxt.textContent = 'Stream unavailable';
    return;
  }

  const format = formats[index];
  const url = format === 'generic'
    ? `${apiBase}/api/go2rtc-stream/${encodeURIComponent(streamName)}`
    : `${apiBase}/api/go2rtc-stream/${encodeURIComponent(streamName)}?format=${format}`;
  console.log(`🎬 Trying stream format ${index + 1}/${formats.length}: ${format}`);

  el.callVideo.src = url;

  const onCanPlay = () => {
    // First format that plays wins — accept it regardless of whether audio is
    // present (browser plays audio automatically if the stream contains it).
    console.log(`\u2705 Format ${format} playable — using it`);
    mediaReady = true;
    el.callVideo.muted = false;
    el.callStatusTxt.textContent = 'Live (streaming)';
  };

  const onError = () => {
    console.warn(`\u26a0\ufe0f Format ${format} failed, trying next...`);
    tryStreamFormat(streamName, formats, index + 1);
  };

  el.callVideo.addEventListener('canplay', onCanPlay, { once: true });
  el.callVideo.addEventListener('error',   onError,   { once: true });
  el.callVideo.play().catch(e => console.warn(`\u26a0\ufe0f Play failed for ${format}:`, e.message));
}

function startSnapshotFallback(entity) {
  stopSnapshotFallback();
  mediaReady = false;
  el.callVideo.classList.add('hidden');
  el.callNoVideo.classList.remove('hidden');
  el.callMjpeg.classList.add('hidden');
  
  // Speak button stays enabled (clicking opens new tab where mic works)
  const btnMute = document.getElementById('btn-mute');
  btnMute.disabled = false;
  btnMute.title = 'Microphone blocked — tap to open in new tab';
  btnMute.classList.add('muted');

  const tick = () => {
    el.callMjpeg.src = `${apiBase}/api/snapshot/${entity}?t=${Date.now()}`;
  };
  tick();
  state.snapshotTimer = setInterval(tick, 1200);
  el.callStatusTxt.textContent = 'Live (snapshot mode)';
}

function stopSnapshotFallback() {
  clearInterval(state.snapshotTimer);
  state.snapshotTimer = null;
}

// ── WebRTC helpers ────────────────────────────────────────────────────────────
function buildPeerConnection() {
  return new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },  // Same STUN as Frigate go2rtc
    ],
    iceTransportPolicy: 'all',  // Accept all ICE candidates (host, srflx, prflx, relay)
    bundlePolicy: 'max-bundle',  // Reduce port usage
    rtcpMuxPolicy: 'require',    // Use RTCP mux
  });
}

async function attachMicrophone(pc) {
  try {
    // Reuse an already-acquired stream (e.g. from tapping Speak before/during call)
    if (state.localStream && state.localStream.getAudioTracks().length > 0) {
      state.localStream.getAudioTracks().forEach(t => pc.addTrack(t, state.localStream));
      console.log('🎤 Microphone reused from existing stream');
      return;
    }
    if (!navigator?.mediaDevices?.getUserMedia) {
      console.warn('⚠️ getUserMedia not available (HTTP context — need HTTPS for mic)');
      pc.addTransceiver('audio', { direction: 'recvonly' });
      return;
    }
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    state.localStream.getAudioTracks().forEach(t => pc.addTrack(t, state.localStream));
    console.log('🎤 Microphone attached');
  } catch (e) {
    // Microphone denied or unavailable — receive-only call
    console.warn('⚠️ Microphone unavailable:', e.message);
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }
}

function waitForIceGathering(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { 
      console.log('✅ ICE gathering already complete');
      resolve(); 
      return; 
    }
    const done = () => { 
      if (pc.iceGatheringState === 'complete') { 
        pc.removeEventListener('icegatheringstatechange', done); 
        console.log('✅ ICE gathering complete');
        resolve(); 
      } 
    };
    pc.addEventListener('icegatheringstatechange', done);
    // Wait up to 15s for local network candidates
    setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', done);
      console.warn('⏱️ ICE gathering timeout (15s), proceeding with available candidates');
      resolve();
    }, 15000);
  });
}

function showVideoStream(stream) {
  stopSnapshotFallback();
  mediaReady = true;
  state.hasWebRTC = true;
  el.callMjpeg.src = '';
  el.callMjpeg.classList.add('hidden');
  el.callVideo.srcObject = stream;
  el.callVideo.classList.remove('hidden');
  el.callNoVideo.classList.add('hidden');

  console.log('🎬 Video stream ready');

  // Force play then explicitly unmute — autoplay policy allows unmuted playback
  // when triggered by a user gesture (clicking Answer).
  const playPromise = el.callVideo.play();
  if (playPromise !== undefined) {
    playPromise
      .then(() => {
        // Unmute only after play() resolves; some browsers reset muted on play()
        el.callVideo.muted = state.speakerMuted; // default: false → audio on
        console.log('📺 Video playing, muted=' + el.callVideo.muted);
      })
      .catch(e => {
        // Autoplay blocked — fall back to muted play, speaker toggle still works
        console.warn('⚠️ Unmuted autoplay blocked, starting muted:', e.message);
        el.callVideo.muted = true;
        el.callVideo.play().catch(() => {});
      });
  }

  // Monitor stream readiness
  el.callVideo.onloadedmetadata = () => {
    console.log('✅ Video metadata loaded, dimensions:', el.callVideo.videoWidth, 'x', el.callVideo.videoHeight);
  };
  el.callVideo.onplay  = () => console.log('▶️ Video started playing');
  el.callVideo.onpause = () => console.log('⏸️ Video paused');

  // Clear the error event since we have a successful WebRTC connection
  el.callMjpeg.onerror = null;

  // Speak button: enable only if mic was successfully captured; if not, clicking
  // will open a new top-level tab where getUserMedia is allowed.
  const micAvailable = !!(state.localStream && state.localStream.getAudioTracks().length > 0);
  const btnMute = document.getElementById('btn-mute');
  btnMute.disabled = false; // always clickable
  btnMute.title = micAvailable
    ? 'Toggle microphone'
    : 'Microphone blocked — tap to open in new tab';
  if (!micAvailable) btnMute.classList.add('muted'); // show red/inactive style

  document.getElementById('btn-speaker').disabled = false;
}

// ── MJPEG / snapshot fallback helper (called from HA WebRTC error paths) ─────
function startMjpegFallback() {
  const go2rtc  = state.pendingGo2rtc;
  const camera  = state.pendingCamera;
  if (go2rtc) {
    startGo2rtcMjpeg(go2rtc);
  } else if (camera) {
    startSnapshotFallback(camera);
    el.callStatusTxt.textContent = 'Live (snapshot mode)';
  }
}

// ── In-call controls ──────────────────────────────────────────────────────────
document.getElementById('btn-mute').addEventListener('click', async () => {
  // ── Case 1: mic already acquired — toggle mute ────────────────────────────
  if (state.localStream) {
    state.muted = !state.muted;
    state.localStream.getAudioTracks().forEach(t => { t.enabled = !state.muted; });
    el.iconMic.classList.toggle('hidden',    state.muted);
    el.iconMicOff.classList.toggle('hidden', !state.muted);
    document.getElementById('btn-mute').classList.toggle('muted', state.muted);
    console.log('Mic toggled:', state.muted ? 'muted' : 'unmuted');
    return;
  }

  // ── Case 2: no mic yet — try to acquire it now ───────────────────────────
  // getUserMedia requires HTTPS. On plain HTTP (local IP) navigator.mediaDevices
  // is undefined. Accessing via a secure external URL (e.g. Cloudflare tunnel)
  // will allow this to succeed.
  if (!navigator?.mediaDevices?.getUserMedia) {
    flashStatus('Mic unavailable — open via HTTPS for two-way audio');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    state.localStream = stream;
    state.muted = false;

    // Update button to show mic is now active
    const btn = document.getElementById('btn-mute');
    btn.disabled = false;
    btn.title = 'Toggle microphone';
    btn.classList.remove('muted');
    el.iconMic.classList.remove('hidden');
    el.iconMicOff.classList.add('hidden');

    // If a go2rtc WebRTC call is active, the original SDP offer was made without
    // a mic track (recvonly), so go2rtc set up no receive channel. Simply adding
    // the track via addTrack() won't help. We must restart the WebRTC connection
    // so the new SDP offer includes the mic track (sendrecv audio).
    if (state.pc && state.pendingGo2rtc && state.config?.go2rtc_url) {
      console.log('🎤 Restarting WebRTC to include mic in SDP offer...');
      const oldPc = state.pc;
      state.pc = null;
      oldPc.close();
      flashStatus('Reconnecting with mic...');
      await startGo2rtcWebRTC(state.pendingGo2rtc, state.config.go2rtc_url);
    } else {
      flashStatus('Mic active — will be used on next call');
    }
  } catch (e) {
    console.warn('⚠️ Mic permission denied:', e.message);
    flashStatus('Mic permission denied');
  }
});

// Brief non-disruptive status flash that reverts after 3 seconds
function flashStatus(msg) {
  const prev = el.callStatusTxt.textContent;
  el.callStatusTxt.textContent = msg;
  setTimeout(() => { el.callStatusTxt.textContent = prev; }, 3000);
}

document.getElementById('btn-speaker').addEventListener('click', () => {
  state.speakerMuted = !state.speakerMuted;
  
  // Mute/unmute WebRTC received audio only
  if (el.callVideo.srcObject) {
    el.callVideo.muted = state.speakerMuted;
    console.log('🔊 WebRTC audio toggled:', state.speakerMuted ? 'muted' : 'unmuted');
  }
  
  // Also mute fallback audio if present
  const audioEl = document.getElementById('fallback-audio');
  if (audioEl) {
    audioEl.muted = state.speakerMuted;
  }
  
  console.log('🔊 Speaker toggled:', state.speakerMuted ? 'muted' : 'unmuted');
  
  // Update button visual state
  const btn = document.getElementById('btn-speaker');
  btn.classList.toggle('active', !state.speakerMuted);
  btn.style.opacity = state.speakerMuted ? '0.5' : '1';
});

document.getElementById('btn-hangup').addEventListener('click', () => {
  wsSend({ type: 'call_ended', doorbell: state.currentDoorbell });
  endCall();
});

function endCall() {
  if (state.pc) { state.pc.close(); state.pc = null; }
  if (state.localStream) { state.localStream.getTracks().forEach(t => t.stop()); state.localStream = null; }
  stopSnapshotFallback();

  el.callVideo.srcObject = null;
  el.callVideo.src = '';
  el.callVideo.muted = true;
  el.callMjpeg.src = '';
  
  // Stop fallback audio if present
  const audioEl = document.getElementById('fallback-audio');
  if (audioEl) {
    audioEl.pause();
    audioEl.src = '';
  }

  // Reset state
  state.hasWebRTC = false;
  state.muted = false;
  el.iconMic.classList.remove('hidden');
  el.iconMicOff.classList.add('hidden');

  state.currentDoorbell = null;
  showScreen('idle');
}

el.callMjpeg.addEventListener('error', () => {
  const entity = state.pendingCamera;
  // Only fall back to snapshot if not already in snapshot mode and no active WebRTC
  if (entity && !state.snapshotTimer && !state.hasWebRTC) {
    console.warn('⚠️ MJPEG stream failed, switching to snapshot mode');
    startSnapshotFallback(entity);
  }
});

el.callMjpeg.addEventListener('load', () => {
  mediaReady = true;
  el.callMjpeg.classList.remove('hidden');
  el.callNoVideo.classList.add('hidden');
});

el.callVideo.addEventListener('loadeddata', () => {
  mediaReady = true;
  el.callNoVideo.classList.add('hidden');
});

// ── Config loading + doorbell list ────────────────────────────────────────────
async function loadConfig() {
  try {
    const resp    = await fetch(`${apiBase}/api/config`);
    state.config  = await resp.json();
    state.haWebRtcUnsupported = state.config?.ha_webrtc_supported === false;
    console.log('⚙️  Config loaded:', {
      doorbells: state.config?.doorbells?.length,
      go2rtc_url: state.config?.go2rtc_url,
      ha_webrtc_supported: state.config?.ha_webrtc_supported
    });
    console.log('🚪 Doorbells:', state.config?.doorbells);
    renderDoorbellList();
    // Ensure we're on the idle screen (especially after page refresh)
    showScreen('idle');
    // Stop any lingering video playback
    endCall();
  } catch (e) {
    console.error('Failed to load config:', e.message);
  }
}

function renderDoorbellList() {
  const doorbells = state.config?.doorbells || [];
  if (!doorbells.length) {
    el.doorbellList.innerHTML = `
      <p class="empty-msg">
        No doorbells configured.<br>
        Add them in the add-on configuration panel.
      </p>`;
    return;
  }
  el.doorbellList.innerHTML = doorbells.map((d, i) => `
    <div class="doorbell-card" data-doorbell-index="${i}" role="button" tabindex="0" aria-label="Open ${escapeHtml(d.name)} intercom">
      <div class="doorbell-card-icon">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M10 21h4a2 2 0 0 1-4 0M12 3a7 7 0 0 1 7 7c0 4-2.5 6.5-2.5 6.5h-9S5 14 5 10a7 7 0 0 1 7-7z"/>
        </svg>
      </div>
      <div class="doorbell-card-info">
        <span class="doorbell-card-name">${escapeHtml(d.name)}</span>
        <span class="doorbell-card-entity">${escapeHtml(d.camera_entity || '')}</span>
      </div>
      <span class="doorbell-card-badge">Ready</span>
    </div>
  `).join('');

  // Allow opening a live intercom session directly from the idle list.
  el.doorbellList.querySelectorAll('.doorbell-card').forEach((card) => {
    const open = () => {
      const idx = parseInt(card.dataset.doorbellIndex || '-1', 10);
      openDoorbellFromList(idx);
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  });
}

async function openDoorbellFromList(index) {
  const doorbell = state.config?.doorbells?.[index];
  if (!doorbell) return;

  state.currentDoorbell = doorbell.name;
  state.pendingCamera   = doorbell.camera_entity;
  state.pendingGo2rtc   = doorbell.go2rtc_stream || null;
  state.pendingSpeaker  = doorbell.speaker_entity || null;

  el.callDbName.textContent    = doorbell.name;
  el.callStatusTxt.textContent = 'Connecting…';
  el.callVideo.classList.add('hidden');
  el.callMjpeg.classList.add('hidden');
  el.callNoVideo.classList.remove('hidden');
  showScreen('call');

  const go2rtc = state.pendingGo2rtc;
  const camera = state.pendingCamera;

  if (go2rtc && state.config?.go2rtc_url) {
    console.log('🎥 Starting go2rtc WebRTC...');
    await startGo2rtcWebRTC(go2rtc, state.config.go2rtc_url);
  } else if (camera && !state.haWebRtcUnsupported) {
    console.log('🎥 Starting HA native WebRTC for', camera);
    await startHAWebRTC(camera);
  } else if (camera) {
    startSnapshotFallback(camera);
    el.callStatusTxt.textContent = 'Live (snapshot mode)';
  } else {
    el.callStatusTxt.textContent = 'No camera configured';
  }
}

// ── Browser push notifications (background tab) ───────────────────────────────
async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

function sendBrowserNotification(doorbellName) {
  if (document.visibilityState === 'visible') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification('Doorbell', {
    body:             `${doorbellName} — Someone is at the door`,
    tag:              'doorbell-ring',
    requireInteraction: true,
  });
  n.onclick = () => { window.focus(); n.close(); };
}

// ── Utility ───────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────────
requestNotificationPermission();
connectWS();
