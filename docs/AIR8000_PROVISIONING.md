# Air8000A provisioning

Provision a unique device ID, unique secret, serial number when a vendor label
exists, Relay WSS endpoint, Wi-Fi policy,
media backend and location policy through an authenticated temporary setup
channel. Persist them with `fskv`, close setup mode, then verify registration.
Factory reset must delete configuration and pairing state. Never use a global
manufacturing secret or print the secret in logs.

## BLE Wi-Fi setup

Air8000 advertises as `A8-<last-six-identity>` and exposes the fixed
AirSIM provisioning service
`7b9e8000-a8f0-4c4e-9a5b-4b80c8000001`. A phone must discover this service before
showing the setup screen; matching only the Bluetooth name is not sufficient.

| UUID | Purpose | Access |
| --- | --- | --- |
| `...0001` | AirSIM provisioning service | GATT service |
| `...0002` | Wi-Fi/device status JSON | read/notify |
| `...0003` | Wi-Fi scan/connect commands | write |
| `...0004` | serial number/IMEI JSON | read |
| `...0005` | scanned SSID records | notify/read |

Request a scan by writing this JSON to characteristic `...0003`:

```json
{"op":"scan","pairing_code":"123456"}
```

The device returns one notification per visible SSID on characteristic
`...0005`:

```json
{"type":"wifi_network","index":1,"total":2,"network":{"ssid":"Office-WiFi","rssi":-48,"bssid":"001122334455","security":"auto"}}
```

Then write this JSON to characteristic `...0003`:

```json
{"op":"connect","pairing_code":"123456","ssid":"2.4G-network","password":"wifi-password","security":"auto"}
```

The pairing code is configured per device in `config.lua`. The password is
never logged. After a valid write, the module calls the checked-in LuatOS
`wlan.connect(ssid, password, 1, bssid)`, persists the Wi-Fi settings
through `fskv`, and reconnects automatically after reboot. The BSSID returned
by the scan is optional but preferred, because it prevents connecting to the
wrong access point when several APs share an SSID. The checked-in Air8000
firmware API does not expose a separate WPA selector; `security:"auto"` lets
the modem negotiate WPA2-Personal or WPA2/WPA3 transition mode, while WPA3-
Personal/SAE requires a firmware build whose Wi-Fi stack supports WPA3. The
application cannot add WPA3 capability if the modem firmware lacks it.
Air8000 Wi-Fi setup is 2.4-GHz dependent on the modem firmware; 5-GHz-only
networks are not assumed.
