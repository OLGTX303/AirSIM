// iOS-app-compatible cloud Relay API for the Air8000 VPS gateway.
//
// The AirSIM iOS app speaks the push-relay-worker /v1 protocol. This module
// serves that protocol under /ios/<IOS_ACCESS_TOKEN>/ and drives the Air8000
// through the gateway's own admin API (commands + /media), exactly like the
// browser dashboard, so every voice backend (sip_bridge, direct_pcm) is reused.
//
// The app registers trust-on-first-use (device_id + device_secret), so the
// access token in the Relay URL path is what keeps strangers off your SIM.
// Logs never contain tokens, secrets, phone numbers or SMS text.
import crypto from "node:crypto";
import fs from "node:fs";
import http2 from "node:http2";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MEDIA_FRAME_BYTES = 64 * 1024;
const TOKEN_PATTERN = /^[0-9a-f]{16,512}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_CALL_EVENTS = ["ended", "failed", "hangup", "reject", "remote_hangup", "disconnected"];
const COMMAND_TTL_MS = { dial: 30_000, send_sms: 300_000, dtmf: 15_000 };
const ACTION_TTL_MS = 30_000;
const CALL_TTL_MS = 5 * 60 * 60 * 1000;
const VOIP_PUSH_TTL_S = 90;

const sha256Hex = (text) => crypto.createHash("sha256").update(String(text)).digest("hex");
function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const codePoints = (s) => [...String(s)];
function send(res, status, value) {
  const body = JSON.stringify(value) + "\n";
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
async function readJSON(req) {
  if (Number(req.headers["content-length"] || 0) > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large"); chunks.push(chunk); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new HttpError(400, "invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid JSON");
  return value;
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

export function normalizePhoneNumber(value) {
  if (typeof value !== "string" || !/^[0-9+*# ()-]+$/.test(value)) return null;
  const number = value.replace(/[ ()-]/g, "");
  return number && number.length <= 82 ? number : null;
}

/** Firmware SMS timestamps may be ms, seconds, or missing. */
function smsTimestampMs(value, now) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 1e12) return n;
  if (Number.isFinite(n) && n > 1e9) return n * 1000;
  return now;
}

function safeStatus(device) {
  const out = { device_type: "air8000a", hardware_model: "Air8000A" };
  const str = (k, v) => { if (typeof v === "string" && v) out[k] = v; };
  str("firmware", device.firmware);
  str("agent_version", device.firmware);
  str("protocol_version", "airsim.air8000.v1");
  str("gnss_state", device.status?.gnss_state);
  const dbm = Number(device.status?.signal_dbm);
  if (Number.isInteger(dbm)) out.signal_dbm = dbm;
  const loc = device.location || device.status?.location;
  if (loc && typeof loc.fix === "boolean") {
    const l = { fix: loc.fix };
    if (typeof loc.fix_state === "string") l.fix_state = loc.fix_state;
    for (const k of ["latitude", "longitude", "altitude_m", "speed_mps", "heading_deg"]) if (Number.isFinite(loc[k])) l[k] = loc[k];
    for (const k of ["satellites", "fix_age_ms", "timestamp"]) if (Number.isInteger(loc[k])) l[k] = loc[k];
    out.location = l;
  }
  return out;
}

/** APNs HTTP/2 sender with a cached ES256 provider token. */
export function createApnsSender({ teamId, keyId, p8 }) {
  if (!teamId || !keyId || !p8) throw new Error("APNs credentials are incomplete");
  const key = crypto.createPrivateKey(String(p8).replace(/\\n/g, "\n"));
  let jwt = "", jwtAt = 0;
  const sessions = new Map();
  const providerToken = () => {
    if (jwt && Date.now() - jwtAt < 50 * 60 * 1000) return jwt;
    const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const input = `${b64({ alg: "ES256", kid: keyId })}.${b64({ iss: teamId, iat: Math.floor(Date.now() / 1000) })}`;
    const sig = crypto.sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
    jwt = `${input}.${sig}`; jwtAt = Date.now();
    return jwt;
  };
  const session = (host) => {
    let s = sessions.get(host);
    if (s && !s.closed && !s.destroyed) return s;
    s = http2.connect(host);
    s.on("error", () => sessions.delete(host));
    s.on("close", () => sessions.delete(host));
    s.setTimeout(10 * 60 * 1000, () => s.close());
    sessions.set(host, s);
    return s;
  };
  const sender = ({ environment, token, topic, pushType, priority, expiration, collapseId, payload }) => new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    if (body.length > 4096) return reject(new Error("APNs payload too large"));
    const host = environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
    const headers = { ":method": "POST", ":path": `/3/device/${token}`, authorization: `bearer ${providerToken()}`, "content-type": "application/json", "apns-topic": topic, "apns-push-type": pushType, "apns-priority": String(priority), "apns-expiration": String(expiration) };
    if (collapseId) headers["apns-collapse-id"] = String(collapseId).length > 64 ? `airsim-${sha256Hex(collapseId).slice(0, 57)}` : String(collapseId);
    let req;
    try { req = session(host).request(headers); } catch (e) { return reject(e); }
    let status = 0, text = "";
    req.setTimeout(15_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
    req.on("response", (h) => { status = h[":status"]; });
    req.on("data", (d) => { if (text.length < 1024) text += d; });
    req.on("end", () => (status >= 200 && status < 300 ? resolve(status) : reject(new Error(`APNs HTTP ${status || "timeout"}: ${text.slice(0, 200)}`))));
    req.on("error", reject);
    req.end(body);
  });
  sender.providerToken = providerToken;
  return sender;
}

/** Drives the Air8000 through the gateway's own admin HTTP API and /media socket. */
export function localGatewayClient(port, adminToken) {
  const base = `http://127.0.0.1:${port}`;
  const call = async (path, value) => {
    const res = await fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify(value) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return {
    command: (deviceID, type, payload) => call(`/api/devices/${encodeURIComponent(deviceID)}/command`, { type, payload }),
    async openMedia(deviceID) {
      const r = await call(`/api/devices/${encodeURIComponent(deviceID)}/media-ticket`, {});
      if (r.status !== 201) throw new Error(r.body?.error || `media ticket HTTP ${r.status}`);
      const ticket = new URL(r.body.ws_url).searchParams.get("ticket");
      return { socket: new WebSocket(`ws://127.0.0.1:${port}/media?ticket=${encodeURIComponent(ticket)}`), info: r.body };
    },
  };
}

export function createIosApi({ accessToken, allowedBundleId, publicUrl, stateFile, lanMode = false, apns = null, devices, targetDeviceID = "", gateway, now = () => Date.now(), log = console }) {
  const enabled = Boolean(accessToken && allowedBundleId && publicUrl);
  const statePath = stateFile || (lanMode ? fileURLToPath(new URL("./.ios-state.json", import.meta.url)) : "/data/ios-state.json");
  const mediaBase = String(publicUrl || "").replace(/\/+$/, "").replace(/^https:/i, "wss:");
  if (accessToken && publicUrl && !/^https:\/\//i.test(publicUrl)) log.error("iOS API: IOS_PUBLIC_URL must be https:// (the app rejects http)");
  if (!enabled) log.log("iOS API disabled: set IOS_ACCESS_TOKEN, IOS_PUBLIC_URL and ALLOWED_BUNDLE_ID");
  else if (!apns) log.log("iOS API: APNs disabled (set APNS_TEAM_ID, APNS_KEY_ID, APNS_P8); calls and SMS will not wake the iPhone");

  const registrations = new Map(); // device_id -> record (persisted)
  const commands = new Map(); // app command_id -> record
  const byGatewayID = new Map(); // gateway message_id -> app command or call action
  const calls = new Map(); // call_uuid -> call
  const seenSMS = new Set();
  let current = null; // the single active Air8000 call
  const mediaWss = new WebSocketServer({ noServer: true, maxPayload: MAX_MEDIA_FRAME_BYTES });

  try {
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    for (const r of saved.registrations || []) if (nonEmpty(r.device_id) && nonEmpty(r.secret_hash)) registrations.set(r.device_id, r);
  } catch {}
  const persist = () => {
    try {
      const tmp = `${statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, registrations: [...registrations.values()] }), { mode: 0o600 });
      fs.renameSync(tmp, statePath);
    } catch (e) { log.error(`iOS API: could not save registrations: ${e.message}`); }
  };

  const target = () => {
    if (targetDeviceID) return devices.get(targetDeviceID) || null;
    const all = [...devices.values()];
    return all.find((d) => d.socket?.readyState === 1) || all[0] || null;
  };
  const online = (d) => d?.socket?.readyState === 1;

  function authenticate(deviceID, secret) {
    if (!nonEmpty(deviceID) || typeof secret !== "string") return null;
    const reg = registrations.get(deviceID.trim());
    return reg && sameSecret(reg.secret_hash, sha256Hex(secret)) ? reg : null;
  }
  const requireAuth = (value) => {
    const reg = authenticate(value.device_id, value.device_secret);
    if (!reg) throw new HttpError(401, "unauthorized");
    return reg;
  };

  // ---------- APNs fan-out ----------
  async function push(reg, kind, fields) {
    if (!apns) return false;
    try { await apns({ environment: reg.environment, ...fields }); return true; }
    catch (e) { log.error(`iOS push ${kind} failed: ${e.message}`); return false; }
  }

  function pushIncomingCall(call) {
    const issued = now();
    const payload = {
      aps: { "content-available": 1 }, event: "incoming_call", call_id: call.call_id, call_uuid: call.call_uuid, generation: 1,
      number: call.number || "", caller_name: "", issued_at: isoSeconds(issued), expires_at: isoSeconds(issued + VOIP_PUSH_TTL_S * 1000),
      call_secret: call.call_secret, media_url: call.media_url, media_transport: "legacy_pcm",
    };
    const expiration = Math.floor(issued / 1000) + VOIP_PUSH_TTL_S;
    let sent = 0;
    for (const reg of registrations.values()) {
      const base = { pushType: "voip", priority: 10, expiration, collapseId: call.call_uuid, payload };
      if (reg.voip_token) push(reg, "incoming_call", { ...base, token: reg.voip_token, topic: `${reg.bundle_id}.voip` }).then((ok) => ok && log.log(`iOS push incoming_call delivered (${++sent})`));
      if (reg.watch_voip_token) push(reg, "watch_incoming_call", { ...base, token: reg.watch_voip_token, topic: `${reg.watch_bundle_id}.voip` });
    }
  }

  function pushCallCancelled(call) {
    // No dedicated cancel push exists in the app; a background call_owner
    // "ended" event is what stops CallKit ringing on the iPhone.
    const payload = { aps: { "content-available": 1 }, event: "call_owner", call_id: call.call_id, call_uuid: call.call_uuid, owner: "watch", phase: "ended" };
    for (const reg of registrations.values()) {
      if (!reg.alert_token) continue;
      push(reg, "call_cancel", { token: reg.alert_token, topic: reg.bundle_id, pushType: "background", priority: 5, expiration: Math.floor(now() / 1000) + 120, collapseId: `${call.call_uuid}-ended`, payload });
    }
  }

  function pushSMS(msg) {
    const id = String(msg.message_id || `${msg.sender}:${msg.timestamp}:${String(msg.body || "").length}`);
    if (!nonEmpty(msg.sender) || !nonEmpty(msg.body) || seenSMS.has(id)) return;
    seenSMS.add(id); if (seenSMS.size > 500) seenSMS.delete(seenSMS.values().next().value);
    const chars = codePoints(msg.body); const truncated = chars.length > 700;
    const content = truncated ? chars.slice(0, 700).join("") + "…" : msg.body;
    const ts = isoSeconds(Math.min(smsTimestampMs(msg.timestamp, now()), now()));
    const payload = {
      aps: { alert: { title: msg.sender, body: content }, sound: "default", "thread-id": `airsim-sms-${msg.sender}`.slice(0, 64), "content-available": 1 },
      event: "incoming_sms", delivery_id: id, sender: msg.sender, content, content_truncated: truncated, code: "", timestamp: ts,
    };
    for (const reg of registrations.values()) {
      if (reg.alert_token) push(reg, "incoming_sms", { token: reg.alert_token, topic: reg.bundle_id, pushType: "alert", priority: 10, expiration: Math.floor(now() / 1000) + 86400, collapseId: id, payload });
    }
  }

  // ---------- calls and media ----------
  function newCall({ callID, direction, number }) {
    const call_uuid = crypto.randomUUID();
    const call = {
      call_id: callID, call_uuid, call_secret: crypto.randomBytes(32).toString("base64url"), generation: 1, direction, number: number || "",
      media_url: `${mediaBase}/ios/${accessToken}/v1/calls/${call_uuid}/connect`, device_call_id: direction === "incoming" ? callID : null,
      state: "ringing", answered: false, owner: null, clients: new Map(), gwMedia: null, actions: new Map(), expires_at: now() + CALL_TTL_MS,
    };
    calls.set(call_uuid, call);
    return call;
  }
  const meta = (call, extra = {}) => ({ call_id: call.call_id, call_uuid: call.call_uuid, generation: call.generation, ...extra });
  const tell = (ws, value) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
  const tellAll = (call, value) => { for (const ws of call.clients.values()) tell(ws, value); };

  function finishCall(call, reason) {
    if (call.ended) return;
    call.ended = true; call.state = "ended";
    for (const action of call.actions.values()) if (action.status === "pending") Object.assign(action, { status: "completed", result: { ended: true, modem_confirmed: true } });
    if (call.direction === "incoming" && !call.answered) pushCallCancelled(call);
    tellAll(call, meta(call, { status: "remote_ended", message: reason }));
    for (const ws of call.clients.values()) try { ws.close(1000, "call ended"); } catch {}
    closeGatewayMedia(call);
    if (current === call) current = null;
    setTimeout(() => calls.delete(call.call_uuid), 60_000).unref?.();
  }

  function closeGatewayMedia(call) {
    const g = call.gwMedia; call.gwMedia = null;
    if (g) try { g.close(); } catch {}
  }

  function ensureGatewayMedia(call) {
    if (call.gwMedia || call.ended) return Promise.resolve();
    call.gwOpening ||= openGatewayMedia(call).finally(() => { call.gwOpening = null; });
    return call.gwOpening;
  }

  async function openGatewayMedia(call) {
    const device = target();
    if (!online(device)) throw new Error("Air8000 is offline");
    const { socket, info } = await gateway.openMedia(device.device_id);
    if (info?.browser_sample_rate && info.browser_sample_rate !== 8000) log.error(`iOS media: Air8000 media leg is ${info.browser_sample_rate} Hz, the app expects 8000 Hz`);
    if (call.ended || call.clients.size === 0) { try { socket.close(); } catch {} return; }
    call.gwMedia = socket;
    socket.on("message", (data, isBinary) => {
      if (!isBinary) return; // gateway transport notices are dashboard-only
      const peers = call.owner ? [call.clients.get(call.owner)].filter(Boolean) : [...call.clients.values()];
      for (const ws of peers) if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
    });
    socket.on("close", (code) => {
      if (call.gwMedia !== socket) return;
      call.gwMedia = null;
      if (code === 4001) finishCall(call, "carrier call ended");
      else if (call.clients.size) tellAll(call, meta(call, { status: "pcm_recovering" }));
    });
    socket.on("error", () => {});
  }

  function handleClientText(call, role, ws, raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const receipt = meta(call, { action: msg.action, command_id: typeof msg.command_id === "string" ? msg.command_id : undefined, trace_id: typeof msg.trace_id === "string" ? msg.trace_id : undefined });
    if (call.owner && call.owner !== role) { tell(ws, { status: "ownership_lost", owner: call.owner }); return; }
    if (msg.action !== "answer") { tell(ws, { ...receipt, status: "action_error", message: "use the HTTP call action API" }); return; }
    call.owner = role;
    for (const [otherRole, other] of call.clients) if (otherRole !== role) { tell(other, { status: "ownership_lost", owner: role }); try { other.close(4002, "answered on another device"); } catch {} }
    if (call.direction === "incoming" && !call.answered) {
      call.answered = true;
      const device = target();
      if (!online(device)) { tell(ws, { ...receipt, status: "action_error", message: "Air8000 is offline" }); call.answered = false; return; }
      gateway.command(device.device_id, "answer", {}).then((r) => {
        if (r.status !== 202) { call.answered = false; tell(ws, { ...receipt, status: "action_error", message: r.body?.error || "answer failed" }); }
      }).catch(() => { call.answered = false; tell(ws, { ...receipt, status: "action_error", message: "answer failed" }); });
    }
    call.answered = call.answered || call.direction === "outgoing";
    tell(ws, { ...receipt, status: "answer_ok" });
    if (call.state === "active") tell(ws, meta(call, { status: "active" }));
  }

  mediaWss.on("connection", (ws, call, role) => {
    const old = call.clients.get(role);
    if (old) try { old.close(4001, "replaced by a newer connection"); } catch {}
    if (call.owner && call.owner !== role) { tell(ws, { status: "ownership_lost", owner: call.owner }); ws.close(4002, "answered on another device"); return; }
    call.clients.set(role, ws);
    tell(ws, { event: "peer_connected", role: "agent" });
    ensureGatewayMedia(call).catch((e) => { log.error(`iOS media setup failed: ${e.message}`); tell(ws, meta(call, { status: "pcm_recovering", message: e.message })); });
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return handleClientText(call, role, ws, data.toString("utf8"));
      if (call.owner === role && call.gwMedia?.readyState === WebSocket.OPEN) call.gwMedia.send(data, { binary: true });
    });
    ws.on("close", () => {
      if (call.clients.get(role) !== ws) return;
      call.clients.delete(role);
      if (call.clients.size === 0) closeGatewayMedia(call);
    });
    ws.on("error", () => {});
  });

  // ---------- Air8000 events ----------
  function completeCommand(cmd, ok, error) {
    if (cmd.status !== "delivered" && cmd.status !== "pending") return;
    if (!ok) { Object.assign(cmd, { status: "failed", error: error || "Air8000 command failed" }); return; }
    const result = cmd.type === "dial" ? { dialing: true } : cmd.type === "send_sms" ? { sent: true, segments: 1 } : { sent: true };
    Object.assign(cmd, { status: "completed", result });
  }

  function onDeviceMessage(device, msg) {
    if (!enabled || !msg || device !== target()) return;
    const p = msg.payload || {};
    if (msg.type === "device.command_result") {
      const item = byGatewayID.get(p.command_id);
      if (!item) return;
      byGatewayID.delete(p.command_id);
      if (item.kind === "command") completeCommand(item.cmd, p.ok === true, p.error);
      else if (item.action.status === "pending") {
        const ok = p.ok === true || p.error === "no_call";
        Object.assign(item.action, ok ? { status: "completed", result: { ended: true, modem_confirmed: true } } : { status: "failed", error: p.error || "hangup failed" });
      }
      return;
    }
    if (msg.type === "sms.received") return pushSMS(p);
    if (msg.type !== "call.state") return;
    const info = p.call || p;
    const event = String(p.event || "").toLowerCase();
    const state = String(info.state || "").toUpperCase();
    const terminal = TERMINAL_CALL_EVENTS.includes(event) || ["ENDED", "FAILED", "IDLE"].includes(state);
    if (info.direction === "incoming" && (event === "incoming" || state === "INCOMING") && !terminal) {
      const id = String(info.call_id || "");
      if (current && !current.ended && current.device_call_id === id) return;
      if (current && !current.ended) finishCall(current, "replaced by a new incoming call");
      current = newCall({ callID: id || `air8000-${now()}`, direction: "incoming", number: typeof info.number === "string" ? info.number : "" });
      log.log("iOS incoming call: sending VoIP push");
      return pushIncomingCall(current);
    }
    const call = current;
    if (!call || call.ended) return;
    if (call.direction === "outgoing") {
      if (!call.device_call_id && info.call_id) call.device_call_id = String(info.call_id);
      const dial = commands.get(call.dial_command_id);
      if (dial && ["dial", "ringing", "connected", "answer_done"].includes(event)) completeCommand(dial, true);
      if (dial && event === "failed") completeCommand(dial, false, "dial failed");
    }
    if (terminal) return finishCall(call, event || state.toLowerCase());
    if (event === "connected" || state === "CONNECTED") {
      if (call.state !== "active") { call.state = "active"; tellAll(call, meta(call, { status: "active" })); }
    }
  }

  // ---------- HTTP ----------
  function sweep() {
    const t = now();
    for (const [id, cmd] of commands) {
      if ((cmd.status === "delivered" || cmd.status === "pending") && t > cmd.expires_at) Object.assign(cmd, { status: "failed", error: "Air8000 did not confirm the command in time" });
      if (t - cmd.created_at > 10 * 60 * 1000) commands.delete(id);
    }
    if (byGatewayID.size > 1000) byGatewayID.clear(); // ponytail: results older than the cap are dropped
    for (const call of calls.values()) {
      for (const a of call.actions.values()) if (a.status === "pending" && t > a.expires_at) Object.assign(a, { status: "expired", error: "Air8000 did not confirm the hangup" });
      if (!call.ended && t > call.expires_at) finishCall(call, "call expired");
    }
  }
  const commandView = (c) => ({ command_id: c.command_id, status: c.status, ...(c.result ? { result: c.result } : {}), ...(c.error ? { error: c.error } : {}) });
  const actionView = (a) => ({ accepted: a.status !== "failed", command_id: a.command_id, status: a.status, agent_connected: online(target()), ...(a.result ? { result: a.result } : {}), ...(a.error ? { error: a.error } : {}) });
  const callView = (call) => ({ call_id: call.call_id, call_uuid: call.call_uuid, generation: 1, call_secret: call.call_secret, media_url: call.media_url, media_transport: "legacy_pcm" });

  function register(value) {
    if (!nonEmpty(value.device_id) || value.device_id.trim().length > 128 || typeof value.device_secret !== "string" || value.device_secret.length < 16 || value.device_secret.length > 512) throw new HttpError(400, "invalid device identity");
    const tokens = ["voip_token", "alert_token", "watch_voip_token", "live_activity_push_to_start_token"];
    if (!tokens.some((k) => nonEmpty(value[k]))) throw new HttpError(400, "at least one APNs token is required");
    if (tokens.some((k) => nonEmpty(value[k]) && !TOKEN_PATTERN.test(value[k]))) throw new HttpError(400, "invalid APNs token");
    if (value.bundle_id !== allowedBundleId) throw new HttpError(400, "bundle id is not allowed");
    if (nonEmpty(value.watch_voip_token) && value.watch_bundle_id !== `${allowedBundleId}.watchkitapp`) throw new HttpError(400, "watch bundle id is not allowed");
    if (!["sandbox", "production"].includes(value.environment)) throw new HttpError(400, "invalid APNs environment");
    const id = value.device_id.trim(), hash = sha256Hex(value.device_secret);
    const existing = registrations.get(id);
    if (existing && !sameSecret(existing.secret_hash, hash)) throw new HttpError(401, "device authentication failed");
    const lower = (k) => (nonEmpty(value[k]) ? value[k].toLowerCase() : "");
    registrations.set(id, {
      device_id: id, secret_hash: hash, voip_token: lower("voip_token"), alert_token: lower("alert_token"), watch_voip_token: lower("watch_voip_token"),
      live_activity_push_to_start_token: lower("live_activity_push_to_start_token"), watch_bundle_id: nonEmpty(value.watch_voip_token) ? value.watch_bundle_id : "",
      bundle_id: value.bundle_id, environment: value.environment, registered_at: new Date(now()).toISOString(),
    });
    persist();
    log.log(`iOS device registered (${registrations.size} total, ${value.environment})`);
    return { registered: true };
  }

  async function enqueue(reg, value) {
    if (!UUID_PATTERN.test(String(value.command_id || "")) || !["dial", "send_sms", "dtmf"].includes(value.type)) throw new HttpError(400, "invalid device command");
    if (value.media_transport !== undefined && (value.type !== "dial" || value.media_transport !== "legacy_pcm")) throw new HttpError(400, "invalid media transport");
    const commandID = value.command_id.toLowerCase();
    const existing = commands.get(commandID);
    if (existing) {
      if (existing.owner !== reg.device_id || existing.type !== value.type) throw new HttpError(409, "command id belongs to another operation");
      const call = existing.call_uuid && calls.get(existing.call_uuid);
      return [202, { accepted: true, duplicate: true, ...commandView(existing), agent_connected: online(target()), ...(call ? { call: callView(call) } : {}) }];
    }
    const number = normalizePhoneNumber(value.number);
    if (!number) throw new HttpError(400, "invalid phone number");
    if (value.type === "dtmf" && !/^[0-9*#]$/.test(number)) throw new HttpError(400, "invalid phone number");
    let message = "";
    if (value.type === "send_sms") {
      message = typeof value.message === "string" ? value.message.trim() : "";
      if (!message || codePoints(message).length > 2000) throw new HttpError(400, "invalid SMS content");
    }
    const device = target();
    if (!online(device)) throw new HttpError(409, "Air8000 is offline");
    if (value.type === "dial" && current && !current.ended) throw new HttpError(409, "Air8000 already has an active call");

    const cmd = { command_id: commandID, owner: reg.device_id, type: value.type, status: "delivered", created_at: now(), expires_at: now() + COMMAND_TTL_MS[value.type] };
    let call = null;
    if (value.type === "dial") {
      call = newCall({ callID: `outgoing-${commandID}`, direction: "outgoing", number });
      call.dial_command_id = commandID; cmd.call_uuid = call.call_uuid; current = call;
    }
    const payload = value.type === "dial" ? { number } : value.type === "send_sms" ? { number, body: message } : { digit: number };
    const r = await gateway.command(device.device_id, value.type, payload);
    if (r.status !== 202) {
      if (call) { calls.delete(call.call_uuid); if (current === call) current = null; }
      throw new HttpError(409, r.body?.error || "Air8000 rejected the command");
    }
    commands.set(commandID, cmd);
    if (r.body?.command_id) byGatewayID.set(r.body.command_id, { kind: "command", cmd });
    return [202, { accepted: true, command_id: commandID, status: cmd.status, agent_connected: true, ...(call ? { call: callView(call) } : {}) }];
  }

  async function callAction(reg, callUUID, value) {
    const call = calls.get(callUUID);
    if (!call) throw new HttpError(404, "call not found");
    if (!UUID_PATTERN.test(String(value.command_id || "")) || !["answer", "reject", "end"].includes(value.action)) throw new HttpError(400, "invalid call action");
    if (value.call_id !== call.call_id || String(value.call_uuid || "").toLowerCase() !== call.call_uuid) throw new HttpError(409, "call identity mismatch");
    if ((value.generation ?? 1) !== call.generation) throw new HttpError(409, "stale call generation");
    const commandID = value.command_id.toLowerCase();
    const existing = call.actions.get(commandID);
    if (existing) return [202, { ...actionView(existing), duplicate: true }];
    const action = { command_id: commandID, owner: reg.device_id, action: value.action, status: "pending", expires_at: now() + ACTION_TTL_MS };
    call.actions.set(commandID, action);
    if (call.ended) Object.assign(action, { status: "completed", result: { ended: true, modem_confirmed: true } });
    else {
      const device = target();
      if (!online(device)) Object.assign(action, { status: "failed", error: "Air8000 is offline" });
      else {
        const type = value.action === "answer" ? "answer" : value.action === "reject" && call.direction === "incoming" && !call.answered ? "reject" : "hangup";
        if (type === "answer") call.answered = true;
        const r = await gateway.command(device.device_id, type, {});
        if (r.status !== 202) Object.assign(action, { status: "failed", error: r.body?.error || "Air8000 rejected the action" });
        else if (r.body?.command_id) byGatewayID.set(r.body.command_id, { kind: "action", action });
      }
    }
    return [202, actionView(action)];
  }

  async function route(req, res, path) {
    sweep();
    if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true, service: "airsim-air8000-vps-ios", version: "1" });
    const result = path.match(/^\/v1\/calls\/([0-9a-f-]+)\/actions\/([0-9a-f-]+)$/i);
    if (req.method === "GET" && result) {
      const bearer = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1];
      const reg = authenticate(req.headers["x-airsim-device-id"], bearer);
      if (!reg) return send(res, 401, { error: "unauthorized" });
      const action = calls.get(result[1].toLowerCase())?.actions.get(result[2].toLowerCase());
      return action ? send(res, 200, actionView(action)) : send(res, 404, { error: "command not found" });
    }
    if (req.method !== "POST") return send(res, 404, { error: "not found" });
    const value = await readJSON(req);
    if (path === "/v1/devices/register") return send(res, 200, register(value));
    const reg = requireAuth(value);
    if (path === "/v1/devices/status") {
      const device = target();
      return send(res, 200, online(device) ? { cloud_online: true, ...safeStatus(device) } : { cloud_online: false });
    }
    if (path === "/v1/live-activities/register") return send(res, 200, { registered: true }); // ponytail: Live Activity pushes not sent yet
    if (path === "/v1/commands/enqueue") { const [status, body] = await enqueue(reg, value); return send(res, status, body); }
    if (path === "/v1/commands/result") {
      const cmd = commands.get(String(value.command_id || "").toLowerCase());
      return cmd && cmd.owner === reg.device_id ? send(res, 200, commandView(cmd)) : send(res, 404, { error: "command not found" });
    }
    const action = path.match(/^\/v1\/calls\/([0-9a-f-]+)\/actions$/i);
    if (action) { const [status, body] = await callAction(reg, action[1].toLowerCase(), value); return send(res, status, body); }
    return send(res, 404, { error: "not found" });
  }

  /** Returns the API path after /ios/<token>, or null when the token is wrong. */
  function apiPath(pathname) {
    const m = pathname.match(/^\/ios\/([^/]+)(\/.*)$/);
    return enabled && m && sameSecret(decodeURIComponent(m[1]), accessToken) ? m[2] : null;
  }

  return {
    enabled,
    async handleHttp(req, res, url) {
      const path = apiPath(url.pathname);
      if (path === null) return send(res, 404, { error: "not found" });
      try { await route(req, res, path); }
      catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { error: e.message });
        log.error(`iOS API error: ${e.message}`);
        send(res, 500, { error: "relay internal error" });
      }
    },
    handleUpgrade(req, socket, head, url) {
      const path = apiPath(url.pathname);
      const m = path?.match(/^\/v1\/calls\/([0-9a-f-]+)\/connect$/i);
      const call = m && calls.get(m[1].toLowerCase());
      const role = url.searchParams.get("role");
      if (!call || call.ended || now() > call.expires_at || !["iphone", "watch"].includes(role) || !sameSecret(url.searchParams.get("token"), call.call_secret)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      mediaWss.handleUpgrade(req, socket, head, (ws) => mediaWss.emit("connection", ws, call, role));
    },
    onDeviceMessage,
    // test hooks
    _state: { registrations, commands, calls, get current() { return current; } },
  };
}
