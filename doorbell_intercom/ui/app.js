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
  pendingGo2rtc:    null,
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
      loadConfig();
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

  console.log('📞 Answering doorbell:', doorbell);
  console.log('go2rtc stream:', go2rtc, 'URL:', state.config?.go2rtc_url);
  console.log('camera_entity:', camera);

  wsSend({ type: 'call_answered', doorbell });

  el.callDbName.textContent    = doorbell;
  el.callStatusTxt.textContent = 'Connecting…';
  el.callVideo.classList.add('hidden');
  el.callMjpeg.classList.add('hidden');
  el.callNoVideo.classList.remove('hidden');
  showScreen('call');

  // Prioritize go2rtc WebRTC for two-way audio + video
  if (go2rtc && state.config?.go2rtc_url) {
    console.log('🎥 Trying go2rtc WebRTC (local network candidates)...');
    await startGo2rtcWebRTC(go2rtc, state.config.go2rtc_url);
  } else if (camera) {
    console.log('⚠️  No go2rtc configured, using snapshot mode');
    startSnapshotFallback(camera);
    el.callStatusTxt.textContent = 'Live (snapshot mode)';
  } else {
    el.callStatusTxt.textContent = 'No camera configured';
  }
}

// ── go2rtc WebRTC (direct — best quality + two-way audio) ────────────────────
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
        if (cand.includes('192.168') || cand.includes('host')) {
          console.log('🧊 Local ICE candidate found:', cand.substring(0, 80) + '...');
        }
      } else {
        console.log('✅ ICE gathering complete');
      }
    };

    await attachMicrophone(pc);
    pc.addTransceiver('video', { direction: 'recvonly' });

    pc.ontrack = (e) => {
      console.log('📹 Got track:', e.track.kind, 'ready state:', e.track.readyState);
      if (e.track.kind === 'video') {
        console.log('📺 Video track ready, stream count:', e.streams.length);
        showVideoStream(e.streams[0] || new MediaStream([e.track]));
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    const webrtcUrl = `${go2rtcUrl.replace(/\/+$/, '')}/api/webrtc?src=${encodeURIComponent(streamName)}`;
    console.log('📤 POST to:', webrtcUrl);
    
    const resp = await fetch(webrtcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp
    });
    
    console.log('📥 go2rtc response:', resp.status, resp.statusText);
    
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`go2rtc HTTP ${resp.status}: ${text.substring(0, 100)}`);
    }

    const sdp = await resp.text();
    if (!sdp || sdp.length < 10) throw new Error('Empty SDP response from go2rtc');
    
    await pc.setRemoteDescription({ type: 'answer', sdp });
    console.log('✅ go2rtc WebRTC answer accepted!');
    el.callStatusTxt.textContent = 'Live';
    
    // Timeout fallback: if connection fails within 15 seconds, fall back to snapshot
    // Give local network candidates time to establish
    setTimeout(() => {
      if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') {
        console.warn('⏱️ WebRTC connection failed after 15s, falling back to snapshot');
        startSnapshotFallback(state.pendingCamera);
        el.callStatusTxt.textContent = 'Live (snapshot mode)';
      }
    }, 15000);

  } catch (e) {
    console.error('❌ go2rtc WebRTC failed:', e.message);
    startSnapshotFallback(state.pendingCamera);
  }
}

// ── HA native WebRTC relay (works with any HA-supported camera) ───────────────
async function startHAWebRTC(entityId) {
  try {
    const pc = buildPeerConnection();
    state.pc = pc;

    await attachMicrophone(pc);
    pc.addTransceiver('video', { direction: 'recvonly' });

    pc.ontrack = (e) => {
      if (e.track.kind === 'video') showVideoStream(e.streams[0] || new MediaStream([e.track]));
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    const sessionId = `intercom_${Date.now()}`;
    state.haSessionId = sessionId;

    wsSend({
      type:       'webrtc_offer',
      entity_id:  entityId,
      offer:      pc.localDescription.sdp,
      session_id: sessionId,
    });
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

// ── MJPEG fallback (one-way video — works with any HA camera entity) ──────────
function startMjpegFallback() {
  const entity = state.pendingCamera;
  if (!entity) { el.callStatusTxt.textContent = 'No video available'; return; }
  console.log('Using snapshot mode');
  startSnapshotFallback(entity);
}

function startSnapshotFallback(entity) {
  stopSnapshotFallback();
  mediaReady = false;
  el.callVideo.classList.add('hidden');
  el.callNoVideo.classList.remove('hidden');
  el.callMjpeg.classList.add('hidden');
  
  // Only disable mic in snapshot mode (no microphone)
  // Speaker button remains enabled for UI consistency
  document.getElementById('btn-mute').disabled = true;
  
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
      // For local-only networks, use host candidates only (no public STUN)
      // This allows WebRTC to work within private networks
    ],
    iceTransportPolicy: 'all', // Allow all candidates (host, srflx, prflx, relay)
  });
}

async function attachMicrophone(pc) {
  try {
    if (!navigator?.mediaDevices?.getUserMedia) {
      console.warn('⚠️ getUserMedia not available (ingress context)');
      pc.addTransceiver('audio', { direction: 'recvonly' });
      return;
    }
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    state.localStream.getAudioTracks().forEach(t => pc.addTrack(t, state.localStream));
    console.log('🎤 Microphone attached');
  } catch (e) {
    // Microphone denied or unavailable — video-only call
    console.warn('⚠️ Microphone unavailable:', e.message);
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }
}

function waitForIceGathering(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { 
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
    // Safety timeout — local network candidates may take time
    setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', done);
      console.warn('⏱️ ICE gathering timeout (10s), proceeding anyway with available candidates');
      resolve();
    }, 10000);
  });
}

function showVideoStream(stream) {
  stopSnapshotFallback();
  mediaReady = true;
  state.hasWebRTC = true;
  el.callMjpeg.src = '';
  el.callMjpeg.classList.add('hidden');
  el.callVideo.srcObject = stream;
  el.callVideo.muted     = state.speakerMuted;
  el.callVideo.classList.remove('hidden');
  el.callNoVideo.classList.add('hidden');
  
  // Force play (autoplay may be blocked in ingress iframe)
  const playPromise = el.callVideo.play();
  if (playPromise !== undefined) {
    playPromise
      .then(() => console.log('📺 Video playing'))
      .catch(e => console.error('⚠️ Play failed:', e.message));
  }
  
  // Monitor stream readiness
  el.callVideo.onloadedmetadata = () => {
    console.log('✅ Video metadata loaded, dimensions:', el.callVideo.videoWidth, 'x', el.callVideo.videoHeight);
  };
  
  el.callVideo.onplay = () => console.log('▶️ Video started playing');
  el.callVideo.onpause = () => console.log('⏸️ Video paused');
  
  // Clear the error event since we have a successful WebRTC connection
  el.callMjpeg.onerror = null;
  
  // Enable mic button for WebRTC (has audio)
  document.getElementById('btn-mute').disabled = false;
}

// ── In-call controls ──────────────────────────────────────────────────────────
document.getElementById('btn-mute').addEventListener('click', () => {
  const btn = document.getElementById('btn-mute');
  if (btn.disabled || !state.localStream) {
    console.log('Mic not available:', { disabled: btn.disabled, hasStream: !!state.localStream });
    return;
  }
  state.muted = !state.muted;
  state.localStream.getAudioTracks().forEach(t => { t.enabled = !state.muted; });
  el.iconMic.classList.toggle('hidden',    state.muted);
  el.iconMicOff.classList.toggle('hidden', !state.muted);
  document.getElementById('btn-mute').classList.toggle('muted', state.muted);
  console.log('Mic toggled:', state.muted ? 'muted' : 'unmuted');
});

document.getElementById('btn-speaker').addEventListener('click', () => {
  state.speakerMuted = !state.speakerMuted;
  // Only mute video element if it's a VIDEO tag (WebRTC mode)
  if (el.callVideo.tagName === 'VIDEO' && el.callVideo.srcObject) {
    el.callVideo.muted = state.speakerMuted;
    console.log('Speaker toggled:', state.speakerMuted ? 'muted' : 'unmuted');
  }
  document.getElementById('btn-speaker').classList.toggle('active', !state.speakerMuted);
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
  el.callMjpeg.src       = '';

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
  // Only start snapshot fallback if:
  // 1. We have a camera entity
  // 2. We're not already in snapshot mode (no timer)
  // 3. We don't have an active WebRTC connection
  if (entity && !state.snapshotTimer && !state.hasWebRTC) {
    console.warn('⚠️ Image render failed, switching to snapshot mode');
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
  if (!doorbell) {
    console.error('Doorbell not found at index:', index);
    return;
  }

  state.currentDoorbell = doorbell.name;
  state.pendingCamera   = doorbell.camera_entity;
  state.pendingGo2rtc   = doorbell.go2rtc_stream || null;
  state.pendingSpeaker  = doorbell.speaker_entity || null;

  console.log('📱 Opening doorbell from list:', doorbell.name);
  console.log('Config:', { go2rtc_stream: doorbell.go2rtc_stream, camera_entity: doorbell.camera_entity });

  el.callDbName.textContent    = doorbell.name;
  el.callStatusTxt.textContent = 'Connecting…';
  el.callVideo.classList.add('hidden');
  el.callMjpeg.classList.add('hidden');
  el.callNoVideo.classList.remove('hidden');
  showScreen('call');

  const go2rtc   = state.pendingGo2rtc;
  const camera   = state.pendingCamera;

  // Prioritize go2rtc WebRTC for audio + video (local network)
  if (go2rtc && state.config?.go2rtc_url) {
    console.log('🎥 Trying go2rtc WebRTC (local network candidates)...');
    await startGo2rtcWebRTC(go2rtc, state.config.go2rtc_url);
  } else if (camera) {
    console.log('⚠️  No go2rtc configured, using snapshot mode');
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
