# AirSIM

AirSIM connects an Air8000A cellular endpoint, iPhone and Apple Watch for calls, SMS and remote control. The Air8000A backend is the active hardware path. The former Samsung Android client and audio bridge are preserved under [`legacy/android`](legacy/android) for reference only.

AirSIM is source-available software for personal learning, research and other non-commercial use. It is licensed under [PolyForm Noncommercial 1.0.0](LICENSE), not the OSI Open Source Definition. Do not use it for commercial services or emergency communications.

## What is in this repository

| Path | Role |
| --- | --- |
| [`air8000`](air8000/README.md) | LuatOS Air8000A firmware: cellular calls, SMS, GNSS, Wi-Fi, WebSocket, media and provisioning |
| [`module/module-agent`](module/module-agent/README.md) | AVF Linux device state, control API, relay and media orchestration |
| [`module/avf-installerd`](module/avf-installerd) | Signed Debian package installation, health checks and rollback |
| [`module/packaging`](module/packaging/README.md) | `arm64` Debian package, systemd units and first-install scripts |
| [`iOS`](iOS/README.md) | iPhone and Apple Watch CallKit, PushKit, VoWLAN, SMS and Live Activity client |
| [`push-relay-worker`](push-relay-worker/README.md) | Optional Cloudflare Worker relay, APNs, queues, dashboard and WebSocket media |
| [`tools/air8000-vps`](tools/air8000-vps/README.md) | Optional Air8000 LAN/VPS gateway and browser control panel |
| [`docs`](docs) | Protocol, architecture, provisioning, flashing and test notes |

## Architecture

The preferred path is:

```text
iPhone / Apple Watch
        │ authenticated LAN WebSocket or optional Relay
        ▼
Air8000A ── cellular calls, SMS, GNSS and media
```

The Air8000 protocol is versioned as `airsim.air8000.v1`. The protocol definition and test vectors are [here](docs/protocol/airsim-air8000-v1.md) and [here](docs/protocol/test-vectors.json). The `v1` name is a live protocol contract, not an obsolete backup.

## Quick start

### Air8000A

1. Copy `air8000/config.example.lua` to an ignored `air8000/config.lua` and fill in device-local values.
2. Run `powershell -File air8000/tools/package.ps1` on Windows, or `sh air8000/tools/package.sh` on macOS/Linux.
3. Open the generated bundle in LuatTools and select the Air8000A firmware family 113 target.
4. Provision Wi-Fi over BLE or use the authenticated LAN gateway.

Read [`air8000/README.md`](air8000/README.md), [`docs/AIR8000_BUILD.md`](docs/AIR8000_BUILD.md), [`docs/AIR8000_PROVISIONING.md`](docs/AIR8000_PROVISIONING.md) and [`docs/AIR8000_TESTING.md`](docs/AIR8000_TESTING.md) before connecting real hardware.

### iPhone and Apple Watch

Open `iOS/AirSIM.xcodeproj` in Xcode. Replace the placeholder `com.example.airsim` with a unique Bundle ID controlled by the deployer, then configure the Watch App, Live Activity and test targets from that identifier. Use the matching APNs sandbox or production environment; never reuse another developer's signing identity.

### Optional Relay

```sh
cd push-relay-worker
npm ci
cp wrangler.example.toml wrangler.toml
npm test
npm run check
npx wrangler deploy --dry-run --config wrangler.toml
```

Use the deployer's own Cloudflare account, KV, Durable Objects and domain. `APNS_P8` and `DASHBOARD_TOKEN` are Worker Secrets, not variables, source files or build output. A dry run is not a deployment.

## Security boundaries

- Agent, installerd and PCM listeners stay on loopback or the AVF private network.
- VoWLAN requests retain timestamp, nonce, HMAC, route allowlists and size limits.
- Call PCM is memory-only; logs must not contain PCM, complete SMS, Push tokens or secrets.
- The Agent does not self-update. Updates, repair and rollback go through the independent installerd.
- installerd accepts only signed, metadata-validated `arm64` Debian packages and does not execute arbitrary shell commands.
- Emergency calls remain the responsibility of the operating system and carrier phone service.

Never commit APNs keys, Cloudflare tokens, device secrets, Agent tokens, HMAC keys, signing keys, certificates, profiles, real phone numbers or message contents.

## Validation

Run the smallest set matching the change. For a full pre-release check:

```sh
(cd module/module-agent && go test ./...)
(cd module/avf-installerd && go test ./...)
./module/packaging/test.sh
(cd push-relay-worker && npm test && npm run check)
xcodebuild -project iOS/AirSIM.xcodeproj -scheme AirSIM \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build-for-testing
```

Automated checks do not prove carrier VoLTE, real two-way audio, APNs production delivery, Watch background behavior, target-phone compatibility or Relay production readiness. Those require the deployer's own devices, accounts, signing assets and network.

## Documentation

- [Air8000 architecture](docs/AIR8000_ARCHITECTURE.md)
- [Air8000 protocol](docs/AIR8000_PROTOCOL.md)
- [Air8000 flashing](docs/AIR8000_FLASH.md)
- [Air8000 testing](docs/AIR8000_TESTING.md)
- [VoWLAN design](docs/2026-09-11-vowlan-design.md)
- [Samsung hotspot pairing protocol](docs/samsung-hotspot-pairing-protocol.md)
- [Legacy Android snapshot](legacy/android)
- [Codex deployment guidance](codex.md)
- [General LLM project contract](LLM.txt)

## License

Keep [LICENSE](LICENSE), [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with every permitted non-commercial redistribution. Third-party components retain their own licenses.
