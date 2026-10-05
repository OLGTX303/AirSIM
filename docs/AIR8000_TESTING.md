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


## Wi-Fi portal telemetry acceptance

1. Provision or connect the Air8000 to Wi-Fi.
2. Wait until `wlan.ready()` is true. Merely accepting `wlan.connect()` is
   not considered connected.
3. The portal Overview and Wi-Fi tabs must show:
   - state `connected`
   - actual SSID
   - non-zero IPv4 address
   - gateway
   - BSSID
   - RSSI when reported by the driver
4. Disconnect/reconnect Wi-Fi and verify the portal changes through
   associated/connected/disconnected states without requiring a page reload.
5. Keeping Web Bluetooth connected must not freeze Overview, GNSS, Calls, SMS,
   or Wi-Fi telemetry rendering.

## GNSS portal telemetry acceptance

1. Open the GNSS tab and press **Request real GNSS fix**.
2. The portal must immediately change to `searching`.
3. On Air8000 `GNSS_STATE=FIXED`, the portal must show WGS84 latitude and
   longitude plus altitude, satellites and HDOP when available.
4. `exgnss.open()` returning Lua `nil` is normal and must not be treated as
   a startup failure.
5. For a cold start, allow the full 60-second TIMERORSUC window outdoors with a
   usable GNSS antenna/view of sky.
6. On loss of fix, the portal must show `lost`; closing the receiver must not
   erase the last valid coordinates already reported.


## Smooth SIP bridge voice + wideband VoLTE acceptance

The stock Air8000 VoIP engine currently exposes PCMU/PCMA RTP at 8 kHz. Do not
label that RTP leg as 16 kHz. The cellular CC leg may independently negotiate
AMR-WB at 16 kHz; the OpenLuat CC/SIP bridge resamples 16 kHz CC PCM to the
8 kHz G.711 RTP leg.

### Ringback

For SIP bridge calls, after the 183 media path is ready AirSIM enables the
official `cc.bridgeTone(true)` bridge ringback. This is generated inside the
Air8000 CC/VoIP bridge, not in browser JavaScript. The firmware automatically
stops it when real CC downlink PCM is observed, and AirSIM also stops it at
CONNECTED/AUDIO_START or teardown.

Expected log before answer when the network supplies only ringing signalling:

```text
airsim.media bridge_ringback on sip_183_media_ready
```

When real downlink or speech begins:

```text
airsim.media bridge_ringback off audio_start
```

### RTP smoothness

The LAN/VPS gateway must:

- buffer six 20 ms downlink RTP packets before playout (about 120 ms);
- reorder RTP by sequence number;
- clock exactly one downlink PCM frame every 20 ms;
- use silence concealment for a missing 20 ms packet;
- clock exactly one uplink PCMU RTP frame every 20 ms instead of draining the
  browser microphone queue in a burst.

The portal adds another approximately 140 ms adaptive WebAudio scheduling lead
and re-buffers after an underrun.

Check these live diagnostics during a call:

- RTP jitter should normally remain well below the playout target;
- late/lost/concealment counters should increase only occasionally;
- browser underruns should remain at or close to zero;
- uplink dropped frames should remain zero during a healthy LAN call.

### 16 kHz cellular VoLTE

After AUDIO_START AirSIM calls `cc.quality()`:

- `1` -> 8 kHz AMR-NB;
- `2` -> 16 kHz AMR-WB;
- another sample-rate value -> that explicit rate.

For a real wideband call expect:

```text
airsim.media volte_quality AMR-WB 16000 audio_start
```

The portal must display **Cellular VoLTE: 16000 Hz · AMR-WB · WIDEBAND**.

If it reports 8000 Hz / AMR-NB, the modem/carrier negotiated narrowband for
that call. LuatOS does not expose a supported API to force AMR-WB; carrier,
IMS profile, radio/network conditions and the remote endpoint participate in
codec negotiation.


## Web voice parity with iOS and restart recovery

The web voice path now follows the same design principles used by the iOS
`AudioSessionController`:

- continuous queued playback instead of creating one speaker object per network packet;
- bounded playback queue with drop/underrun accounting;
- microphone echo cancellation, noise suppression and automatic gain control;
- 80 Hz high-pass and approximately 3.4 kHz low-pass conditioning for the
  current 8 kHz PCMU leg;
- automatic transport recovery for up to 45 seconds.

### Web playback acceptance

During a healthy call:

- browser underruns should stay at or near zero;
- browser queue drops should stay at zero;
- RTP lost/late/concealment counters should remain low;
- voice should continue smoothly when the main browser thread is briefly busy.

The AudioWorklet keeps an approximately 80 ms browser playout queue. The
gateway still performs RTP sequence reordering and jitter buffering before
frames reach the browser.

### Gateway restart acceptance

1. Establish a cellular call from the web and verify two-way audio.
2. Restart only `tools/air8000-vps`; do not reboot the Air8000.
3. The browser media WebSocket should close and enter automatic recovery.
4. The Air8000 relay reconnects and receives a new `server_instance_id`.
5. AirSIM restarts only the SIP service, preserving the cellular CC call.
6. The Air8000 immediately REGISTERs to the new SIP process.
7. The browser retries media tickets for up to 45 seconds.
8. The gateway sends an INVITE with `X-AirSIM-Resume: 1`.
9. The Air8000 attaches the new SIP/RTP media dialog to the existing CC call
   without placing a second cellular call.
10. Audio should resume automatically.

Expected device logs include:

```text
airsim.sip refresh_start gateway_restarted
airsim.sip refresh_done true gateway_restarted
airsim.sip resume_existing_cc CONNECTED
```

The portal **Audio recovery** card increments `server resumes` when the new
gateway creates a replacement media dialog.

### Important regression

Requesting a new browser media ticket during an existing SIP call must not
clear `session.remote`. Earlier versions reset the RTP session on every media
ticket, which could permanently mute an otherwise healthy active call.
