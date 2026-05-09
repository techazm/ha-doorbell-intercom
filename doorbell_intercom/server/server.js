'use strict';

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// ── Configuration ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '8765', 10);
const HA_TOKEN = process.env.SUPERVISOR_TOKEN || '';
const HA_API = 'http://supervisor/core/api';
const HA_WS_URL = 'ws://supervisor/core/websocket';

let cfg = { doorbells: [], ring_timeout: 60 };
try {
  if (process.env.ADDON_CONFIG) {
    cfg = { ...cfg, ...JSON.parse(process.env.ADDON_CONFIG) };
    console.log('Loaded config from ADDON_CONFIG');
  } else {
    const rawOptions = fs.readFileSync('/data/options.json', 'utf8');
    cfg = { ...cfg, ...JSON.parse(rawOptions) };
    console.log('Loaded config from /data/options.json');
  }
  
  // Auto-convert RTSP URLs to go2rtc HTTP API URLs
  if (cfg.go2rtc_url && cfg.go2rtc_url.startsWith('rtsp://')) {
    const url = new URL(cfg.go2rtc_url);
    const host = url.hostname;
    const port = url.port || 8554;
    cfg.go2rtc_url = `http://${host}:1984`;
    console.log(`[CONFIG] Auto-converted RTSP URL to HTTP API URL: ${cfg.go2rtc_url}`);
  }
} catch (e) {
  console.error('Failed to load add-on config:', e.message);
}

const indexHtml = fs.readFileSync(path.join(__dirname, 'ui', 'index.html'), 'utf8');

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

const app = express();
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

app.use(express.json());
// Static assets (style.css, app.js) — serve without index.html so we can inject
app.use(express.static(path.join(__dirname, 'ui'), { index: false }));

// Serve index.html with ingress base path injected
app.get('/', (req, res) => {
  const ingressPath = req.headers['x-ingress-path'] || '';
  const html = indexHtml.replace('__INGRESS_PATH__', ingressPath);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Config endpoint for the UI
app.get('/api/config', (_req, res) => {
  res.json({
    doorbells: cfg.doorbells.map(d => ({
      name: d.name,
      camera_entity: d.camera_entity,
      go2rtc_stream: d.go2rtc_stream || null,
      speaker_entity: d.speaker_entity || null,
    })),
    ha_webrtc_supported: false,
    go2rtc_url: cfg.go2rtc_url || '',
    ring_timeout: cfg.ring_timeout || 60,
  });
});

// Proxy camera snapshot (avoids exposing HA long-lived token to the browser)
app.get('/api/snapshot/:entityId', async (req, res) => {
  try {
    const resp = await haFetch(`/camera_proxy/${req.params.entityId}`);
    if (!resp.ok) return res.status(resp.status).end();
    res.set('Content-Type', resp.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'no-cache');
    resp.body.pipe(res);
  } catch (e) {
    console.error('Snapshot proxy error:', e.message);
    res.status(500).end();
  }
});

// Proxy MJPEG stream from HA — fallback when WebRTC is unavailable
app.get('/api/stream/:entityId', async (req, res) => {
  try {
    const resp = await haFetch(`/camera_proxy_stream/${req.params.entityId}`);
    if (!resp.ok) return res.status(resp.status).end();
    res.set('Content-Type', resp.headers.get('content-type') || 'multipart/x-mixed-replace');
    res.set('Cache-Control', 'no-cache');
    resp.body.pipe(res);
    req.on('close', () => resp.body.destroy());
  } catch (e) {
    console.error('Stream proxy error:', e.message);
    res.status(500).end();
  }
});

// Proxy go2rtc stream with format support (mp4, mkv, webm, mjpeg)
app.get('/api/go2rtc-stream/:streamName', async (req, res) => {
  if (!cfg.go2rtc_url) return res.status(404).json({ error: 'go2rtc_url not configured' });
  
  const streamName = req.params.streamName;
  const format = req.query.format || 'generic';
  
  // If 'generic' or no format specified, use /api/stream to let go2rtc auto-select
  let url;
  if (format === 'generic') {
    url = `${cfg.go2rtc_url.replace(/\/+$/, '')}/api/stream?src=${encodeURIComponent(streamName)}`;
    console.log(`[STREAM] Using generic auto-select endpoint: ${url}`);
  } else {
    const formatMap = {
      'mp4': 'stream.mp4',
      'mkv': 'stream.mkv',
      'webm': 'stream.webm',
      'mjpeg': 'stream.mjpeg',
    };
    
    const endpoint = formatMap[format] || 'stream.mjpeg';
    url = `${cfg.go2rtc_url.replace(/\/+$/, '')}/api/${endpoint}?src=${encodeURIComponent(streamName)}`;
    console.log(`[STREAM] Requesting ${format} format: ${url}`);
  }
  
  try {
    console.log(`[STREAM] Requesting ${format} from go2rtc: ${url}`);
    const resp = await fetch(url);
    
    if (!resp.ok) {
      console.warn(`[STREAM] ${format} returned ${resp.status}`);
      return res.status(resp.status).end();
    }
    
    console.log(`[STREAM] Serving ${format} stream for ${streamName}`);
    res.set('Content-Type', resp.headers.get('content-type') || 'multipart/x-mixed-replace; boundary=go2rtc');
    res.set('Cache-Control', 'no-cache');
    res.set('Connection', 'keep-alive');
    res.set('Access-Control-Allow-Origin', '*');
    resp.body.pipe(res);
    req.on('close', () => resp.body.destroy());
  } catch (e) {
    console.error(`[STREAM] Proxy error for ${streamName}:`, e.message);
    res.status(500).json({ error: 'Stream proxy failed', details: e.message });
  }
});

// Proxy go2rtc audio stream (separate from video, for audio-only fallback)
app.get('/api/go2rtc-audio/:streamName', async (req, res) => {
  if (!cfg.go2rtc_url) return res.status(404).json({ error: 'go2rtc_url not configured' });
  
  const streamName = req.params.streamName;
  
  // Try audio-only endpoints in order of likelihood
  const audioEndpoints = [
    { endpoint: 'stream.aac', format: 'aac' },
    { endpoint: 'stream.opus', format: 'opus' },
    { endpoint: 'stream.g711', format: 'g711' },
    { endpoint: 'stream.wav', format: 'wav' },
  ];
  
  // Try each audio endpoint
  for (const {endpoint, format} of audioEndpoints) {
    const url = `${cfg.go2rtc_url.replace(/\/+$/, '')}/api/${endpoint}?src=${encodeURIComponent(streamName)}`;
    try {
      console.log(`[AUDIO] Trying ${format} endpoint: ${url}`);
      const resp = await fetch(url);
      if (resp.ok) {
        console.log(`[AUDIO] ✅ Found ${format} audio stream!`);
        res.set('Content-Type', resp.headers.get('content-type') || `audio/${format}`);
        res.set('Cache-Control', 'no-cache');
        res.set('Connection', 'keep-alive');
        res.set('Access-Control-Allow-Origin', '*');
        resp.body.pipe(res);
        req.on('close', () => resp.body.destroy());
        return;
      }
    } catch (e) {
      console.log(`[AUDIO] ${format} endpoint failed:`, e.message);
    }
  }
  
  // No audio endpoints found
  console.log('[AUDIO] ❌ No audio streams available from go2rtc');
  res.status(404).json({ 
    error: 'No audio stream available',
    message: 'Audio is present in source but not encoded by go2rtc. Check go2rtc config to enable audio encoding for output formats.'
  });
});

// Proxy go2rtc stream info — returns what tracks (video/audio) go2rtc sees
// from the source camera. Used for audio diagnostics.
app.get('/api/go2rtc-stream-info/:streamName', async (req, res) => {
  if (!cfg.go2rtc_url) return res.status(404).json({ error: 'go2rtc_url not configured' });
  const base = cfg.go2rtc_url.replace(/\/+$/, '');
  try {
    const resp = await fetch(`${base}/api/streams`);
    if (!resp.ok) return res.status(resp.status).json({ error: `go2rtc /api/streams returned ${resp.status}` });
    const all = await resp.json();
    const stream = all[req.params.streamName];
    if (!stream) return res.status(404).json({ error: 'Stream not found in go2rtc', available: Object.keys(all) });

    // Collect all media tracks from all producers
    const producers = stream.producers || [];
    const tracks = producers.flatMap(p =>
      (p.medias || []).map(m => ({ kind: m.kind, codec: m.codec || '?', producer: p.url || '?' }))
    );
    const hasVideo = tracks.some(t => t.kind === 'video');
    const hasAudio = tracks.some(t => t.kind === 'audio');

    res.json({ stream: req.params.streamName, hasVideo, hasAudio, tracks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy go2rtc WebRTC SDP signaling (avoids CORS from browser to go2rtc)
app.post('/api/webrtc-proxy/:streamName', async (req, res) => {
  if (!cfg.go2rtc_url) return res.status(404).json({ error: 'go2rtc_url not configured' });
  const url = `${cfg.go2rtc_url.replace(/\/+$/, '')}/api/webrtc?src=${encodeURIComponent(req.params.streamName)}`;
  try {
    const body = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body,
    });
    if (!resp.ok) throw new Error(`go2rtc responded with HTTP ${resp.status}`);
    const sdp = await resp.text();
    console.log('WebRTC proxy: relayed SDP exchange for', req.params.streamName);
    res.set('Content-Type', 'application/sdp');
    res.send(sdp);
  } catch (e) {
    console.error('WebRTC proxy error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// WebSocket upgrade — handles any path so ingress prefix stripping is irrelevant
httpServer.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// ── HA API helpers ────────────────────────────────────────────────────────────

function haFetch(urlPath, opts = {}) {
  return fetch(`${HA_API}${urlPath}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${HA_TOKEN}`,
      ...opts.headers,
    },
  });
}

async function callHaService(domain, service, data) {
  try {
    const resp = await haFetch(`/services/${domain}/${service}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return resp.ok;
  } catch (e) {
    console.error(`Service call ${domain}.${service} failed:`, e.message);
    return false;
  }
}

// ── HA WebSocket connection ───────────────────────────────────────────────────

let haWs = null;
let haMsgId = 1;
const haPending = new Map(); // id → { resolve, reject, timer }
let haWebRtcSupported = false;

function connectToHA() {
  console.log('Connecting to HA WebSocket...');
  haWs = new WebSocket(HA_WS_URL);

  haWs.on('open', () => console.log('HA WebSocket connected'));

  haWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'auth_required':
        haWs.send(JSON.stringify({ type: 'auth', access_token: HA_TOKEN }));
        break;

      case 'auth_ok':
        console.log('Authenticated with HA — subscribing to events');
        haSubscribeEvents();
        break;

      case 'auth_invalid':
        console.error('HA authentication failed. Check SUPERVISOR_TOKEN.');
        break;

      case 'result':
        if (haPending.has(msg.id)) {
          const { resolve, reject, timer } = haPending.get(msg.id);
          clearTimeout(timer);
          haPending.delete(msg.id);
          if (msg.success) resolve(msg.result);
          else reject(new Error(msg.error?.message || 'HA error'));
        }
        break;

      case 'event':
        if (msg.event?.event_type === 'state_changed') {
          handleStateChanged(msg.event.data);
        } else if (msg.event?.event_type === 'mobile_app_notification_action') {
          handleNotificationAction(msg.event.data);
        }
        break;
    }
  });

  haWs.on('close', () => {
    console.log('HA WebSocket closed — reconnecting in 5s');
    for (const { reject, timer } of haPending.values()) {
      clearTimeout(timer);
      reject(new Error('HA WebSocket closed'));
    }
    haPending.clear();
    setTimeout(connectToHA, 5000);
  });

  haWs.on('error', (err) => console.error('HA WebSocket error:', err.message));
}

// Send a message to HA and return a Promise for the result
function haSend(payload) {
  return new Promise((resolve, reject) => {
    const id = haMsgId++;
    const timer = setTimeout(() => {
      haPending.delete(id);
      reject(new Error('HA request timed out'));
    }, 10000);
    haPending.set(id, { resolve, reject, timer });
    haWs.send(JSON.stringify({ ...payload, id }));
  });
}

function haSubscribeEvents() {
  haWs.send(JSON.stringify({
    id: haMsgId++,
    type: 'subscribe_events',
    event_type: 'state_changed',
  }));
  // Listen for Dismiss taps on mobile notifications
  haWs.send(JSON.stringify({
    id: haMsgId++,
    type: 'subscribe_events',
    event_type: 'mobile_app_notification_action',
  }));
}

function handleStateChanged({ entity_id, new_state, old_state }) {
  // Only trigger on rising edge (off → on)
  if (new_state?.state !== 'on' || old_state?.state === 'on') return;

  const doorbell = (cfg.doorbells || []).find(d => d.doorbell_sensor === entity_id);
  if (doorbell) {
    console.log(`[${doorbell.name}] Doorbell pressed`);
    onRing(doorbell);
  }
}

// ── Call state ────────────────────────────────────────────────────────────────

const ringTimers  = new Map(); // name → timeout id
const activeRings = new Map(); // name → { ringMsg, dismissAction }

function onRing(doorbell) {
  // Reset any existing ring timer for this doorbell
  if (ringTimers.has(doorbell.name)) clearTimeout(ringTimers.get(doorbell.name));

  const dismissAction = `dismiss_${doorbell.name.replace(/\W+/g, '_')}`;
  const ringMsg = {
    type: 'doorbell_ring',
    doorbell: doorbell.name,
    camera_entity: doorbell.camera_entity,
    go2rtc_stream: doorbell.go2rtc_stream || null,
    speaker_entity: doorbell.speaker_entity || null,
  };

  activeRings.set(doorbell.name, { ringMsg, dismissAction });
  broadcast(ringMsg);
  sendHaNotification(doorbell, dismissAction);

  const timeoutMs = (cfg.ring_timeout || 60) * 1000;
  ringTimers.set(doorbell.name, setTimeout(() => {
    ringTimers.delete(doorbell.name);
    activeRings.delete(doorbell.name);
    broadcast({ type: 'doorbell_timeout', doorbell: doorbell.name });
  }, timeoutMs));
}

function clearRingTimer(doorbellName) {
  if (ringTimers.has(doorbellName)) {
    clearTimeout(ringTimers.get(doorbellName));
    ringTimers.delete(doorbellName);
    activeRings.delete(doorbellName);
  }
}

// Send a Home Assistant mobile push notification with snapshot + action buttons
async function sendHaNotification(doorbell, dismissAction) {
  if (!cfg.notify_target) return;
  const dotIdx = cfg.notify_target.indexOf('.');
  const domain  = dotIdx >= 0 ? cfg.notify_target.slice(0, dotIdx) : 'notify';
  const service = dotIdx >= 0 ? cfg.notify_target.slice(dotIdx + 1) : cfg.notify_target;

  const data = {
    title: `\uD83D\uDD14 ${doorbell.name}`,
    message: 'Someone is at the door',
    data: {
      actions: [
        {
          action: 'URI',
          title: 'Answer',
          // Opens the HA companion app directly to this add-on's ingress panel
          uri: 'homeassistant://navigate/hassio/ingress/doorbell_intercom',
        },
        {
          action: dismissAction,
          title: 'Dismiss',
        },
      ],
    },
  };

  // Attach camera snapshot — companion apps use entity_id to fetch the image
  if (doorbell.camera_entity) {
    data.data.entity_id = doorbell.camera_entity;
  }

  try {
    await callHaService(domain, service, data);
    console.log(`[NOTIFY] Sent HA notification via ${cfg.notify_target}`);
  } catch (e) {
    console.error('[NOTIFY] Failed to send HA notification:', e.message);
  }
}

// Handle mobile notification action events (Dismiss button from phone)
function handleNotificationAction(data) {
  const action = data?.action || '';
  for (const [name, { dismissAction }] of activeRings) {
    if (dismissAction === action) {
      console.log(`[NOTIFY] Mobile dismissed ring for "${name}"`);
      clearRingTimer(name);
      broadcast({ type: 'doorbell_timeout', doorbell: name });
      return;
    }
  }
}

// ── Browser WebSocket clients ─────────────────────────────────────────────────

const clients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);

  // Send current config snapshot on connect, including any currently active rings
  // so clients opened after a ring event (e.g. after tapping a notification) can
  // immediately show the ringing screen.
  const active_rings = Array.from(activeRings.values()).map(({ ringMsg }) => ringMsg);
  ws.send(JSON.stringify({
    type: 'hello',
    doorbells: (cfg.doorbells || []).map(d => d.name),
    active_rings,
  }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── WebRTC signaling relay: browser ↔ HA ──────────────────────────────
      case 'webrtc_offer': {
        if (!haWebRtcSupported) {
          ws.send(JSON.stringify({
            type: 'webrtc_error',
            error: 'HA WebRTC unsupported',
            session_id: msg.session_id,
          }));
          break;
        }
        try {
          const result = await haSend({
            type: 'camera/web_rtc_offer',
            entity_id: msg.entity_id,
            offer: msg.offer,
          });
          ws.send(JSON.stringify({
            type: 'webrtc_answer',
            answer: result.answer,
            candidates: result.candidates || [],
            session_id: msg.session_id,
          }));
        } catch (e) {
          if (/Unknown command/i.test(e.message || '')) {
            haWebRtcSupported = false;
            console.warn('HA WebRTC commands not supported on this HA version; using MJPEG fallback only.');
          }
          console.error('WebRTC relay failed:', e.message);
          ws.send(JSON.stringify({
            type: 'webrtc_error',
            error: e.message,
            session_id: msg.session_id,
          }));
        }
        break;
      }

      // Trickle ICE candidate relay
      case 'webrtc_candidate': {
        if (!haWebRtcSupported) break;
        try {
          await haSend({
            type: 'camera/web_rtc_candidate',
            entity_id: msg.entity_id,
            session_id: msg.session_id,
            candidate: msg.candidate,
          });
        } catch { /* non-fatal */ }
        break;
      }

      // ── Call lifecycle ─────────────────────────────────────────────────────
      case 'call_answered': {
        clearRingTimer(msg.doorbell);
        broadcast({ type: 'call_answered', doorbell: msg.doorbell });
        break;
      }

      case 'call_ended': {
        clearRingTimer(msg.doorbell);
        broadcast({ type: 'call_ended', doorbell: msg.doorbell });
        break;
      }

      // ── Speak through speaker entity (TTS fallback) ────────────────────────
      case 'speak': {
        if (msg.speaker_entity && msg.message) {
          await callHaService('tts', 'speak', {
            entity_id: 'tts.piper',
            media_player_entity_id: msg.speaker_entity,
            message: msg.message,
          });
        }
        break;
      }
    }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', (err) => console.error('Browser WS error:', err.message));
});

// ── Start ─────────────────────────────────────────────────────────────────────

connectToHA();

httpServer.listen(PORT, '0.0.0.0', () => {
  const names = (cfg.doorbells || []).map(d => d.name).join(', ') || 'none configured';
  console.log(`Doorbell Intercom listening on port ${PORT}`);
  console.log(`Doorbells: ${names}`);
});
