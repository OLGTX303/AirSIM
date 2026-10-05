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


## Real pre-answer carrier-media acceptance

This test is separate from the legacy direct-PCM test.

1. Run `air8000/tools/hardware_selftest.lua`. `Carrier RTP PCM` and
   `Real early media` must both report `PASS`.
2. Start the LAN/VPS gateway with a UDP address reachable by the Air8000. In
   production set `RTP_PUBLIC_HOST`; the default UDP range is 41000-41063.
3. Open the Calls page. The device must report `media_backend=carrier_rtp`
   and the portal must show `Carrier media: REAL network early media`.
4. Press Call. The browser media WebSocket is established before the dial
   command so the RTP bridge is armed before `cc.dial()`.
5. Before the remote party answers, verify the gateway logs RTP reception and
   the `Remote party -> browser` counter increases whenever the carrier sends
   early media. A CRBT/caller tune or carrier announcement must be heard
   exactly as supplied by the network.
6. After answer, the same path must continue with the remote party voice.
   Browser microphone audio must increment the uplink/RTP TX counters and be
   audible to the remote party.
7. Hang up and place a second call. The RTP source tuple/session must be learned
   again and old RTP must not enter the new call.

There is deliberately no synthetic fallback. Some networks signal ordinary
ringing without sending an audio bearer; a normal handset locally generates
the familiar ringback in that case. AirSIM carrier-RTP mode remains silent
until genuine carrier PCM arrives, because the requirement is to reproduce
network media rather than manufacture a tone.

Expected device indicators include:

```text
airsim.media backend carrier_rtp real_early_media
airsim.carrier_rtp configured <gateway-ip> <udp-port>
airsim.carrier_rtp start <call-id> <gateway-ip> <udp-port>
airsim.carrier_rtp carrier_media_play ...
```

The old repeating `cc extern source is not start` error belongs to the
legacy direct-PCM uplink path and should not appear when `carrier_rtp` is the
selected backend.
