import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { createApnsSender, createIosApi, normalizePhoneNumber } from "./ios-api.mjs";

const TOKEN = "test-access-token-1234567890";
const BUNDLE = "com.example.airsim";
const quiet = { log() {}, error() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label) => { for (let i = 0; i < 100; i++) { if (fn()) return; await wait(10); } assert.fail(`timed out: ${label}`); };

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

async function harness({ token = TOKEN } = {}) {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ios-api-")), "state.json");
  const device = { device_id: "air-1", socket: { readyState: 1 }, firmware: "fw-1", status: { gnss_state: "fix" }, location: { fix: true, fix_state: "3d", latitude: 31.2, longitude: 121.5, satellites: 7, extra: "x" } };
  const devices = new Map([["air-1", device]]);
  const sent = [], pushes = [], mediaPeers = [];
  let gw = 0;
  const mediaServer = http.createServer();
  const fakeMedia = new WebSocketServer({ server: mediaServer });
  fakeMedia.on("connection", (ws) => { const peer = { ws, frames: [] }; ws.on("message", (d) => peer.frames.push(d)); mediaPeers.push(peer); });
  const mediaPort = await listen(mediaServer);
  const gateway = {
    async command(id, type, payload) { const command_id = `gw-${++gw}`; sent.push({ id, type, payload, command_id }); return { status: 202, body: { accepted: true, command_id } }; },
    async openMedia() { return { socket: new WebSocket(`ws://127.0.0.1:${mediaPort}`), info: {} }; },
  };
  const api = createIosApi({ accessToken: token, allowedBundleId: BUNDLE, publicUrl: "https://vps.example.com", stateFile, devices, gateway, apns: async (p) => { pushes.push(p); }, log: quiet });
  const server = http.createServer((req, res) => api.handleHttp(req, res, new URL(req.url, "http://x")));
  server.on("upgrade", (req, socket, head) => api.handleUpgrade(req, socket, head, new URL(req.url, "http://x")));
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}/ios/${TOKEN}`;
  const post = async (p, body) => { const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const close = () => { server.close(); mediaServer.close(); fakeMedia.close(); };
  return { api, device, devices, sent, pushes, mediaPeers, post, base, port, stateFile, close };
}

const secret = "s".repeat(44);
const reg = { device_id: "6f1c2a3b-0000-4000-8000-000000000001", device_secret: secret, cloud_enabled: true, voip_token: "a".repeat(64), alert_token: "b".repeat(64), watch_voip_token: "", watch_bundle_id: `${BUNDLE}.watchkitapp`, live_activity_push_to_start_token: "", bundle_id: BUNDLE, environment: "sandbox", relay_url: "https://vps.example.com/ios/x", media_transport: "legacy_pcm", app_media_capabilities: ["legacy_pcm"], force_legacy_pcm: false };
const auth = { device_id: reg.device_id, device_secret: secret };

// phone number normalization mirrors the Worker
assert.equal(normalizePhoneNumber("+86 (138) 0013-8000"), "+8613800138000");
assert.equal(normalizePhoneNumber("abc"), null);

// disabled without a token; wrong path token is a 404
{
  const h = await harness({ token: "" });
  const r = await fetch(`http://127.0.0.1:${h.port}/ios/anything/healthz`);
  assert.equal(r.status, 404); h.close();
}
const h = await harness();
assert.equal((await fetch(`http://127.0.0.1:${h.port}/ios/wrong/healthz`)).status, 404);
assert.equal((await fetch(`${h.base}/healthz`)).status, 200);

// registration: bundle pin, TOFU secret, persisted without the secret
assert.equal((await h.post("/v1/devices/register", { ...reg, bundle_id: "com.other.app" })).status, 400);
assert.deepEqual(await h.post("/v1/devices/register", reg), { status: 200, body: { registered: true } });
assert.equal((await h.post("/v1/devices/register", { ...reg, device_secret: "t".repeat(44) })).status, 401);
const saved = fs.readFileSync(h.stateFile, "utf8");
assert.ok(!saved.includes(secret) && saved.includes(crypto.createHash("sha256").update(secret).digest("hex")));

// status reflects the Air8000 socket and only typed fields
assert.equal((await h.post("/v1/devices/status", { ...auth, device_secret: "wrong-secret-0000" })).status, 401);
let status = await h.post("/v1/devices/status", auth);
assert.equal(status.body.cloud_online, true);
assert.deepEqual(status.body.location, { fix: true, fix_state: "3d", latitude: 31.2, longitude: 121.5, satellites: 7 });
h.device.socket.readyState = 3;
assert.deepEqual((await h.post("/v1/devices/status", auth)).body, { cloud_online: false });
assert.equal((await h.post("/v1/commands/enqueue", { ...auth, command_id: crypto.randomUUID(), type: "dial", number: "10086" })).status, 409);
h.device.socket.readyState = 1;

// SMS command completes from the Air8000 command_result
const smsID = crypto.randomUUID();
let r = await h.post("/v1/commands/enqueue", { ...auth, command_id: smsID, type: "send_sms", number: "10086", message: " hi " });
assert.equal(r.status, 202); assert.equal(r.body.accepted, true);
assert.deepEqual(h.sent.at(-1).payload, { number: "10086", body: "hi" });
assert.equal((await h.post("/v1/commands/result", { ...auth, command_id: smsID })).body.status, "delivered");
h.api.onDeviceMessage(h.device, { type: "device.command_result", payload: { command_id: h.sent.at(-1).command_id, ok: true } });
assert.deepEqual((await h.post("/v1/commands/result", { ...auth, command_id: smsID })).body, { command_id: smsID, status: "completed", result: { sent: true, segments: 1 } });
assert.equal((await h.post("/v1/commands/enqueue", { ...auth, command_id: crypto.randomUUID(), type: "dtmf", number: "12" })).status, 400);

// dial returns a wss media URL and completes on the outgoing call.state
const dialID = crypto.randomUUID();
r = await h.post("/v1/commands/enqueue", { ...auth, command_id: dialID, type: "dial", number: "+86 138-0013-8000" });
assert.equal(r.status, 202);
assert.deepEqual(h.sent.at(-1).payload, { number: "+8613800138000" });
assert.match(r.body.call.media_url, new RegExp(`^wss://vps\\.example\\.com/ios/${TOKEN}/v1/calls/[0-9a-f-]{36}/connect$`));
assert.ok(r.body.call.call_secret.length >= 24 && /^[A-Za-z0-9_-]+$/.test(r.body.call.call_secret));
assert.equal((await h.post("/v1/commands/enqueue", { ...auth, command_id: crypto.randomUUID(), type: "dial", number: "1" })).status, 409, "one call at a time");
h.api.onDeviceMessage(h.device, { type: "call.state", payload: { call: { call_id: "gw-dial", direction: "outgoing", state: "DIALING" }, event: "dial" } });
assert.deepEqual((await h.post("/v1/commands/result", { ...auth, command_id: dialID })).body.result, { dialing: true });

// media: answer ack, both audio directions, active, hangup confirmation, remote end
const call = r.body.call;
const mediaURL = `ws://127.0.0.1:${h.port}${new URL(call.media_url).pathname}`;
await assert.rejects(new Promise((res, rej) => { const ws = new WebSocket(`${mediaURL}?role=iphone&token=wrong-token-wrong-token-xx`); ws.on("open", res); ws.on("error", rej); }));
const phone = new WebSocket(`${mediaURL}?role=iphone&token=${call.call_secret}`);
const texts = [], audio = [];
phone.on("message", (d, bin) => (bin ? audio.push(d) : texts.push(JSON.parse(d))));
await new Promise((res) => phone.on("open", res));
await until(() => h.mediaPeers.length === 1, "gateway media opened");
const ctl = { action: "answer", call_id: call.call_id, call_uuid: call.call_uuid, generation: 1, command_id: crypto.randomUUID(), trace_id: "abcd1234" };
phone.send(JSON.stringify(ctl));
await until(() => texts.some((t) => t.status === "answer_ok"), "answer_ok");
assert.equal(h.sent.filter((s) => s.type === "answer").length, 0, "outgoing calls are not re-answered on the modem");
h.mediaPeers[0].ws.send(Buffer.alloc(320, 1));
await until(() => audio.length === 1, "downlink");
phone.send(Buffer.alloc(320, 2));
await until(() => h.mediaPeers[0].frames.length === 1, "uplink");
h.api.onDeviceMessage(h.device, { type: "call.state", payload: { call: { call_id: "gw-dial", direction: "outgoing", state: "CONNECTED" }, event: "connected" } });
await until(() => texts.some((t) => t.status === "active"), "active");
const endID = crypto.randomUUID();
r = await h.post(`/v1/calls/${call.call_uuid}/actions`, { ...auth, action: "end", call_id: call.call_id, call_uuid: call.call_uuid, generation: 1, command_id: endID, trace_id: "x", owner: "iphone" });
assert.equal(r.status, 202); assert.equal(h.sent.at(-1).type, "hangup");
assert.equal((await h.post(`/v1/calls/${call.call_uuid}/actions`, { ...auth, action: "end", call_id: "other", call_uuid: call.call_uuid, generation: 1, command_id: crypto.randomUUID() })).status, 409);
h.api.onDeviceMessage(h.device, { type: "device.command_result", payload: { command_id: h.sent.at(-1).command_id, ok: true } });
const getResult = await fetch(`${h.base}/v1/calls/${call.call_uuid}/actions/${endID}`, { headers: { authorization: `Bearer ${secret}`, "x-airsim-device-id": reg.device_id } });
assert.deepEqual((await getResult.json()).result, { ended: true, modem_confirmed: true });
h.api.onDeviceMessage(h.device, { type: "call.state", payload: { call: { call_id: "gw-dial", direction: "outgoing", state: "ENDED" }, event: "ended" } });
await until(() => texts.some((t) => t.status === "remote_ended"), "remote_ended");
assert.equal(h.api._state.current, null);

// incoming call: one VoIP push with valid media fields, deduped by Air8000 call id
h.api.onDeviceMessage(h.device, { type: "call.state", payload: { call: { call_id: "1700000000000", direction: "incoming", state: "INCOMING", number: "10010" }, event: "incoming" } });
h.api.onDeviceMessage(h.device, { type: "call.state", payload: { call: { call_id: "1700000000000", direction: "incoming", state: "INCOMING", number: "10010" }, event: "ringing" } });
await until(() => h.pushes.length >= 1, "voip push");
const voip = h.pushes[0];
assert.equal(h.pushes.length, 1);
assert.equal(voip.topic, `${BUNDLE}.voip`); assert.equal(voip.pushType, "voip"); assert.equal(voip.environment, "sandbox");
assert.equal(voip.payload.event, "incoming_call"); assert.equal(voip.payload.number, "10010"); assert.equal(voip.payload.call_id, "1700000000000");
assert.match(voip.payload.expires_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
assert.match(voip.payload.media_url, /^wss:\/\//);
// missed call: the caller hangs up before anyone answers, which must stop ringing
h.api.onDeviceMessage(h.device, { type: "call.state", payload: { call: { call_id: "1700000000000", direction: "incoming", state: "ENDED" }, event: "remote_hangup" } });
await until(() => h.pushes.length === 2, "cancel push");
assert.deepEqual([h.pushes[1].pushType, h.pushes[1].payload.event, h.pushes[1].payload.phase], ["background", "call_owner", "ended"]);

// incoming SMS: alert push, deduped by message_id
const sms = { type: "sms.received", payload: { message_id: "10086:1:2", sender: "10086", body: "余额提醒", timestamp: 1760000000 } };
h.api.onDeviceMessage(h.device, sms); h.api.onDeviceMessage(h.device, sms);
await until(() => h.pushes.length === 3, "sms push");
assert.equal(h.pushes.length, 3);
assert.deepEqual([h.pushes[2].pushType, h.pushes[2].payload.event, h.pushes[2].payload.content, h.pushes[2].payload.timestamp], ["alert", "incoming_sms", "余额提醒", "2025-10-09T08:53:20Z"]);
phone.close(); h.close();

// APNs provider token is ES256 with a raw 64-byte signature
const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const apns = createApnsSender({ teamId: "TEAM123456", keyId: "KEY1234567", p8: privateKey.export({ type: "pkcs8", format: "pem" }) });
const [header, , sig] = apns.providerToken().split(".");
assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "ES256", kid: "KEY1234567" });
assert.equal(Buffer.from(sig, "base64url").length, 64);

console.log("iOS /v1 API tests passed");
