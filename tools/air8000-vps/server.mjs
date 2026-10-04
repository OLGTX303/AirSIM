import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
const LAN_MODE = process.env.LAN_MODE === "true";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const AUTO_ENROLL_TOKEN = process.env.AUTO_ENROLL_TOKEN || "";
const ENROLLMENT_TOKEN = process.env.ENROLLMENT_TOKEN || "";
const DEVICE_CA_CERT = process.env.DEVICE_CA_CERT || "/data/pki/device-ca.pem";
const DEVICE_CA_KEY = process.env.DEVICE_CA_KEY || "/data/pki/device-ca-key.pem";
const DEVICE_CA_SERIAL = `${DEVICE_CA_CERT}.srl`;
const registry = JSON.parse(process.env.DEVICE_REGISTRY_JSON || "{}");
const devices = new Map();
const commands = new Map();
const mediaTickets = new Map();
const mediaPeers = new Map();

function sameSecret(a, b) {
  const left = Buffer.from(String(a || "")); const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function admin(req) { return sameSecret((req.headers.authorization || "").replace(/^Bearer\s+/i, ""), ADMIN_TOKEN); }
function json(res, status, value) { const body = JSON.stringify(value); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }); res.end(body); }
async function body(req) { let raw=""; for await (const chunk of req) { raw += chunk; if (raw.length > 65536) throw Error("body too large"); } return JSON.parse(raw || "{}"); }
function publicDevice(d) { return { device_id:d.device_id, serial_number:d.serial_number, imei:d.imei, device_type:d.device_type, hardware_model:d.hardware_model, firmware:d.firmware, capabilities:d.capabilities, status:d.status, location:d.location, wifi:d.wifi, media_rate:d.media_rate || 8000, media_uplink_rate:d.media_uplink_rate || 16000, media_stats:d.media_stats || {uplink_frames:0,uplink_bytes:0,downlink_frames:0,downlink_bytes:0,dropped_downlink_frames:0}, events:d.events || [], connected:!!d.socket, last_seen:d.last_seen }; }
function command(id, type, payload) { const d=devices.get(id); if (!d?.socket || d.socket.readyState !== 1) return false; const item={protocol_version:"airsim.air8000.v1",message_id:crypto.randomUUID(),device_id:id,timestamp:Date.now(),nonce:crypto.randomUUID(),type:"command."+type,payload}; d.socket.send(JSON.stringify(item)); commands.set(item.message_id,{...item,created_at:Date.now()}); return item.message_id; }
function issueMediaTicket(deviceID) { const ticket=crypto.randomBytes(24).toString("base64url"); mediaTickets.set(ticket,{device_id:deviceID,expires:Date.now()+60000}); return ticket; }
function ensureCA() {
  if (fs.existsSync(DEVICE_CA_CERT) && fs.existsSync(DEVICE_CA_KEY)) {
    if (!fs.existsSync(DEVICE_CA_SERIAL)) fs.writeFileSync(DEVICE_CA_SERIAL, `${crypto.randomBytes(16).toString("hex")}\n`, { mode: 0o600 });
    return;
  }
  fs.mkdirSync(path.dirname(DEVICE_CA_CERT), { recursive: true });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "3650", "-keyout", DEVICE_CA_KEY, "-out", DEVICE_CA_CERT, "-subj", "/CN=AirSIM Air8000 Device CA"], { stdio: "ignore" });
  fs.chmodSync(DEVICE_CA_KEY, 0o600);
  fs.writeFileSync(DEVICE_CA_SERIAL, `${crypto.randomBytes(16).toString("hex")}\n`, { mode: 0o600 });
}
function validID(value) { return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value); }
function clientCertificateMatches(req, deviceID) {
  const verified = req.headers["x-client-verify"];
  const subject = String(req.headers["x-client-subject"] || "");
  return verified === "SUCCESS" && (subject.includes(`CN=${deviceID}`) || subject.includes(`CN = ${deviceID}`));
}
function enrollDevice(value) {
  if (!ENROLLMENT_TOKEN || !sameSecret(value.enrollment_token || "", ENROLLMENT_TOKEN)) throw Error("invalid enrollment token");
  if (!validID(value.device_id) || typeof value.serial_number !== "string" || !value.serial_number || typeof value.imei !== "string" || !value.imei || typeof value.csr !== "string" || value.csr.length > 20000) throw Error("device_id, serial_number, imei and csr are required");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airsim-enroll-"));
  const csr = path.join(dir, "device.csr"); const cert = path.join(dir, "device.crt"); const ext = path.join(dir, "device.ext");
  try {
    fs.writeFileSync(csr, value.csr, { mode: 0o600 });
    fs.writeFileSync(ext, "extendedKeyUsage = clientAuth\n", { mode: 0o600 });
    execFileSync("openssl", ["req", "-in", csr, "-noout", "-verify"], { stdio: "ignore" });
    execFileSync("openssl", ["x509", "-req", "-in", csr, "-CA", DEVICE_CA_CERT, "-CAkey", DEVICE_CA_KEY, "-CAserial", DEVICE_CA_SERIAL, "-days", "3650", "-sha256", "-extfile", ext, "-out", cert], { stdio: "ignore" });
    registry[value.device_id] = { enrolled: true, serial_number: value.serial_number, imei: value.imei };
    return { device_id: value.device_id, certificate: fs.readFileSync(cert, "utf8"), ca_certificate: fs.readFileSync(DEVICE_CA_CERT, "utf8"), expires_days: 3650 };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

if (!LAN_MODE) ensureCA();

const server=http.createServer(async (req,res)=>{
  try {
    const u=new URL(req.url,"http://localhost");
    if (req.method === "GET" && u.pathname === "/") { const page=fs.readFileSync(new URL("./public/index.html", import.meta.url)); res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store, no-cache, must-revalidate","pragma":"no-cache","content-length":page.length}); return res.end(page); }
    if (req.method === "GET" && u.pathname === "/api/health") return json(res,200,{ok:true,service:"airsim-air8000-vps",devices:devices.size});
    if (req.method === "POST" && u.pathname === "/api/enroll") return json(res,201,enrollDevice(await body(req)));
    if (!admin(req)) return json(res,401,{error:"unauthorized"});
    if (req.method === "GET" && u.pathname === "/api/devices") return json(res,200,[...devices.values()].map(publicDevice));
    const match=u.pathname.match(/^\/api\/devices\/([^/]+)\/command$/);
    const mediaMatch=u.pathname.match(/^\/api\/devices\/([^/]+)\/media-ticket$/);
    if (req.method === "POST" && mediaMatch) { const id=decodeURIComponent(mediaMatch[1]); const d=devices.get(id); if(!d?.socket || d.socket.readyState!==1) return json(res,409,{error:"device offline"}); const ticket=issueMediaTicket(id); const proto=String(req.headers["x-forwarded-proto"]||"http").split(",")[0]; return json(res,201,{expires_in:60,sample_rate:d.media_rate||8000,downlink_sample_rate:d.media_rate||8000,uplink_sample_rate:d.media_uplink_rate||16000,ws_url:`${proto==="https"?"wss":"ws"}://${req.headers.host}/media?ticket=${encodeURIComponent(ticket)}`}); }
    if (req.method === "POST" && match) { const value=await body(req); const id=decodeURIComponent(match[1]); if (!["dial","answer","reject","hangup","dtmf","send_sms","gps_request","wifi_config","wifi_connect","wifi_disconnect"].includes(value.type)) return json(res,400,{error:"unsupported command"}); const commandID=command(id,value.type,value.payload||{}); return commandID ? json(res,202,{accepted:true,command_id:commandID}) : json(res,409,{error:"device offline"}); }
    return json(res,404,{error:"not found"});
  } catch (e) { return json(res,400,{error:e.message}); }
});

const wss=new WebSocketServer({noServer:true});
const mediaWss=new WebSocketServer({noServer:true});
const mediaStats=new Map();
// LAN diagnostics: log only connection/message type and device identity, never
// enrollment tokens, device secrets, passwords, SMS, or message payloads.
wss.on("connection",(ws,req)=>{ console.log(`Air8000 WebSocket accepted from ${req.socket.remoteAddress||"unknown"}`); ws.on("message",(raw,isBinary)=>{ if(!isBinary){ try { const msg=JSON.parse(raw.toString()); console.log(`Air8000 message type=${msg.type||"unknown"} device=${msg.device_id||"unknown"} payload=${msg.payload&&typeof msg.payload==="object"?"present":"absent"}`); } catch { console.log("Air8000 message invalid_json"); } } }); });
server.on("upgrade", (req, socket, head) => {
  console.log(`Air8000 WebSocket upgrade from ${req.socket.remoteAddress || "unknown"} path=${req.url || ""}`);
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/media") {
    const item = mediaTickets.get(u.searchParams.get("ticket"));
    mediaTickets.delete(u.searchParams.get("ticket"));
    if (!item || item.expires < Date.now()) return socket.destroy();
    mediaWss.handleUpgrade(req, socket, head, ws => mediaWss.emit("connection", ws, item.device_id));
    return;
  }
  if (u.pathname !== "/device") return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});
mediaWss.on("connection",(ws,deviceID)=>{
  const old=mediaPeers.get(deviceID); if(old)try{old.close(4000,"replaced")}catch{}
  mediaPeers.set(deviceID,ws)
  const stats={uplink_frames:0,uplink_bytes:0,downlink_frames:0,downlink_bytes:0,dropped_downlink_frames:0,last_activity:Date.now()}
  mediaStats.set(deviceID,stats)
  const device=devices.get(deviceID); if(device) device.media_stats=stats
  console.log(`media connected device=${deviceID}`)
  ws.on("message",(raw,isBinary)=>{
    if(!isBinary)return
    stats.uplink_frames++; stats.uplink_bytes+=raw.length; stats.last_activity=Date.now()
    if(stats.uplink_frames===1)console.log(`media uplink device=${deviceID} bytes=${raw.length}`)
    const d=devices.get(deviceID); if(d?.socket?.readyState===1)d.socket.send(raw,{binary:true})
  })
  ws.on("close",()=>{
    if(mediaPeers.get(deviceID)===ws)mediaPeers.delete(deviceID)
    mediaStats.delete(deviceID)
    console.log(`media disconnected device=${deviceID}`)
  })
});
 wss.on("connection", (ws, req) => {
  let device = null;
  const reject = (reason) => {
    console.log(`Air8000 registration rejected: ${reason}`);
    try { ws.close(1008, "unauthorized"); } catch {}
  };
  ws.on("message", (raw, isBinary) => {
    try {
        if (isBinary) {
        if (!device) return reject("binary media before registration");
        let stats=mediaStats.get(device.device_id);
        if(!stats) {
          stats=device.media_stats || {uplink_frames:0,uplink_bytes:0,downlink_frames:0,downlink_bytes:0,dropped_downlink_frames:0,last_activity:Date.now()};
          device.media_stats=stats;
        }
        stats.downlink_frames++; stats.downlink_bytes+=raw.length; stats.last_activity=Date.now();
        if(stats.downlink_frames===1) console.log(`media downlink device=${device.device_id} bytes=${raw.length}`);
        const peer=mediaPeers.get(device.device_id);
        if (peer?.readyState === 1) {
          peer.send(raw,{binary:true});
        } else {
          stats.dropped_downlink_frames++;
          if(stats.dropped_downlink_frames===1) console.log(`media downlink dropped device=${device.device_id} reason=no_browser_media_peer`);
        }
        return;
      }
      const msg = JSON.parse(raw.toString());
      if (!device) {
        const nested = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
        const identity = {
          ...nested,
          ...msg,
          status: msg.status || nested.status,
          capabilities: msg.capabilities || nested.capabilities,
          serial_number: msg.serial_number || nested.serial_number,
          imei: msg.imei || nested.imei,
          device_secret: msg.device_secret || nested.device_secret,
          enrollment_token: msg.enrollment_token || nested.enrollment_token,
        };
        const mTLS = clientCertificateMatches(req, identity.device_id);
        const psk = identity.device_id && sameSecret(identity.device_secret, registry[identity.device_id]?.secret);
        const auto = identity.device_id && AUTO_ENROLL_TOKEN && sameSecret(identity.enrollment_token, AUTO_ENROLL_TOKEN) && identity.serial_number && identity.imei;
        if (identity.type !== "device.register" || !identity.device_id) return reject("invalid registration identity");
        if (!mTLS && !psk && !auto) return reject("authentication failed");
        if (auto && !registry[identity.device_id]) registry[identity.device_id] = { enrolled: true, serial_number: identity.serial_number, imei: identity.imei };
        device = {
          device_id: identity.device_id,
          serial_number: identity.serial_number,
          imei: identity.imei,
          device_type: identity.device_type,
          hardware_model: identity.hardware_model,
          firmware: identity.firmware,
          capabilities: identity.capabilities,
          status: identity.status || {},
          location: null,
          wifi: null,
          media_rate: 8000,
          media_uplink_rate: 16000,
          media_stats: {uplink_frames:0,uplink_bytes:0,downlink_frames:0,downlink_bytes:0,dropped_downlink_frames:0},
          events: [],
          socket: ws,
          last_seen: Date.now(),
          authentication: mTLS ? "mtls" : auto ? "auto_enroll" : "device_secret",
        };
        devices.set(device.device_id, device);
        ws.send(JSON.stringify({ type: "device.register.ack", device_id: device.device_id, protocol_version: "airsim.air8000.v1", authentication: device.authentication }));
        console.log(`Air8000 device active: ${device.device_id}`);
        return;
      }
      device.last_seen = Date.now();
      if (msg.type === "device.location" || msg.type === "event.location") device.location = msg.payload || msg.location;
      if (msg.type === "device.status" || msg.type === "event.status") device.status = msg.payload || msg.status;
      if (msg.type === "device.wifi" || msg.type === "event.wifi") device.wifi = msg.payload || msg.wifi;
      if (msg.type === "device.command_result" && msg.payload?.payload?.fix_state) device.location = msg.payload.payload;
      if (msg.type === "media.open" || msg.type === "media.ready") { device.media_rate = Number(msg.payload?.downlink_sample_rate || msg.payload?.sample_rate) || 8000; device.media_uplink_rate = Number(msg.payload?.uplink_sample_rate) || 16000; }
      if (["call.state", "sms.received", "sms.sent", "device.command_result", "media.open"].includes(msg.type)) {
        device.events = device.events || [];
        device.events.push({ type: msg.type, payload: msg.payload || {}, timestamp: msg.timestamp || Date.now() });
        if (device.events.length > 100) device.events.shift();
      }
    } catch { reject("invalid JSON"); }
  });
  ws.on("close", () => {
    if (device?.device_id) {
      const current = devices.get(device.device_id);
      if (current?.socket === ws) { current.socket = null; current.last_seen = Date.now(); }
    }
  });
 });
server.listen(PORT,()=>console.log(`AirSIM Air8000 VPS gateway listening on ${PORT}`));
