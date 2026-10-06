# Air8000A build

On Windows, copy `air8000/config.example.lua` to an ignored `air8000/config.lua`,
fill only per-device values, and run `powershell -File air8000/tools/package.ps1`.
On macOS/Linux use `sh air8000/tools/package.sh`. Open the resulting project in
LuatTools and select the Air8000A firmware family 113 target. Do not commit the
private configuration or production secrets.

## Stock firmware voice path

The preferred path does not require an external C SDK or a custom ROM. Select
`voice_mode = "compatible"` for the stock `exsip` SIP/UDP bridge: carrier early
media is carried as PCMU at 8 kHz, mono, 20 ms. Select `voice_mode =
"wideband"` for stock `cc.record`/`cc.extern_source`/`cc.input` direct PCM;
the active 8/16 kHz rate is reported by `cc.quality()` and begins only after
the cellular call connects. The Lua application checks these APIs at startup
and reports the selected mode and fallback instead of silently pretending that
a missing native capability exists.
