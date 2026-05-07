# Doorbell Intercom — Home Assistant Add-on

A universal video intercom add-on for Home Assistant. Works with **any HA-connected doorbell** — Reolink, Frigate, UniFi Protect, or any camera entity.

## Features

- Live video + two-way audio (WebRTC)
- Instant ring notification with camera snapshot
- Works on any device with a browser (phone, tablet, desktop)
- Appears as a sidebar panel in HA
- Browser push notifications when in background tab
- Three video modes (automatic fallback):
  1. **HA native WebRTC** — best compatibility, uses HA's built-in WebRTC relay
  2. **go2rtc WebRTC** — best performance if go2rtc is installed
  3. **MJPEG stream** — universal fallback (no two-way audio)

---

## Installation

1. In Home Assistant: **Settings > Add-ons > Add-on Store**
2. Click the three-dot menu → **Repositories**
3. Add this repository URL
4. Find **Doorbell Intercom** and install it

---

## Configuration

```yaml
doorbells:
  - name: "Front Door"
    doorbell_sensor: binary_sensor.front_door_visitor   # entity that goes 'on' when pressed
    camera_entity: camera.front_door                    # any HA camera entity
    go2rtc_stream: front_door                           # optional: go2rtc stream name
    speaker_entity: media_player.front_door             # optional: for TTS fallback

  - name: "Back Gate"
    doorbell_sensor: binary_sensor.back_gate_visitor
    camera_entity: camera.back_gate

go2rtc_url: "http://homeassistant.local:1984"   # optional: leave blank if not using go2rtc
ring_timeout: 60                                 # seconds before auto-dismiss
```

### Finding your doorbell sensor entity

Go to **Developer Tools > States** and search for your doorbell name. Look for:
- `binary_sensor.<name>_visitor` — Reolink native integration
- `binary_sensor.<name>_doorbell` — some other integrations

---

## Video & Audio modes

### Mode 1: HA native WebRTC (recommended for most setups)
- Set `camera_entity` to your camera
- Leave `go2rtc_stream` blank
- Requires the camera integration to support WebRTC (Reolink ✓, Frigate ✓, UniFi Protect ✓)
- Two-way audio works if the camera driver supports the audio backchannel

### Mode 2: go2rtc WebRTC
- Install the [go2rtc add-on](https://github.com/AlexxIT/go2rtc)
- Configure your doorbell stream in go2rtc using the `reolink://` source for Reolink cameras
- Set `go2rtc_url` and `go2rtc_stream` in this add-on's config
- Best quality and lowest latency (~0.5s)
- Full two-way audio guaranteed

### Mode 3: MJPEG fallback
- Automatic if WebRTC fails
- Video only (no two-way audio)
- Works with any HA camera entity

---

## go2rtc stream config for Reolink (for Mode 2)

In your go2rtc add-on config or `/config/go2rtc.yaml`:

```yaml
streams:
  front_door:
    - reolink://admin:YOUR_PASSWORD@192.168.1.XXX
```

The `reolink://` source enables the two-way audio backchannel.

---

## How it works

```
Doorbell pressed
      │
      ▼
HA state_changed event (binary_sensor → 'on')
      │
      ▼
Add-on server receives event via HA WebSocket API
      │
      ├─► Pushes 'doorbell_ring' to all open browser clients
      │
      ▼
Browser shows ringing UI with camera snapshot
      │
   [Answer]
      │
      ▼
Browser starts WebRTC (offer → HA relay → camera)
      │
      ▼
Live video + two-way audio
```
