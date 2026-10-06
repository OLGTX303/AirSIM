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


## Stock firmware voice modes

The device selects one mode before a call and never switches media backends
mid-call:

- `voice_mode = "compatible"` uses the stock `exsip` SIP bridge with PCMU,
  mono, 8 kHz, 20 ms. It preserves real carrier early media and uses the
  gateway's SIP/UDP endpoint.
- `voice_mode = "wideband"` uses stock `direct_pcm` after the call connects,
  with the rate reported by `cc.quality()` (8 kHz or 16 kHz). The browser
  supplies local ringback until the carrier connects; this mode cannot claim
  real pre-answer carrier media.

The old `carrier_rtp` setting is retained only for compatibility with old
configuration files. The selector never chooses it on the normal stock
firmware path. If SIP credentials are unavailable, compatible mode falls back
to direct PCM and reports that fallback in device status.
