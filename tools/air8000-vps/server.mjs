import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import dgram from "node:dgram";
import { WebSocketServer } from "ws";
import { buildRtpPacket, createDecimator2x, createInterpolator2x, decodePcmuPayload, encodePcmuFrame, parseRtpPacket, randomRtpState } from "./rtp-pcm.mjs";
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
const SERVER_INSTANCE_ID = crypto.randomUUID();
const registry = JSON.parse(process.env.DEVICE_REGISTRY_JSON || "{}");
const devices = new Map();
const commands = new Map();
const mediaTickets = new Map();
const mediaPeers = new Map();
const mediaStats = new Map();
const rtpSessions = new Map();
const usedRtpPorts = new Set();
const MEDIA_FRAME_MS = 20;
const MEDIA_MAX_CATCHUP_FRAMES = 5;
const PCMU_FRAME_BYTES = 320; // 160 S16LE samples at 8 kHz
const SILENT_PCMU_FRAME = Buffer.alloc(PCMU_FRAME_BYTES);
function concealPcm16(previous, frameIndex) {
  if (!previous || previous.length!==PCMU_FRAME_BYTES) return SILENT_PCMU_FRAME;
  const gain=Math.max(0,1-(frameIndex/5));
  const out=Buffer.allocUnsafe(previous.length);
  for(let i=0;i<previous.length;i+=2){
    out.writeInt16LE(Math.round(previous.readInt16LE(i)*gain),i);
  }
  return out;
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a || "")); const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function admin(req) { return sameSecret((req.headers.authorization || "").replace(/^Bearer\s+/i, ""), ADMIN_TOKEN); }
function json(res, status, value) { const body = JSON.stringify(value); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }); res.end(body); }
async function body(req) { let raw=""; for await (const chunk of req) { raw += chunk; if (raw.length > 65536) throw Error("body too large"); } return JSON.parse(raw || "{}"); }
function publicDevice(d) { return { device_id:d.device_id, serial_number:d.serial_number, imei:d.imei, device_type:d.device_type, hardware_model:d.hardware_model, firmware:d.firmware, capabilities:d.capabilities, status:d.status, location:d.location || d.status?.location || null, wifi:d.wifi || d.status?.wifi || null, media_backend:d.media_backend || d.status?.media_backend || null, media_phase:d.media_phase || d.status?.media_phase || "IDLE", media_transport:d.media_transport || null, real_early_media:!!(d.status?.real_early_media || d.media_backend==="carrier_rtp" || d.media_backend==="sip_bridge"), rtp_ready:!!d.rtp_ready, media_rate:d.media_rate || 8000, media_uplink_rate:d.media_uplink_rate || 8000, cellular_voice_rate:d.cellular_voice_rate || d.status?.cellular_voice_rate || 0, wideband_volte:!!(d.wideband_volte || d.status?.wideband_volte), voice_codec:d.voice_codec || d.status?.voice_codec || null, media_stats:d.media_stats || emptyMediaStats(), media_recovery_count:d.media_recovery_count||0, server_instance_id:SERVER_INSTANCE_ID, events:d.events || [], connected:!!d.socket, last_seen:d.last_seen }; }
function command(id, type, payload) { const d=devices.get(id); if (!d?.socket || d.socket.readyState !== 1) return false; const item={protocol_version:"airsim.air8000.v1",message_id:crypto.randomUUID(),device_id:id,timestamp:Date.now(),nonce:crypto.randomUUID(),type:"command."+type,payload}; d.socket.send(JSON.stringify(item)); commands.set(item.message_id,{...item,created_at:Date.now()}); return item.message_id; }
function issueMediaTicket(deviceID) { const ticket=crypto.randomBytes(24).toString("base64url"); mediaTickets.set(ticket,{device_id:deviceID,expires:Date.now()+60000}); return ticket; }
function emptyMediaStats() {
  return {
    uplink_frames:0,uplink_bytes:0,downlink_frames:0,downlink_bytes:0,
    dropped_downlink_frames:0,rtp_rx_packets:0,rtp_tx_packets:0,rtp_tx_errors:0,
    rtp_lost_packets:0,rtp_late_packets:0,rtp_duplicate_packets:0,
    rtp_reordered_packets:0,rtp_jitter_ms:0,audio_concealment_frames:0,rtp_idle_frames:0,
    rtp_stream_resets:0,rtp_latency_trim_frames:0,uplink_underrun_frames:0,
    uplink_dropped_frames:0,last_activity:Date.now(),
    downlink_peak:0,downlink_rms:0,downlink_silent_frames:0,downlink_clipped_frames:0,
    uplink_peak:0,uplink_rms:0,uplink_silent_frames:0,uplink_clipped_frames:0
  };
}
function updatePcmMetrics(stats,prefix,pcm){
  let peak=0,sum=0,clipped=0;
  for(let i=0;i+1<pcm.length;i+=2){
    const sample=pcm.readInt16LE(i); const abs=Math.abs(sample);
    if(abs>peak)peak=abs; if(abs>=32760)clipped++; sum+=sample*sample;
  }
  const samples=pcm.length>>1; if(!samples)return;
  stats[`${prefix}_peak`]=Math.max(stats[`${prefix}_peak`],peak);
  stats[`${prefix}_rms`]=Math.round(Math.sqrt(sum/samples));
  if(peak<256)stats[`${prefix}_silent_frames`]++;
  if(clipped)stats[`${prefix}_clipped_frames`]++;
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
function nativePcmEnabled(device) { return device?.media_transport === "direct_pcm" || device?.media_transport === "wideband_pcm"; }
function rtpMediaEnabled(device) { return !nativePcmEnabled(device) && (carrierRtpEnabled(device) || sipBridgeEnabled(device)); }
function activeCellularCall(device) {
  const call=device?.status?.active_call;
  if(!call || typeof call!=="object")return null;
  const state=String(call.state||"").toUpperCase();
  if(!state || ["IDLE","ENDED","FAILED","DISCONNECTED"].includes(state))return null;
  return call;
}
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
    txPrimed:false,
    txPrimeFrames:3,
    uplinkActive:false,
    pendingUplink:Buffer.alloc(0),
    // Streaming resamplers keep filter history across 20 ms frames.
    upsample:createInterpolator2x(),
    downsample:createDecimator2x(),
    lastRx:0,
    rxQueue:new Map(),
    rxExpected:null,
    rxSsrc:null,
    rxGapOpen:false,
    rxStarted:false,
    // The Air8000 SIP bridge can deliver several RTP packets in a burst.
    // Keep enough media queued to absorb that burst before clocking the
    // browser at one 20 ms frame per tick.
    // LAN Wi-Fi tests have measured roughly 190 ms of jitter. Keep more than
    // that in the startup cushion so a burst is not played as repeated gaps.
    rxWarmupFrames:16,
    rxHoldMs:800,
    rxMissingGraceMs:80,
    targetDelayMs:320,
    rxMissingSince:0,
    lastPcm8:null,
    concealFrames:0,
    lastArrivalMs:0,
    lastRtpTimestamp:null,
    jitterMs:0,
    // One monotonic media clock drives both directions. Node/Windows timers
    // fire late (49.5/s measured for a 20 ms interval on Linux, worse on
    // Windows), so each tick processes every 20 ms frame that is due instead
    // of exactly one frame per callback.
    clockStart:performance.now(),
    rxClock:0,
    txClock:0,
    mediaTimer:null,
  };
  rtpSessions.set(deviceID,session);
  session.mediaTimer=setInterval(()=>pumpCarrierMedia(session),10);

  socket.on("message",(packet,rinfo)=>{
    const parsed=parseRtpPacket(packet);
    if(!parsed || parsed.payloadType!==0 || parsed.payload.length===0)return;
    const now=Date.now();
    session.remote={address:rinfo.address,port:rinfo.port};
    session.lastRx=now;
    const streamStart=session.rxExpected===null;

    const stats=getMediaStats(deviceID);
    stats.rtp_rx_packets++;
    stats.last_activity=now;
    if(streamStart){
      // The media ticket can exist long before the modem sends its first RTP
      // packet. Align the playout clock here; otherwise mediaFramesDue() tries
      // to catch up the stale ticket clock in bursts.
      session.clockStart=performance.now();
      session.rxClock=0;
      session.txClock=0;
      console.log(`RTP received device=${deviceID} bytes=${parsed.payload.length} from=${rinfo.address}:${rinfo.port}`);
    }

    if(session.lastArrivalMs && session.lastRtpTimestamp!==null){
      const arrivalDelta=now-session.lastArrivalMs;
      const rtpDelta=((parsed.timestamp-session.lastRtpTimestamp)>>>0)/8;
      if(rtpDelta<1000){
        const variation=Math.abs(arrivalDelta-rtpDelta);
        session.jitterMs += (variation-session.jitterMs)/16;
        stats.rtp_jitter_ms=Math.round(session.jitterMs*10)/10;
        // WebRTC-style adaptive jitter target: keep a bounded cushion above
        // the measured network variation, but never let the startup buffer
        // consume the entire latency budget.
        session.targetDelayMs=Math.max(240,Math.min(640,Math.ceil((session.jitterMs*2+80)/20)*20));
        session.rxWarmupFrames=Math.max(12,Math.min(28,Math.ceil(session.targetDelayMs/20)));
      }
    }
    session.lastArrivalMs=now;
    session.lastRtpTimestamp=parsed.timestamp;

    // A restarted device VoIP engine sends a new SSRC/sequence space. Resync
    // instead of discarding the new stream as "late" or waiting on a huge gap.
    const jumped=session.rxExpected!==null && Math.abs(rtpSeqDelta(parsed.sequence,session.rxExpected))>100;
    if(session.rxExpected!==null && (jumped || (session.rxSsrc!==null && parsed.ssrc!==session.rxSsrc))){
      resyncCarrierDownlink(session);
      stats.rtp_stream_resets++;
    }
    session.rxSsrc=parsed.ssrc;
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
    if (event.type === "dial" || event.type === "resume" || event.type === "progress" || event.type === "connected" || event.type === "ended" || event.type === "failed") {
      console.log(`SIP call ${event.type} device=${event.device_id}`);
    }
    if (event.type === "failed" || event.type === "ended") {
      // Native carrier failure/remote release is authoritative. Ensure the
      // browser and SIP dialog are released even if the device-side SIP
      // teardown notification is delayed or absent.
      sipServer.hangup(event.device_id);
      releaseRtpMedia(event.device_id);
      const peer=mediaPeers.get(event.device_id);
      if(peer?.readyState===1)peer.close(4001,"carrier call ended");
    }
  },
});

function resyncCarrierDownlink(session) {
  session.rxQueue.clear();
  session.rxExpected=null;
  session.rxSsrc=null;
  session.rxGapOpen=false;
  session.rxStarted=false;
  session.rxMissingSince=0;
  session.lastPcm8=null;
  session.concealFrames=0;
  session.lastArrivalMs=0;
  session.lastRtpTimestamp=null;
}
function resetCarrierUplink(session) {
  session.txPrimed=false;
  session.uplinkActive=false;
  session.pendingUplink=Buffer.alloc(0);
  session.downsample=createDecimator2x();
}
function resetRtpSession(session) {
  session.generation++;
  session.clockStart=performance.now();
  session.rxClock=0;
  session.txClock=0;
  session.remote=null;
  session.tx=randomRtpState(crypto.randomBytes);
  session.txStarted=false;
  resetCarrierUplink(session);
  session.lastRx=0;
  resyncCarrierDownlink(session);
  session.upsample=createInterpolator2x();
  session.jitterMs=0;
}
// Stop RTP toward the device once the carrier call is gone; the next dial or
// resume allocates a fresh RTP generation.
function releaseRtpMedia(deviceID) {
  const session=rtpSessions.get(deviceID);
  if(session)resetRtpSession(session);
}
function mediaFramesDue(session,key) {
  const target=Math.floor((performance.now()-session.clockStart)/MEDIA_FRAME_MS);
  let due=target-session[key];
  // After an event-loop stall, do not burst an unbounded backlog; the jitter
  // buffer latency trim absorbs the remainder.
  if(due>MEDIA_MAX_CATCHUP_FRAMES){session[key]=target-MEDIA_MAX_CATCHUP_FRAMES;due=MEDIA_MAX_CATCHUP_FRAMES}
  if(due<=0)return 0;
  session[key]+=due;
  return due;
}
function pumpCarrierMedia(session) {
  for(let n=mediaFramesDue(session,"rxClock");n>0;n--)playoutCarrierDownlink(session);
  for(let n=mediaFramesDue(session,"txClock");n>0;n--)flushCarrierUplink(session);
}
function lowestQueuedSequence(session) {
  let best=null,bestDelta=Infinity;
  for(const seq of session.rxQueue.keys()){
    const d=rtpSeqDelta(seq,session.rxExpected);
    if(d>=0 && d<bestDelta){best=seq;bestDelta=d}
  }
  return best;
}
function playoutCarrierDownlink(session) {
  if(!session)return;
  const stats=getMediaStats(session.device_id);
  const now=Date.now();
  if(!session.rxStarted){
    if(session.rxQueue.size<session.rxWarmupFrames)return;
    session.rxStarted=true;
  }
  if(session.rxExpected===null)return;

  if(now-session.lastRx>500 && session.rxQueue.size===0){
    session.rxStarted=false;
    session.rxExpected=null;
    session.rxGapOpen=false;
    session.rxMissingSince=0;
    return;
  }

  // Bound mouth-to-ear delay. Clock drift or a burst after a Wi-Fi stall must
  // not accumulate latency for the rest of the call.
  if(session.rxQueue.size>Math.ceil(session.rxHoldMs/MEDIA_FRAME_MS)){
    while(session.rxQueue.size>session.rxWarmupFrames){
      const oldest=lowestQueuedSequence(session);
      if(oldest===null)break;
      session.rxQueue.delete(oldest);
      session.rxExpected=(oldest+1)&0xffff;
      stats.rtp_latency_trim_frames++;
    }
    session.rxGapOpen=false;
    session.rxMissingSince=0;
  }

  const payload=session.rxQueue.get(session.rxExpected);
  let pcm8;
  let advanceSequence=true;
  if(payload){
    session.rxQueue.delete(session.rxExpected);
    session.rxMissingSince=0;
    session.rxGapOpen=false;
    pcm8=decodePcmuPayload(payload);
    session.lastPcm8=pcm8;
    session.concealFrames=0;
  }else if(session.rxQueue.size===0){
    // No later packet means no sequence gap has been proven. This is an idle
    // carrier period, not packet loss; keep the browser clocked but retain
    // rxExpected so the next RTP packet is not misclassified as late.
    pcm8=SILENT_PCMU_FRAME;
    stats.rtp_idle_frames++;
    advanceSequence=false;
  }else{
    // Do not repeat carrier audio: give a late packet a short chance to arrive
    // before declaring loss. Once a gap is proven, every remaining missing
    // sequence in that gap is concealed on its own tick without a new grace
    // wait, so one lost packet costs one 20 ms frame rather than several.
    if(!session.rxMissingSince)session.rxMissingSince=now;
    const declared=session.rxGapOpen || now-session.rxMissingSince>=session.rxMissingGraceMs;
    pcm8=declared?concealPcm16(session.lastPcm8,session.concealFrames):session.lastPcm8 || SILENT_PCMU_FRAME;
    if(declared){
      stats.rtp_lost_packets++;
      stats.audio_concealment_frames++;
      session.rxGapOpen=true;
      session.concealFrames++;
    } else {
      advanceSequence=false;
    }
  }
  if(advanceSequence)session.rxExpected=(session.rxExpected+1)&0xffff;
  // Silence also runs through the interpolator so its filter rings out
  // smoothly instead of cutting speech with a click.
  const pcm=session.upsample(pcm8);
  if(payload){
    stats.downlink_frames++;
    stats.downlink_bytes+=pcm.length;
    updatePcmMetrics(stats,"downlink",pcm);
  }
  stats.last_activity=Date.now();

  // Keep the browser clocked at one 20 ms frame per due media tick. The
  // WebAudio side adds its own short playout buffer, so UDP arrival jitter
  // never directly controls speaker scheduling.
  const peer=mediaPeers.get(session.device_id);
  if(peer?.readyState===1)peer.send(pcm,{binary:true});
  else stats.dropped_downlink_frames++;
}
function flushCarrierUplink(session) {
  if(!session?.remote || !session.uplinkActive)return;
  const stats=getMediaStats(session.device_id);
  // Prime 60 ms before sending speech so browser frame jitter does not starve
  // the device jitter buffer. Underruns send PCMU silence to keep RTP timing
  // continuous instead of leaving holes the device cannot distinguish.
  if(!session.txPrimed && session.pendingUplink.length>=PCMU_FRAME_BYTES*session.txPrimeFrames)session.txPrimed=true;
  let pcm=SILENT_PCMU_FRAME;
  if(session.txPrimed && session.pendingUplink.length>=PCMU_FRAME_BYTES){
    pcm=session.pendingUplink.subarray(0,PCMU_FRAME_BYTES);
    session.pendingUplink=session.pendingUplink.subarray(PCMU_FRAME_BYTES);
  }else if(session.txPrimed){
    session.txPrimed=false;
    stats.uplink_underrun_frames++;
  }
  const encoded=encodePcmuFrame(pcm);
  const packet=buildRtpPacket(encoded,session.tx,0,!session.txStarted);
  session.txStarted=true;
  session.socket.send(packet,session.remote.port,session.remote.address,err=>{
    if(err)stats.rtp_tx_errors++;
  });
  stats.rtp_tx_packets++;
  if(pcm!==SILENT_PCMU_FRAME){
    stats.uplink_frames++;
    stats.uplink_bytes+=pcm.length;
    updatePcmMetrics(stats,"uplink",pcm);
  }
  stats.last_activity=Date.now();
}
function sendPcmToCarrier(deviceID,raw) {
  const session=rtpSessions.get(deviceID);
  if(!session)return false;
  const data=session.downsample(Buffer.isBuffer(raw)?raw:Buffer.from(raw));
  session.uplinkActive=true;
  if(data.length===0)return true;
  session.pendingUplink=Buffer.concat([session.pendingUplink,data]);
  const max=PCMU_FRAME_BYTES*12; // 240 ms hard ceiling
  if(session.pendingUplink.length>max){
    // Trim back to the 80 ms target, not to the ceiling, so a browser burst
    // does not leave a permanent 240 ms uplink delay.
    const keep=PCMU_FRAME_BYTES*4;
    const drop=session.pendingUplink.length-keep;
    session.pendingUplink=session.pendingUplink.subarray(drop);
    getMediaStats(deviceID).uplink_dropped_frames+=Math.ceil(drop/PCMU_FRAME_BYTES);
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
    if (req.method === "GET" && u.pathname === "/api/health") return json(res,200,{ok:true,service:"airsim-air8000-vps",devices:devices.size,server_instance_id:SERVER_INSTANCE_ID});
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
        if(carrierRtpEnabled(d)){
          resetRtpSession(session);
          if(!sendRtpConfig(d,session))return json(res,503,{error:"carrier RTP host is not configured"});
          d.media_transport="carrier_rtp";
        } else {
          if(!sipServer.registration(id))return json(res,409,{error:"device SIP registration is not ready"});
          const active=activeCellularCall(d);
          const existing=sipServer.call(id);
          // Do not clear session.remote when a healthy SIP dialog already
          // exists. Doing so used to make a browser reconnect permanently
          // mute an otherwise healthy cellular call.
          if(active && !existing){
            resetRtpSession(session);
            await sipServer.resume(d,session);
            d.media_recovery_count=(d.media_recovery_count||0)+1;
          }
          d.media_transport="sip_rtp";
        }
        d.media_rate=8000;
        d.media_uplink_rate=8000;
      }
      const ticket=issueMediaTicket(id);
      const proto=String(req.headers["x-forwarded-proto"]||"http").split(",")[0];
      const direct=nativePcmEnabled(d);
      const browserRate=direct ? (d.media_rate||8000) : (rtpMediaEnabled(d)?16000:(d.media_rate||8000));
      return json(res,201,{
        expires_in:60,
        sample_rate:browserRate,
        downlink_sample_rate:browserRate,
        // SIP/RTP remains PCMU/8000. The browser leg is PCM16/16000;
        // server-side resampling keeps both media contracts explicit.
        uplink_sample_rate:browserRate,
        browser_sample_rate:browserRate,
        transport:direct?"direct_pcm":rtpMediaEnabled(d)?(carrierRtpEnabled(d)?"carrier_rtp":"sip_rtp"):"websocket_pcm",
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
    if(mediaPeers.get(deviceID)===ws){
      mediaPeers.delete(deviceID);
      const session=rtpSessions.get(deviceID);
      if(session)resetCarrierUplink(session);
    }
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
          media_phase: identity.status?.media_phase || "IDLE",
          media_transport: identity.status?.media_transport || (identity.status?.media_backend === "carrier_rtp" ? "carrier_rtp" : identity.status?.media_backend === "sip_bridge" ? "sip_rtp" : "websocket_pcm"),
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
        ws.send(JSON.stringify({ type: "device.register.ack", device_id: device.device_id, protocol_version: "airsim.air8000.v1", authentication: device.authentication, server_instance_id: SERVER_INSTANCE_ID }));
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
      if (msg.type === "media.transport_change") {
        const p=msg.payload || {};
        const rate=Number(p.sample_rate || p.downlink_sample_rate);
        if(rate!==8000 && rate!==16000) throw Error("invalid media sample rate");
        if(Number(p.frame_bytes)!==rate*2*20/1000) throw Error("invalid media frame size");
        device.media_phase=p.phase || (p.to==="direct_pcm"?"DIRECT_PCM_CONNECTED":"IDLE");
        device.media_transport=String(p.to||"") || device.media_transport;
        device.media_rate=rate;
        device.media_uplink_rate=Number(p.uplink_sample_rate)||rate;
        device.cellular_voice_rate=rate;
        device.wideband_volte=p.wideband===true && rate===16000;
        device.voice_codec=p.cellular_codec || (device.wideband_volte?"AMR-WB":"AMR-NB");
        device.rtp_ready=false;
        const session=rtpSessions.get(device.device_id);
        if(session && p.from==="sip_rtp") resetRtpSession(session);
        const peer=mediaPeers.get(device.device_id);
        if(peer?.readyState===1) peer.send(JSON.stringify({type:"media.transport_change",payload:{...p,sample_rate:rate,frame_bytes:rate*2*20/1000}}));
      }
      if (msg.type === "call.state") {
        const event=String(msg.payload?.event||"");
        const call=msg.payload?.call;
        const ended=["ended","failed","hangup","reject","remote_hangup","disconnected"].includes(event);
        device.status={...(device.status||{}),active_call:ended?null:(call||device.status?.active_call||null)};
        if(ended){
          // Device-side carrier release is authoritative even when the SIP
          // peer has not sent BYE yet. Preserve the event, then tear down the
          // browser/SIP media session immediately.
          sipServer.hangup(device.device_id);
          if(sipBridgeEnabled(device))releaseRtpMedia(device.device_id);
          const peer=mediaPeers.get(device.device_id);
          if(peer?.readyState===1)peer.close(4001,"carrier call ended");
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
      if (["call.state", "call.media", "sms.received", "sms.sent", "device.command_result", "device.wifi", "device.location", "media.open", "media.early", "media.phase", "media.voice_quality", "media.transport_change"].includes(msg.type)) {
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
