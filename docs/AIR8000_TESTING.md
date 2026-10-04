# Air8000A testing

Run `lua air8000/tests/run.lua` for pure Lua state/protocol tests and
`node tools/air8000-simulator/index.mjs --test` for the hardware-free device
simulation. Relay tests remain `cd push-relay-worker; npm test; npm run check`.

Physical acceptance still requires an Air8000A, SIM/carrier VoLTE, GNSS antenna,
real iPhone/Watch, APNs credentials and the deployer's Cloudflare resources.
