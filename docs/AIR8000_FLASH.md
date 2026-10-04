# Air8000A flashing

Install LuatTools, connect the Air8000A by its supported USB download path,
and open the `air8000/` bundle whose root contains `main.lua`, `config.lua`,
and `BIN/`. Do not open the repository's `LuatOS/` directory or the old
`LuatOS/module/Air8000/...` path. Review the device configuration before
flashing and confirm boot logs show capability results. This process requires
physical hardware and is not covered by host tests.

The firmware may print a pin-file warning when no board-specific pin map is
installed. Do not add an empty `pins_air8000a.json`: the firmware reports
`json without pins item` for that file. No GPIO mapping is invented here
because the exact Air8000 carrier-board pin map is not present in the project.
