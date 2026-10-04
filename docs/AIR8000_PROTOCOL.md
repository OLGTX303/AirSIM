# Air8000 protocol entry point

The machine-readable protocol notes are in
[`docs/protocol/airsim-air8000-v1.md`](protocol/airsim-air8000-v1.md). The Lua
implementation is under `air8000/protocol/`, with host tests in
`air8000/tests/run.lua`. The existing Relay and iOS contracts remain backward
compatible; new Air8000 metadata is additive.
