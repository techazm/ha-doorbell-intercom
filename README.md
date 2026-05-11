# Doorbell Intercom — Home Assistant Add-on

A universal video intercom add-on for Home Assistant. Works with **any HA-connected doorbell** — Reolink, Frigate, UniFi Protect, or any camera entity.

## Features

- Live video with automatic fallback between WebRTC, go2rtc HTTP streaming, and snapshots
- Two-way audio when the selected WebRTC path and camera/go2rtc backchannel support it
- Instant ring notification with camera snapshot
- Works on any device with a browser (phone, tablet, desktop)
- Appears as a sidebar panel in HA
- Browser push notifications when in background tab
- Optional lock action in mobile notifications
- Optional speaker target for TTS-based follow-up actions
- Browser clients only receive configured doorbells and stream identifiers, not the raw internal go2rtc URL

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
notify_target: "notify.mobile_app_pixel"        # optional: HA notify service for push notifications
panel_url: ""                                   # optional: override notification deep-link target
```

### Finding your doorbell sensor entity

Go to **Developer Tools > States** and search for your doorbell name. Look for:
- `binary_sensor.<name>_visitor` — Reolink native integration
- `binary_sensor.<name>_doorbell` — some other integrations

---

## Video & Audio modes

The client chooses the first working mode in this order:

1. **go2rtc WebRTC**
      - Used when both `go2rtc_url` and `go2rtc_stream` are configured.
      - Lowest latency and the best path for two-way audio.

2. **Home Assistant native WebRTC**
      - Used when `camera_entity` is configured and HA supports `camera/web_rtc_offer`.
      - Good compatibility, especially when HA already fronts the camera via its own go2rtc.

3. **go2rtc HTTP streaming fallback**
      - Used when WebRTC fails and `go2rtc_stream` is configured.
      - Tries the generic `/api/stream` endpoint first, then falls back to MJPEG.
      - Audio in this mode depends on go2rtc exposing audio for HTTP/browser playback.

4. **Snapshot fallback**
      - Used when no streaming path works but `camera_entity` is available.
      - Universal compatibility, video snapshots only.

---

## go2rtc stream config for Reolink (for Mode 2)

In your go2rtc add-on config or `/config/go2rtc.yaml`:

```yaml
streams:
  front_door:
            - reolink://USERNAME:PASSWORD@CAMERA_HOST
```

The `reolink://` source enables the two-way audio backchannel.

If your source stream already has audio but browser playback is silent on HTTP fallback,
check the generic go2rtc stream first. Some go2rtc builds expose audio only on the generic
`/api/stream?src=...` endpoint and not on specific `stream.mp4`/`stream.webm` endpoints.

For cameras that require audio re-encoding in go2rtc, you may need to force AAC output in
your go2rtc/Frigate configuration.

## Security notes

- Proxy routes are restricted to `camera_entity` and `go2rtc_stream` values explicitly configured in the add-on.
- The browser UI is not given the Home Assistant supervisor token or the internal `go2rtc_url`.
- TLS certificates for the optional HTTPS mic port are generated at container startup and are not baked into the image.

## Notification options

- `notify_target`: Home Assistant notify service used for push notifications.
- `panel_url`: Optional override for the URL/deep link opened by the mobile notification.
- `lock_entity`: Optional per-doorbell lock entity used by the Unlock action.
- `speaker_entity`: Optional per-doorbell media player entity for TTS-based actions.

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
