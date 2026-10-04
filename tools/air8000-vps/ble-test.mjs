import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const script = fileURLToPath(new URL("./ble-test.py", import.meta.url));
const command = process.env.AIRSIM_PYTHON || (process.platform === "win32" ? "py" : "python3");
const args = process.platform === "win32" && !process.env.AIRSIM_PYTHON
  ? ["-3", script, ...process.argv.slice(2)]
  : [script, ...process.argv.slice(2)];
const child = spawn(command, args, { stdio: "inherit", cwd: path.dirname(script) });
child.on("error", error => { console.error(`Could not start Python (${command}): ${error.message}`); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
