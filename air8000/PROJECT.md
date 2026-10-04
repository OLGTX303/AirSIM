# AirSIM Air8000A project contract

* `device_type`: `air8000a`
* `hardware_model`: `Air8000A`
* `backend`: `air8000a` (the old phone remains `legacy_android`)
* protocol version: `airsim.air8000.v1`
* control: authenticated outbound WSS/TLS; local setup is temporary and authenticated
* media: `direct_pcm` when capability-probed and configured, otherwise `sip_bridge`
* location default: `on_request`

PCM is memory-only. SMS bodies, ICCID, IMSI, secrets and tokens are never logged.
Emergency calls must use the normal carrier/system phone facility.
