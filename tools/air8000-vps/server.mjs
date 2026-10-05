import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import dgram from "node:dgram";
import { WebSocketServer } from "ws";
import { buildRtpPacket, decodePcmuPayload, encodePcmuFrame, parseRtpPacket, randomRtpState } from "./rtp-pcm.mjs";
import { SipUdpServer } from "./sip-udp.mjs";

const PORT = Number(process.env.PORT || 8080);
const LAN_MODE = process.env.LAN_MODE === "true";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const AUTO_ENROLL_TOKEN = process.env.AUTO_ENROLL_TOKEN || "";
const ENROLLMENT_TOKEN = process.env.ENROLLMENT_TOKEN || "";
const DEVICE_CA_CERT = process.env.DEVICE_CA_CERT || "/data/pki/device-ca.pem";
const DEVICE_CA_KEY = process.env.DEVICE_CA_KEY || "/data/pki/device-ca-key.pem";
const DEVICE_CA_SERIAL = `${DEVICE_CA_CERT}.srl`;
const RTP_PUBLIC_HOST = String(process.env.RTP_PUBLIC_HOST || "").trim();
const RTP_PORT_BASE = Number(process.env.RTP_PORT_BASE || 41000);
const RTP_PORT_COUNT = Math.max(1, Math.min(256, Number(process.env.RTP_PORT_COUNT || 64)));
const SIP_PORT = Number(process.env.SIP_PORT || 5060);
const registry = JSON.parse(process.env.DEVICE_REGISTRY_JSON || "{}");
const devices = new Map();
const commands = new Map();
const mediaTickets = new Map();
const mediaPeers = new Map();
const mediaStats = new Map();
const rtpSessions = new Map();
const usedRtpPorts = new Set();

function sameSecret(a, b) {
  const left = Buffer.from(String(a || "")); const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function admin(req) { return sameSecret((req.headers.authorization || "").replace(/^Bearer\s+/i, ""), ADMIN_TOKEN); }
function json(res, status, value) { const body = JSON.stringify(value); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }); res.end(body); }
async function body(req) { let raw=""; for await (const chunk of req) { raw += chunk; if (raw.length > 65536) throw Error("body too large"); } return JSON.parse(raw || "{}"); }
function publicDevice(d) { return { device_id:d.device_id, serial_number:d.serial_number, imei:d.imei, device_type:d.device_type, hardware_model:d.hardware_model, firmware:d.firmware, capabilities:d.capabilities, status:d.status, location:d.location || d.status?.location || null, wifi:d.wifi || d.status?.wifi || null, media_backend:d.media_backend || d.status?.media_backend || null, media_transport:d.media_transport || null, real_early_media:!!(d.status?.real_early_media || d.media_backend==="carrier_rtp" || d.media_backend==="sip_bridge"), rtp_ready:!!d.rtp_ready, media_rate:d.media_rate || 8000, media_uplink_rate:d.media_uplink_rate || 8000, cellular_voice_rate:d.cellular_voice_rate || d.status?.cellular_voice_rate || 0, wideband_volte:!!(d.wideband_volte || d.status?.wideband_volte), voice_codec:d.voice_codec || d.status?.voice_codec || null, media_stats:d.media_stats || emptyMediaStats(), events:d.events || [], connected:!!d.socket, last_seen:d.last_seen }; }
function command(id, type, payload) { const d=devices.get(id); if (!d?.socket || d.socket.readyState !== 1) return false; const item={protocol_version:"airsim.air8000.v1",message_id:crypto.randomUUID(),device_id:id,timestamp:Date.now(),nonce:crypto.randomUUID(),type:"command."+type,payload}; d.socket.send(JSON.stringify(item)); commands.set(item.message_id,{...item,created_at:Date.now()}); return item.message_id; }
function issueMediaTicket(deviceID) { const ticket=crypto.randomBytes(24).toString("base64url"); mediaTickets.set(ticket,{device_id:deviceID,expires:Date.now()+60000}); return ticket; }
function emptyMediaStats() {
  return {
    uplink_frames:0,uplink_bytes:0,downlink_frames:0,downlink_bytes:0,
    dropped_downlink_frames:0,rtp_rx_packets:0,rtp_tx_packets:0,rtp_tx_errors:0,
    rtp_lost_packets:0,rtp_late_packets:0,rtp_duplicate_packets:0,
    rtp_reordered_packets:0,rtp_jitter_ms:0,audio_concealment_frames:0,
    uplink_dropped_frames:0,last_activity:Date.now()
  };
}
function rtpSeqDelta(a,b) {
  let d=((a&0xffff)-(b&0xffff))&0xffff;
  if(d>0x7fff)d-=0x10000;
  return d;
}
function resetMediaStats(deviceID) {
  const stats=emptyMediaStats();
  mediaStats.set(deviceID,stats);
  const device=devices.get(deviceID);
  if(device)device.media_stats=stats;
  return stats;
}
function getMediaStats(deviceID) {
  let stats=mediaStats.get(deviceID);
  if(!stats)stats=resetMediaStats(deviceID);
  return stats;
}
function firstLanIPv4() {
  for(const entries of Object.values(os.networkInterfaces())){
    for(const item of entries||[]){
      if(item && item.family==="IPv4" && !item.internal)return item.address;
    }
  }
  return "";
}
function rtpAdvertiseHost() {
  return RTP_PUBLIC_HOST || (LAN_MODE ? firstLanIPv4() : "");
}
function carrierRtpEnabled(device) {
  return !!(device && (device.media_backend==="carrier_rtp" || device.status?.media_backend==="carrier_rtp"));
}
function sipBridgeEnabled(device) {
  return !!(device && (device.media_backend==="sip_bridge" || device.status?.media_backend==="sip_bridge"));
}
function rtpMediaEnabled(device) { return carrierRtpEnabled(device) || sipBridgeEnabled(device); }
function rtpControlMessage(device,payload) {
  return {
    protocol_version:"airsim.air8000.v1",
    message_id:crypto.randomUUID(),
    device_id:device.device_id,
    timestamp:Date.now(),
    nonce:crypto.randomUUID(),
    type:"media.rtp_config",
    payload,
  };
}
function sendRtpConfig(device,session) {
  if(!device?.socket || device.socket.readyState!==1 || !session)return false;
  const host=rtpAdvertiseHost();
  if(!host)return false;
  const payload={host,port:session.port,codec:"PCMU",sample_rate:8000,ptime:20,generation:session.generation};
  device.socket.send(JSON.stringify(rtpControlMessage(device,payload)));
  device.rtp_ready=false;
  return true;
}
function bindUdp(socket,port) {
  return new Promise((resolve,reject)=>{
    const onError=err=>{socket.off("listening",onListen);reject(err)};
    const onListen=()=>{socket.off("error",onError);resolve()};
    socket.once("error",onError);
    socket.once("listening",onListen);
    socket.bind(port,"0.0.0.0");
  });
}
async function ensureRtpSession(deviceID) {
  let existing=rtpSessions.get(deviceID);
  if(existing)return existing;
  const host=rtpAdvertiseHost();
  if(!host)throw Error("RTP_PUBLIC_HOST is required for carrier RTP media outside LAN mode");

  let socket=null,port=0;
  for(let i=0;i<RTP_PORT_COUNT;i++){
    const candidate=RTP_PORT_BASE+i;
    if(usedRtpPorts.has(candidate))continue;
    const attempt=dgram.createSocket("udp4");
    try{
      await bindUdp(attempt,candidate);
      socket=attempt;port=candidate;usedRtpPorts.add(candidate);break;
    }catch(err){
      try{attempt.close()}catch{}
      if(err?.code!=="EADDRINUSE")throw err;
    }
  }
  if(!socket)throw Error("no free RTP UDP port in configured range");

  const session={
    device_id:deviceID,
    socket,
    port,
    remote:null,
    generation:1,
    tx:randomRtpState(crypto.randomBytes),
    txStarted:false,
    pendingUplink:Buffer.alloc(0),
    lastRx:0,
    rxQueue:new Map(),
    rxExpected:null,
    rxStarted:false,
    rxWarmupFrames:6,
    lastArrivalMs:0,
    lastRtpTimestamp:null,
    jitterMs:0,
    rxTimer:null,
    txTimer:null,
  };
  rtpSessions.set(deviceID,session);
  session.rxTimer=setInterval(()=>playoutCarrierDownlink(session),20);
  session.txTimer=setInterval(()=>flushCarrierUplink(session),20);

  socket.on("message",(packet,rinfo)=>{
    const parsed=parseRtpPacket(packet);
    if(!parsed || parsed.payloadType!==0 || parsed.payload.length===0)return;
    const now=Date.now();
    session.remote={address:rinfo.address,port:rinfo.port};
    session.lastRx=now;

    const stats=getMediaStats(deviceID);
    stats.rtp_rx_packets++;
    stats.last_activity=now;
    if(stats.rtp_rx_packets===1)console.log(`RTP received device=${deviceID} bytes=${parsed.payload.length} from=${rinfo.address}:${rinfo.port}`);

    if(session.lastArrivalMs && session.lastRtpTimestamp!==null){
      const arrivalDelta=now-session.lastArrivalMs;
      const rtpDelta=((parsed.timestamp-session.lastRtpTimestamp)>>>0)/8;
      if(rtpDelta<1000){
        const variation=Math.abs(arrivalDelta-rtpDelta);
        session.jitterMs += (variation-session.jitterMs)/16;
        stats.rtp_jitter_ms=Math.round(session.jitterMs*10)/10;
      }
    }
    session.lastArrivalMs=now;
    session.lastRtpTimestamp=parsed.timestamp;

    if(session.rxExpected===null)session.rxExpected=parsed.sequence;
    const delta=rtpSeqDelta(parsed.sequence,session.rxExpected);
    if(delta<0){
      stats.rtp_late_packets++;
      return;
    }
    if(session.rxQueue.has(parsed.sequence)){
      stats.rtp_duplicate_packets++;
      return;
    }
    if(delta>0)stats.rtp_reordered_packets++;
    session.rxQueue.set(parsed.sequence,parsed.payload);
    if(!session.rxStarted && session.rxQueue.size>=session.rxWarmupFrames)session.rxStarted=true;

    const device=devices.get(deviceID);
    if(device){
      device.media_transport=sipBridgeEnabled(device)?"sip_rtp":"carrier_rtp";
      device.media_rate=8000;
      device.media_uplink_rate=8000;
      device.rtp_ready=true;
    }
  });
  socket.on("error",err=>console.error(`RTP socket error device=${deviceID} port=${port}: ${err.message}`));
  console.log(`RTP listener device=${deviceID} udp=${port} advertise=${host}`);
  return session;
}

const sipServer = new SipUdpServer({
  port: SIP_PORT,
  domain: process.env.SIP_DOMAIN || "airsim.local",
  advertiseHost: rtpAdvertiseHost(),
  onRegister(registration) {
    const device = devices.get(registration.device_id);
    if (device) device.sip_registration = { address: registration.address, port: registration.port, expires_at: registration.expires_at };
  },
  onMedia(event) {
    const session = event.session;
    if (!session || !event.device_id) return;
    session.remote = event.remote;
    const device = devices.get(event.device_id);
    if (device) {
      device.media_transport = "sip_rtp";
      device.media_rate = 8000;
      device.media_uplink_rate = 8000;
      device.rtp_ready = true;
    }
    console.log(`SIP media ${event.type} device=${event.device_id} rtp=${event.remote.address}:${event.remote.port}`);
  },
  onState(event) {
    if (event.type === "dial" || event.type === "progress" || event.type === "connected" || event.type === "ended" || event.type === "failed") {
      console.log(`SIP call ${event.type} device=${event.device_id}`);
    }
  },
});

function resetRtpSession(session) {
  session.generation++;
  session.remote=null;
  session.tx=randomRtpState(crypto.randomBytes);
  session.txStarted=false;
  session.pendingUplink=Buffer.alloc(0);
  session.lastRx=0;
  session.rxQueue.clear();
  session.rxExpected=null;
  session.rxStarted=false;
  session.lastArrivalMs=0;
  session.lastRtpTimestamp=null;
  session.jitterMs=0;
}
function playoutCarrierDownlink(session) {
  if(!session)return;
  const stats=getMediaStats(session.device_id);
  if(!session.rxStarted){
    if(session.rxQueue.size<session.rxWarmupFrames)return;
    session.rxStarted=true;
  }
  if(session.rxExpected===null)return;

  if(Date.now()-session.lastRx>500 && session.rxQueue.size===0){
    session.rxStarted=false;
    session.rxExpected=null;
    return;
  }

  const payload=session.rxQueue.get(session.rxExpected);
  let pcm;
  if(payload){
    session.rxQueue.delete(session.rxExpected);
    pcm=decodePcmuPayload(payload);
    stats.downlink_frames++;
    stats.downlink_bytes+=pcm.length;
  }else{
    pcm=Buffer.alloc(320);
    stats.rtp_lost_packets++;
    stats.audio_concealment_frames++;
  }
  session.rxExpected=(session.rxExpected+1)&0xffff;
  stats.last_activity=Date.now();

  // Keep the browser clocked at exactly one 20 ms frame per tick. The
  // WebAudio side adds its own short playout buffer, so UDP arrival jitter
  // never directly controls speaker scheduling.
  const peer=mediaPeers.get(session.device_id);
  if(peer?.readyState===1)peer.send(pcm,{binary:true});
  else stats.dropped_downlink_frames++;
}
function flushCarrierUplink(session) {
  if(!session?.remote || session.pendingUplink.length<320)return;
  const stats=getMediaStats(session.device_id);
  const pcm=session.pendingUplink.subarray(0,320);
  session.pendingUplink=session.pendingUplink.subarray(320);
  const encoded=encodePcmuFrame(pcm);
  const packet=buildRtpPacket(encoded,session.tx,0,!session.txStarted);
  session.txStarted=true;
  session.socket.send(packet,session.remote.port,session.remote.address,err=>{
    if(err)stats.rtp_tx_errors++;
  });
  stats.rtp_tx_packets++;
  stats.uplink_frames++;
  stats.uplink_bytes+=pcm.length;
  stats.last_activity=Date.now();
}
function sendPcmToCarrier(deviceID,raw) {
  const session=rtpSessions.get(deviceID);
  if(!session)return false;
  const data=Buffer.isBuffer(raw)?raw:Buffer.from(raw);
  if(data.length===0)return true;
  session.pendingUplink=Buffer.concat([session.pendingUplink,data]);
  const max=320*12; // 240 ms hard ceiling; normal target stays below 80 ms.
  if(session.pendingUplink.length>max){
    const drop=session.pendingUplink.length-max;
    const aligned=Math.ceil(drop/320)*320;
    session.pendingUplink=session.pendingUplink.subarray(Math.min(aligned,session.pendingUplink.length));
    getMediaStats(deviceID).uplink_dropped_frames+=Math.ceil(drop/320);
  }
  return true;
}

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
    if (req.method === "POST" && mediaMatch) {
      const id=decodeURIComponent(mediaMatch[1]);
      const d=devices.get(id);
      if(!d?.socket || d.socket.readyState!==1)return json(res,409,{error:"device offline"});
      resetMediaStats(id);
      if(rtpMediaEnabled(d)){
        const session=await ensureRtpSession(id);
        resetRtpSession(session);
        if(carrierRtpEnabled(d)){
          if(!sendRtpConfig(d,session))return json(res,503,{error:"carrier RTP host is not configured"});
          d.media_transport="carrier_rtp";
        } else {
          if(!sipServer.registration(id))return json(res,409,{error:"device SIP registration is not ready"});
          d.media_transport="sip_rtp";
        }
        d.media_rate=8000;
        d.media_uplink_rate=8000;
      }
      const ticket=issueMediaTicket(id);
      const proto=String(req.headers["x-forwarded-proto"]||"http").split(",")[0];
      return json(res,201,{
        expires_in:60,
        sample_rate:d.media_rate||8000,
        downlink_sample_rate:d.media_rate||8000,
        uplink_sample_rate:rtpMediaEnabled(d)?8000:(d.media_uplink_rate||16000),
        transport:rtpMediaEnabled(d)?(carrierRtpEnabled(d)?"carrier_rtp":"sip_rtp"):"websocket_pcm",
        real_early_media:carrierRtpEnabled(d) || sipBridgeEnabled(d),
        ws_url:`${proto==="https"?"wss":"ws"}://${req.headers.host}/media?ticket=${encodeURIComponent(ticket)}`
      });
    }
    if (req.method === "POST" && match) {
      const value=await body(req); const id=decodeURIComponent(match[1]);
      if (!["dial","answer","reject","hangup","dtmf","send_sms","gps_request","wifi_config","wifi_connect","wifi_disconnect"].includes(value.type)) return json(res,400,{error:"unsupported command"});
      const d=devices.get(id);
      if(value.type==="dial" && sipBridgeEnabled(d)){
        try {
          const session=await ensureRtpSession(id);
          resetRtpSession(session);
          const result=await sipServer.invite(d,value.payload?.number,session);
          return json(res,202,{accepted:true,command_id:result.command_id});
        } catch(e) { return json(res,409,{error:e.message}); }
      }
      if(value.type==="hangup" && sipBridgeEnabled(d)){
        // Tear down both legs from the first click.  Both operations are
        // idempotent: the device stops cellular CC and exsip stops its SIP
        // leg, while the gateway closes any outstanding SIP transaction.
        const commandID=command(id,"hangup",value.payload||{});
        const sipAccepted=sipServer.hangup(id);
        if(commandID||sipAccepted)return json(res,202,{accepted:true,command_id:commandID||crypto.randomUUID()});
      }
      const commandID=command(id,value.type,value.payload||{}); return commandID ? json(res,202,{accepted:true,command_id:commandID}) : json(res,409,{error:"device offline"});
    }
    return json(res,404,{error:"not found"});
  } catch (e) { return json(res,400,{error:e.message}); }
});

const wss=new WebSocketServer({noServer:true});
const mediaWss=new WebSocketServer({noServer:true});
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
  mediaPeers.set(deviceID,ws);
  const stats=getMediaStats(deviceID);
  const device=devices.get(deviceID); if(device)device.media_stats=stats;
  console.log(`media connected device=${deviceID} transport=${rtpMediaEnabled(device)?(carrierRtpEnabled(device)?"carrier_rtp":"sip_rtp"):"websocket_pcm"}`);
  ws.on("message",(raw,isBinary)=>{
    if(!isBinary)return;
    const d=devices.get(deviceID);
    if(rtpMediaEnabled(d)){
      if(!sendPcmToCarrier(deviceID,raw))stats.rtp_tx_errors++;
      return;
    }
    stats.uplink_frames++; stats.uplink_bytes+=raw.length; stats.last_activity=Date.now();
    if(stats.uplink_frames===1)console.log(`media uplink device=${deviceID} bytes=${raw.length}`);
    if(d?.socket?.readyState===1)d.socket.send(raw,{binary:true});
  });
  ws.on("close",()=>{
    if(mediaPeers.get(deviceID)===ws)mediaPeers.delete(deviceID);
    console.log(`media disconnected device=${deviceID}`);
  });
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
          location: identity.status?.location || null,
          wifi: identity.status?.wifi || null,
          media_backend: identity.status?.media_backend || null,
          media_transport: identity.status?.media_backend === "carrier_rtp" ? "carrier_rtp" : identity.status?.media_backend === "sip_bridge" ? "sip_rtp" : "websocket_pcm",
          media_rate: 8000,
          media_uplink_rate: identity.status?.media_backend === "carrier_rtp" || identity.status?.media_backend === "sip_bridge" ? 8000 : 16000,
          media_stats: emptyMediaStats(),
          rtp_ready: false,
          events: [],
          socket: ws,
          last_seen: Date.now(),
          authentication: mTLS ? "mtls" : auto ? "auto_enroll" : "device_secret",
        };
        devices.set(device.device_id, device);
        ws.send(JSON.stringify({ type: "device.register.ack", device_id: device.device_id, protocol_version: "airsim.air8000.v1", authentication: device.authentication }));
        if(carrierRtpEnabled(device)){
          ensureRtpSession(device.device_id).then(session=>sendRtpConfig(device,session)).catch(err=>{
            console.error(`carrier RTP setup failed device=${device.device_id}: ${err.message}`);
          });
        }
        console.log(`Air8000 device active: ${device.device_id} media=${device.media_backend||"direct_pcm"}`);
        return;
      }
      device.last_seen = Date.now();
      if (msg.type === "device.location" || msg.type === "event.location") {
        device.location=msg.payload || msg.location;
        device.status={...(device.status||{}),location:device.location,gnss_state:device.location?.fix_state || device.status?.gnss_state};
      }
      if (msg.type === "device.status" || msg.type === "event.status") {
        device.status=msg.payload || msg.status || {};
        if(device.status.location)device.location=device.status.location;
        if(device.status.wifi)device.wifi=device.status.wifi;
      }
      if (msg.type === "device.wifi" || msg.type === "event.wifi") {
        device.wifi=msg.payload || msg.wifi;
        device.status={...(device.status||{}),wifi:device.wifi,wifi_state:device.wifi?.state || device.status?.wifi_state};
      }
      if (msg.type === "device.command_result" && msg.payload?.payload?.fix_state) device.location = msg.payload.payload;
      if (msg.type === "media.open" || msg.type === "media.ready" || msg.type === "media.early") {
        device.media_rate=Number(msg.payload?.downlink_sample_rate || msg.payload?.sample_rate) || 8000;
        device.media_uplink_rate=Number(msg.payload?.uplink_sample_rate) || (rtpMediaEnabled(device)?8000:16000);
        if(msg.payload?.backend)device.media_backend=msg.payload.backend;
        if(msg.payload?.transport)device.media_transport=msg.payload.transport;
        if(Number(msg.payload?.cellular_sample_rate)>0){
          device.cellular_voice_rate=Number(msg.payload.cellular_sample_rate);
          device.wideband_volte=device.cellular_voice_rate>=16000;
          device.voice_codec=msg.payload?.cellular_codec || (device.wideband_volte?"AMR-WB":"AMR-NB");
        }
      }
      if (msg.type === "media.voice_quality") {
        const rate=Number(msg.payload?.cellular_sample_rate)||0;
        if(rate>0){
          device.cellular_voice_rate=rate;
          device.wideband_volte=msg.payload?.wideband_volte===true || rate>=16000;
          device.voice_codec=msg.payload?.voice_codec || (device.wideband_volte?"AMR-WB":"AMR-NB");
          device.status={...(device.status||{}),cellular_voice_rate:rate,wideband_volte:device.wideband_volte,voice_codec:device.voice_codec};
        }
      }
      if (msg.type === "media.rtp_config.ack") device.rtp_ready = msg.payload?.ok === true;
      if (["call.state", "call.media", "sms.received", "sms.sent", "device.command_result", "device.wifi", "device.location", "media.open", "media.early", "media.phase", "media.voice_quality"].includes(msg.type)) {
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
server.listen(PORT,()=>{
  console.log(`AirSIM Air8000 VPS gateway listening on ${PORT}`);
  const host=rtpAdvertiseHost();
  console.log(host?`Carrier RTP: ${host} UDP ${RTP_PORT_BASE}-${RTP_PORT_BASE+RTP_PORT_COUNT-1}`:"Carrier RTP disabled: set RTP_PUBLIC_HOST");
  sipServer.start().then(()=>console.log(`SIP UDP registrar listening on ${SIP_PORT}`)).catch(err=>console.error(`SIP UDP unavailable on ${SIP_PORT}: ${err.message}`));
});
