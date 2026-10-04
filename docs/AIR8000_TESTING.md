# Air8000A testing

Run `lua air8000/tests/run.lua` for pure Lua state/protocol tests and
`node tools/air8000-simulator/index.mjs --test` for the hardware-free device
simulation. Relay tests remain `cd push-relay-worker; npm test; npm run check`.

## Direct PCM acceptance

For Air8000A firmware 113 / LuatOS V2052, a healthy direct-PCM call should show:

1. `airsim.call cc_init true`.
2. `CC_IND AUDIO_START`, or `SPEECH_START` as a fallback trigger.
3. `airsim.media external_pcm_ready <downlink-rate> 16000`.
4. Repeating `airsim.media downlink` counters while the remote party speaks.
5. Repeating `airsim.media uplink` counters while browser/iPhone microphone audio is sent.
6. No repeating `cc extern source is not start` errors.

The Air8000 recording rate follows the negotiated cellular call (8 kHz or
16 kHz). The raw external uplink stream follows OpenLuat's Air8000 V2052
reference path at 16 kHz, S16LE mono. The gateway therefore advertises separate
`downlink_sample_rate` and `uplink_sample_rate` values.

The CC recorder has four buffers in this exact order:

`upload1, upload2, download1, download2`

In the record callback, `is_dl=true` selects the download pair and
`point=0/1` selects the active buffer. Each filled zbuff is copied and cleared
immediately so the modem can continue filling the double buffer.

## Debug cloud/LAN web verification

Open the Calls page and start the browser voice bridge before or while placing
the call. The PCM diagnostics card exposes:

- Remote party -> browser frames/bytes.
- Browser mic -> Air8000 frames/bytes.
- PCM downlink/uplink sample rates.
- Downlink frames dropped before a browser media peer was connected.

During a real conversation both byte counters must continuously increase.
If Air8000 logs show downlink bytes increasing but the browser counter remains
zero, inspect the device WebSocket binary path. If the browser downlink counter
increases but no sound is heard, inspect WebAudio playback/sample-rate handling.

## Physical acceptance

Physical acceptance still requires an Air8000A, SIM/carrier VoLTE, GNSS antenna,
real iPhone/Watch, APNs credentials and the deployer's Cloudflare resources.
The host tests cannot prove carrier voice audio, RF behavior, or microphone /
speaker hardware behavior.
