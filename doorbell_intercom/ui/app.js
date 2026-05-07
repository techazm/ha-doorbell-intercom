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
  haWebRtcUnsupported: false,
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

  wsSend({ type: 'call_answered', doorbell });

  el.callDbName.textContent    = doorbell;
  el.callStatusTxt.textContent = 'Connecting…';
  el.callVideo.classList.add('hidden');
  el.callMjpeg.classList.add('hidden');
  el.callNoVideo.classList.remove('hidden');
  showScreen('call');

  if (go2rtc && state.config?.go2rtc_url) {
    await startGo2rtcWebRTC(go2rtc, state.config.go2rtc_url);
  } else if (camera) {
    if (state.haWebRtcUnsupported) {
      startMjpegFallback();
      el.callStatusTxt.textContent = 'Live (video only)';
    } else {
      await startHAWebRTC(camera);
    }
  } else {
    el.callStatusTxt.textContent = 'No camera configured';
  }
}

// ── go2rtc WebRTC (direct — best quality + two-way audio) ────────────────────
async function startGo2rtcWebRTC(streamName, go2rtcUrl) {
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

    const resp = await fetch(
      `${go2rtcUrl}/api/webrtc?src=${encodeURIComponent(streamName)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp }
    );
    if (!resp.ok) throw new Error(`go2rtc HTTP ${resp.status}`);

    const sdp = await resp.text();
    await pc.setRemoteDescription({ type: 'answer', sdp });
    el.callStatusTxt.textContent = 'Live';

  } catch (e) {
    console.error('go2rtc WebRTC failed:', e.message);
    startMjpegFallback();
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
  if (!state.pc) return;
  try {
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
  console.log('Using MJPEG stream');
  el.callMjpeg.src = `${apiBase}/api/stream/${entity}`;
  el.callMjpeg.classList.remove('hidden');
  el.callNoVideo.classList.add('hidden');
  el.callStatusTxt.textContent = 'Live (video only)';
}

// ── WebRTC helpers ────────────────────────────────────────────────────────────
function buildPeerConnection() {
  return new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
}

async function attachMicrophone(pc) {
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    state.localStream.getAudioTracks().forEach(t => pc.addTrack(t, state.localStream));
  } catch (e) {
    // Microphone denied or unavailable — video-only call
    console.warn('Microphone unavailable:', e.message);
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }
}

function waitForIceGathering(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const done = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', done); resolve(); } };
    pc.addEventListener('icegatheringstatechange', done);
    // Safety timeout — some networks take time
    setTimeout(resolve, 4000);
  });
}

function showVideoStream(stream) {
  el.callVideo.srcObject = stream;
  el.callVideo.muted     = state.speakerMuted;
  el.callVideo.classList.remove('hidden');
  el.callNoVideo.classList.add('hidden');
}

// ── In-call controls ──────────────────────────────────────────────────────────
document.getElementById('btn-mute').addEventListener('click', () => {
  state.muted = !state.muted;
  if (state.localStream) {
    state.localStream.getAudioTracks().forEach(t => { t.enabled = !state.muted; });
  }
  el.iconMic.classList.toggle('hidden',    state.muted);
  el.iconMicOff.classList.toggle('hidden', !state.muted);
  document.getElementById('btn-mute').classList.toggle('muted', state.muted);
});

document.getElementById('btn-speaker').addEventListener('click', () => {
  state.speakerMuted    = !state.speakerMuted;
  el.callVideo.muted    = state.speakerMuted;
  document.getElementById('btn-speaker').classList.toggle('active', !state.speakerMuted);
});

document.getElementById('btn-hangup').addEventListener('click', () => {
  wsSend({ type: 'call_ended', doorbell: state.currentDoorbell });
  endCall();
});

function endCall() {
  if (state.pc) { state.pc.close(); state.pc = null; }
  if (state.localStream) { state.localStream.getTracks().forEach(t => t.stop()); state.localStream = null; }

  el.callVideo.srcObject = null;
  el.callMjpeg.src       = '';

  // Reset mic icon
  state.muted = false;
  el.iconMic.classList.remove('hidden');
  el.iconMicOff.classList.add('hidden');

  state.currentDoorbell = null;
  showScreen('idle');
}

// ── Config loading + doorbell list ────────────────────────────────────────────
async function loadConfig() {
  try {
    const resp    = await fetch(`${apiBase}/api/config`);
    state.config  = await resp.json();
    renderDoorbellList();
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

  if (state.pendingCamera) {
    // Start with a universal stream path so users see video instantly.
    startMjpegFallback();
    // Upgrade to WebRTC when available for lower latency and two-way audio.
    if (!state.haWebRtcUnsupported) {
      await startHAWebRTC(state.pendingCamera);
    }
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
