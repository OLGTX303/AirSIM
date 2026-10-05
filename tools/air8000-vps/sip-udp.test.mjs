import assert from "node:assert/strict";
import { parseSip, parseSdp } from "./sip-udp.mjs";

const register = parseSip([
  "REGISTER sip:airsim.local SIP/2.0",
  "Via: SIP/2.0/UDP 192.168.1.48:5060;branch=z9hG4bK-test",
  "From: <sip:air8000-test@airsim.local>;tag=abc",
  "To: <sip:air8000-test@airsim.local>",
  "Call-ID: test@device",
  "CSeq: 1 REGISTER",
  "Contact: <sip:air8000-test@192.168.1.48:5060>",
  "Content-Length: 0", "", "",
].join("\r\n"));
assert.equal(register.method, "REGISTER");
assert.equal(register.headers["call-id"], "test@device");

const response = parseSip([
  "SIP/2.0 183 Session Progress",
  "Via: SIP/2.0/UDP 192.168.1.91:5060;branch=z9hG4bK-test",
  "From: <sip:gateway@airsim.local>;tag=gateway",
  "To: <sip:air8000-test@airsim.local>;tag=device",
  "Call-ID: test@device",
  "CSeq: 1 INVITE", "Content-Type: application/sdp", "Content-Length: 0", "", "",
].join("\r\n"));
assert.equal(response.code, 183);
assert.deepEqual(parseSdp("v=0\r\nc=IN IP4 192.168.1.48\r\nm=audio 40000 RTP/AVP 0\r\n"), { address: "192.168.1.48", port: 40000 });
const sipSource = await import("node:fs").then(fs => fs.readFileSync(new URL("./sip-udp.mjs", import.meta.url), "utf8"));
assert.match(sipSource,/async resume\(device, session\)/);
assert.match(sipSource,/X-AirSIM-Resume/);
assert.match(sipSource,/this\.forget\(device\.device_id\)/);

console.log("Air8000 SIP UDP tests passed");
