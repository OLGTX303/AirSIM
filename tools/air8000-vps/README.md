# AirSIM Air8000 VPS gateway

This is a self-hosted Windows/Linux-Docker deployment for a real Air8000A.
Caddy terminates HTTPS/WSS and the gateway accepts the device's outbound
`/device` WebSocket. The browser API is protected by `ADMIN_TOKEN`. Devices
can use mTLS after one-time enrollment; the older per-device secret remains
available for compatibility.

## Deploy on Ubuntu VPS

```sh
cd tools/air8000-vps
cp .env.example .env
nano .env
./deploy.sh
```

Use these DNS names:

```text
dashboard.example.com  -> Cloudflare proxied is allowed
device.example.com     -> DNS-only, points directly to the VPS
enroll.example.com     -> DNS-only, points directly to the VPS
```

Set the Air8000 device transport to `wss://device.example.com/device`. The
enrollment client first sends a CSR to `https://enroll.example.com/api/enroll`
with the one-time enrollment token, then stores the returned client
certificate, private key, and CA certificate in protected device storage.
Do not put any private key or enrollment token in Git or in chat.

Open `https://dashboard.example.com/api/health` with the admin bearer token to
verify the gateway.

## Use a Cloudflare-proxied domain

The dashboard hostname can use an orange-cloud DNS record and WebSocket proxying:

1. Create an `A` record such as `dashboard.example.com` pointing to the VPS IPv4 address.
2. Set the record to **Proxied** in Cloudflare DNS.
3. In Cloudflare SSL/TLS, choose **Full (strict)**.
4. Allow inbound TCP ports `80` and `443` on the VPS firewall.
5. Create separate `device.example.com` and `enroll.example.com` records as **DNS-only**.
6. Set all three names in `.env`, then run the deploy script.

Caddy terminates HTTPS on the VPS, verifies device certificates on the
DNS-only device hostname, and handles the WebSocket upgrade. Do not use
Flexible SSL. If Caddy cannot obtain its dashboard certificate while the
record is proxied, temporarily switch that dashboard record to DNS-only until
the first certificate is issued, then switch it back to Proxied.

## iOS app cloud Relay

The gateway also serves the AirSIM iOS app's cloud Relay protocol (the same
`/v1` API as `push-relay-worker`), so the iPhone can call, answer and send SMS
through this VPS when it is away from the Air8000's Wi-Fi. `ios-api.mjs`
implements it and drives the Air8000 through the gateway's own admin API, just
like the dashboard, so the SIP bridge and direct PCM voice paths are reused.

Set these in `.env`, then redeploy:

| Variable | Value |
|---|---|
| `IOS_ACCESS_TOKEN` | 32+ random URL-safe characters. Gates the whole iOS API. |
| `IOS_PUBLIC_URL` | `https://<DOMAIN>` (must be HTTPS; the app rejects HTTP). |
| `ALLOWED_BUNDLE_ID` | Your own main app Bundle ID. |
| `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_P8` | Your APNs auth key. `APNS_P8` is the `.p8` PEM on one line with literal `\n`. |
| `IOS_AIR8000_DEVICE_ID` | Optional. Defaults to the connected Air8000. |

In the iOS app, open **Settings → Cloud Relay** and save:

```text
https://<DOMAIN>/ios/<IOS_ACCESS_TOKEN>
```

The app registers its own device ID and secret on first use (trust on first
use). Only someone who knows the access token can reach the API, so treat the
whole Relay URL as a secret. Registrations (secret hashes and APNs tokens) are
stored in `/data/ios-state.json`; commands and calls are in memory.

What works:

- `GET healthz`, `POST v1/devices/register`, `v1/devices/status`,
  `v1/commands/enqueue` and `v1/commands/result` (dial, SMS, DTMF), and
  `v1/calls/<uuid>/actions` (answer, reject, end) with result polling.
- Incoming call → VoIP push to the iPhone (and Watch token if registered).
  If the caller hangs up first, a background push stops CallKit ringing.
- Incoming SMS → alert push.
- Call audio over `wss://<DOMAIN>/ios/<token>/v1/calls/<uuid>/connect`
  (PCM16 LE, 8 kHz, 20 ms), bridged to the gateway `/media` leg.

Limits: one Air8000 and one call at a time; Live Activity tokens are accepted
but no Live Activity pushes are sent; the 16 kHz wideband direct-PCM mode and
legacy `carrier_rtp` do not match the app's 8 kHz audio. Debug builds use the
APNs sandbox and TestFlight/App Store builds use production; the app reports
which one when it registers.

## Enrollment request from Windows

Generate a device key and CSR without sending the private key anywhere:

```powershell
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out device.key
openssl req -new -key device.key -out device.csr -subj "/CN=air8000-device-1"
```

Send only `device.csr`, the device serial number, IMEI, and the one-time
enrollment token to `/api/enroll`. The response contains `certificate` and
`ca_certificate`; store those with `device.key`. The gateway then requires
that certificate for the device WebSocket and matches its certificate CN to
the `device_id` in the registration message.

The included helper performs this provisioning on Windows:

```powershell
.\enroll.ps1 -EnrollUrl https://enroll.example.com `
  -DeviceId air8000-device-1 -SerialNumber YOUR_SN -Imei YOUR_IMEI
```

The current LuatOS WebSocket wrapper still needs the Air8000 firmware-specific
TLS client-certificate option wired to these files before a flashed device can
use mTLS. The LuatOS repository demonstrates mutual TLS for MQTT, but its
WebSocket client signature must be confirmed on the target firmware rather
than guessed.

## Deploy on Windows first

Install Docker Desktop, copy `.env.example` to `.env`, edit it, then run:

```powershell
.\deploy.ps1
```

This runs locally on Windows for connection testing. It does not create a fake
device connection: the dashboard reports only Air8000 devices that actually
complete the authenticated WSS registration. The Air8000 firmware must have
its WSS transport enabled and pointed at the gateway.

## Fast LAN test before cloud deployment

For a first hardware test, do not use Cloudflare or mTLS. Put the PC and
Air8000 on the same LAN, then run:

```powershell
.\lan-start.ps1
```

Open the printed dashboard URL and set the device transport to:

```text
ws://WINDOWS_PC_LAN_IP:8081/device
```

In `air8000/config.lua`, set the same LAN address before flashing:

```lua
relay_url = "ws://192.168.1.50:8081/device"
```

For LAN mode, keep `device_secret` equal to the secret entered into
`lan-start.ps1`. The device backend now uses the real LuatOS WebSocket client,
registers with its SN/IMEI, and handles the dashboard's call, SMS, GPS, and
Wi-Fi test commands.

This mode still requires the real Air8000 to register with its device ID and
secret. The dashboard can issue GPS, call, SMS, and Wi-Fi test commands. It is
not a simulator and it is not a production deployment. Stop it with
`Ctrl+C`; after LAN acceptance, switch the transport to the DNS-only mTLS
hostname and use the normal Docker deployment.

During a connected call, the Calls tab can open the authenticated browser
microphone/speaker bridge. Air8000 `cc.quality()` selects the real call rate:
quality `2` uses 16 kHz PCM for wideband/VoLTE calls; quality `1` uses 8 kHz
PCM when the carrier or modem negotiates narrowband. The portal does not claim
16 kHz when the carrier has not actually negotiated it.

### Stock CC-SIP bridge on the LAN

The gateway includes a minimal UDP SIP registrar/UAS for the Air8000 stock
`exsip` bridge. LAN mode listens on UDP 5060, accepts device `REGISTER`
requests, sends a PCMU/8000 SDP `INVITE` when the portal dials, and handles
`183`, `200`, `ACK`, `CANCEL`, and `BYE`. The existing RTP socket then carries
the Air8000-to-browser audio path.

Keep UDP 5060 and the RTP range private to the LAN during testing. Cloudflare
HTTP proxying does not proxy these UDP ports. The device must use
`media_backend = "sip_bridge"`, set `sip.enabled = true`, and point
`sip_server_addr` at the Windows/VPS LAN address. The SIP username must match
the registered Air8000 `device_id`; keep SIP passwords out of Git and chat.

For BLE Wi-Fi setup followed by automatic LAN enrollment, keep the generated
`enrollment_token` in the private `air8000/config.lua`. The current
`lan-start.ps1` is non-interactive: it reads the device ID and enrollment token
from that file, generates and persists a local dashboard token in
`.lan-secrets.json`, starts the gateway, and opens the dashboard already
authenticated. After BLE Wi-Fi provisioning completes, the device registers
automatically using its device ID, SN, and IMEI. LAN mode still requires the
private enrollment token; it does not accept unknown devices anonymously.

Run the complete local flow with:

```powershell
.\lan-start.ps1
```

The only device-side action is provisioning Wi-Fi over the Air8000 BLE service.
The enrollment token already present in the device configuration performs the
automatic account/device binding on the first successful WebSocket connection.
The generated `.lan-secrets.json` is local-only and is excluded from Git.

Production notes: use a real DNS record for `DOMAIN`, expose TCP 80/443, and
keep `.env` private. This VPS gateway is separate from the existing Cloudflare
Worker Relay; configure the Air8000 transport intentionally before switching
devices to it. Cloudflare proxying protects the public web/WSS endpoint, but
the per-device secret is still required for device registration.

### Direct BLE diagnostic

The web portal can hide whether the failure is Windows discovery, GATT, or the
Air8000 Wi-Fi scan. Run the direct real-device test from this directory:

```powershell
py -3 -m pip install bleak
npm run ble:test
```

The test scans for the `A8-` device, verifies the AirSIM GATT service, reads
the serial/IMEI identity, subscribes to status and Wi-Fi notifications, sends
the real scan request, and reports whether GATT disconnected. It does not send
Wi-Fi credentials or enrollment tokens.


## Real carrier early media over RTP

Firmware that reports the Air8000 CC pure-PCM bridge uses a direct UDP RTP
media leg in addition to the device WSS control channel. The gateway allocates
one UDP port per Air8000 from the default range `41000-41063`, sends that
endpoint to the module as `media.rtp_config`, decodes incoming PCMU RTP at its
native 8 kHz rate, resamples it to 16 kHz S16LE PCM for the browser, and
resamples browser microphone PCM back to 8 kHz before encoding PCMU RTP. The
SIP/RTP leg remains PCMU/8000 for compatibility; the browser media leg is
PCM16/16000.

Set the public/LAN IPv4 that the Air8000 can reach:

```env
RTP_PUBLIC_HOST=203.0.113.10
RTP_PORT_BASE=41000
RTP_PORT_COUNT=64
```

Allow inbound **UDP 41000-41063** on the host/VPS firewall. Docker Compose
publishes that range. If the range is changed, update the Compose UDP port
mapping to the same range.

Cloudflare HTTP/WebSocket proxying does not proxy this RTP UDP leg. The
dashboard may remain Cloudflare-proxied, but `RTP_PUBLIC_HOST` must resolve
to/refer to a directly reachable VPS/LAN address. Device WSS can still use the
DNS-only device hostname described above.

### Voice clarity pipeline

Both directions are paced by one monotonic media clock per device. Each
gateway timer tick sends every 20 ms frame that is due, so late Node/Windows
timers cannot slow the stream below 50 packets/s. Downlink RTP goes through a
jitter buffer: 200 ms warm-up, latency capped at 360 ms, loss concealment of
one silent frame per missing packet, and resync on a new SSRC or sequence jump
(for example after a device VoIP restart). The 8 <-> 16 kHz conversion uses
streaming 63-tap low-pass filters, so 20 ms frame boundaries are seamless and
16 -> 8 kHz decimation does not alias. Uplink is primed with 60 ms of audio
before speech is sent and fills underruns with PCMU silence to keep RTP timing
continuous. The browser's microphone decimator and speaker interpolator also
carry state across audio blocks.

The dashboard's audio-recovery line reports `DL latency trims`,
`UL underruns`, and `RTP resyncs`. Rising values point to network jitter or
loss rather than codec distortion.

The Air8000 suppresses ringback (`cc.bridgeTone`) whenever the cellular leg is
already `CONNECTED`, including when the gateway re-attaches SIP media to a
live call after a browser reconnect.

### Air8000 base firmware 113 audio notes

`LuatOS-SoC_V2052_Air8000_113` is built from LuatOS `7587d4f110`. Two of its
CC<->SIP bridge behaviours affect smoothness:

- **Remote party -> SIP:** when CC call recording is off, the CC audio
  callback drains at most two 20 ms frames into RTP and then calls
  `luat_fifo_delete_all(play_save_fifo)`. It loses the whole block when the
  drain timer holds the lock, so the remote voice jumps. The Air8000 app turns
  on `cc.record()` in SIP-bridge mode (`media/ccguard.lua`); the
  bridge then leaves that FIFO to the 20 ms drain timer, which never deletes
  audio. Check the boot log for `airsim.media cc_downlink_guard true`.
- **SIP -> cellular:** RTP goes into a 200 ms arrival-order ring with no
  prebuffer, and a 20 ms timer zero-fills it when empty. The ring is flushed
  when the call connects. The gateway sends a 60 ms silence cushion on
  `call.audio_start` and when browser audio (re)starts, shown as
  `device cushion` in the dashboard.

No ringback oscillator or generated audio is used. Before answer, the browser
hears audio only when the cellular network supplies real early media. This
preserves CRBT/caller tunes and network announcements exactly instead of
replacing them with a fake beep.
