import assert from "node:assert/strict";
import fs from "node:fs";

const server=fs.readFileSync(new URL("./server.mjs",import.meta.url),"utf8");
const page=fs.readFileSync(new URL("./public/index.html",import.meta.url),"utf8");

assert.match(server,/setInterval\(\(\)=>flushCarrierUplink\(session\),20\)/);
assert.match(server,/setInterval\(\(\)=>playoutCarrierDownlink\(session\),20\)/);
assert.match(server,/rtp_jitter_ms/);
assert.match(server,/audio_concealment_frames/);
assert.doesNotMatch(server,/while\(session\.pendingUplink\.length>=320\)/);

assert.match(page,/targetLead:0\.08/);
assert.match(page,/minLead:0\.04/);
assert.match(page,/voice\.playUnderruns\+\+/);
assert.match(page,/createScriptProcessor\(1024,1,1\)/);
assert.match(page,/registerProcessor\('airsim-playback'/);
assert.match(page,/automatic 45 s recovery/);
assert.match(page,/media-stalled/);
assert.match(server,/SERVER_INSTANCE_ID/);
assert.match(server,/sipServer\.resume\(d,session\)/);
assert.match(server,/Do not clear session\.remote/);
assert.match(page,/Cellular VoLTE/);

console.log("Air8000 paced voice-path tests passed");
