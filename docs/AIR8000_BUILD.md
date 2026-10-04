# Air8000A build

On Windows, copy `air8000/config.example.lua` to an ignored `air8000/config.lua`,
fill only per-device values, and run `powershell -File air8000/tools/package.ps1`.
On macOS/Linux use `sh air8000/tools/package.sh`. Open the resulting project in
LuatTools and select the Air8000A firmware family 113 target. Do not commit the
private configuration or production secrets.

## Native browser voice uplink

The browser microphone path requires a custom LuatOS ROM build. The stock
Air8000 ROM has `cc.record()` for downlink capture but does not expose a Lua
`cc.input(zbuff)` entry point for external PCM uplink. The AirSIM source tree
contains the binding in `LuatOS/components/cc/luat_lib_cc.c`; build that source
with the vendor Air8000A toolchain, flash the resulting ROM, and then package
the Lua application. The Lua gateway will use `cc.input()` only when the
flashed ROM exports it. A Lua application ZIP alone cannot add a native module
to an already-flashed ROM.

The binding accepts signed 16-bit little-endian mono PCM at the active
`cc.quality()` rate (8 kHz or 16 kHz), queues it in RAM, and calls the modem
upload API from the VoLTE task. PCM is not written to storage or logs.
