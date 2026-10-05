# AirSIM Air8000A backend

This directory is the preferred AirSIM hardware backend for Air8000A running
LuatOS. The Samsung/AVF implementation remains available as the `legacy_android`
backend. Air8000A does not require Android Telecom, Shizuku, or AVF.

The application uses the LuatOS APIs present in the checked-in Air8000 demos:
`cc`, `sms`, `mobile`, `wlan`, `websocket`, `fskv`, `libgnss`/`exgnss`, and the
LuatOS FOTA API. Hardware capabilities are probed at runtime; firmware version
113 alone is never treated as proof of an API.

## Build and run

Edit `config.lua` from the placeholders, provision a device-specific secret,
then package the directory with LuatTools or `tools/package.ps1`. Keep real
credentials out of Git. Run the host-side tests with `lua tests/run.lua` and the protocol
simulator with `node ../tools/air8000-simulator/index.mjs`.

The `*.lua` files at this directory's top level such as
`system.capability.lua` are LuatTools flat-module compatibility entries. Keep
them in the bundle; LuatTools' merge step does not reliably resolve dotted
module names from nested folders.

Direct PCM and VoLTE require an Air8000A, compatible carrier/SIM, firmware,
audio path and antenna. The repository tests only exercise bounded in-memory
logic and mocks; they do not prove carrier or hardware behavior.


## Real carrier early media

When the installed Air8000 firmware exposes `cc.AUDIO_MODE_BRIDGE_PCM`,
`cc.bridgePcmStats()`, `cc.bridgeAudioStop()`, and the VoIP bridge API,
`media_backend = "auto"` selects `carrier_rtp` before the first
`cc.init()`. This is required because the CC audio backend is fixed after a
successful initialization until reboot.

The carrier backend intentionally does **not** call `cc.bridgeTone()` and the
web UI does not synthesize a ringback tone. Audio heard before answer therefore
comes from the cellular network/CC PCM path: carrier early media, CRBT/caller
tunes, announcements, congestion/busy audio, or other real network media.

The native CC bridge is connected to `voip.AUDIO_MODE_BRIDGE` using PCMU,
8 kHz, mono, 20 ms RTP. The VPS/LAN gateway converts that RTP to S16LE PCM for
the authenticated browser media WebSocket and converts browser microphone PCM
back to PCMU RTP. Cellular 16 kHz calls are resampled by the native bridge to
the 8 kHz RTP side, matching the current AirSIM iPhone/debug-web PCM path.

If the firmware does not expose the pure PCM bridge, auto mode falls back to
the post-answer `direct_pcm` backend. That fallback cannot claim real
pre-answer carrier media.
