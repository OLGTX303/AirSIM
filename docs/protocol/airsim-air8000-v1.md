# AirSIM Air8000 protocol v1

The Air8000 device is an outbound client. It never exposes an unauthenticated
public control listener. Control messages are JSON envelopes over WSS/TLS:

```json
{"protocol_version":"airsim.air8000.v1","message_id":"42","device_id":"air8000-...","timestamp":0,"nonce":"42","type":"device.register","payload":{"device_type":"air8000a","hardware_model":"Air8000A","serial_number":"AIR8000-SN-001","imei":"123456789012345","capabilities":{}}}
```

Every device has a unique secret. Authenticated messages bind the canonical
envelope to an HMAC-SHA256 MAC, require a fresh nonce and a timestamp within
five minutes, and are limited to 64 KiB. Implementations must reject unknown
message types, duplicate messages, stale timestamps and oversized payloads.

Air8000 registration requires both `serial_number` and `imei`. The serial is
the vendor/printed serial when configured, otherwise the LuatOS MCU unique ID;
the IMEI comes from `mobile.imei()`. Both identify inventory and are not
authentication credentials. Production logs should redact the IMEI.

Call states are normalized (`IDLE`, `DIALING`, `RINGING_OUT`, `INCOMING`,
`CONNECTING`, `CONNECTED`, `DISCONNECTING`, `ENDED`, `FAILED`). A call selects
`control_transport`, `media_transport`, and `media_backend` at setup and never
silently switches during the call.

Media uses bounded binary PCM frames. The Air8000 reports `cc.quality()` before
media starts: `1` selects 8 kHz narrowband PCM and `2` selects 16 kHz
wideband/VoLTE PCM. The selected rate is announced in `media.open` and the
browser resamples its microphone and speaker path to that exact rate. PCM is
memory-only; it is never JSON encoded, logged, or stored. SMS events carry message IDs and timestamps,
but production logs must not contain the body. Location events carry explicit
fix state and nullable measurements; no accuracy is fabricated.
