import dgram from "node:dgram";
import crypto from "node:crypto";

function headerMap(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (out[name]) out[name] = `${out[name]}, ${value}`;
    else out[name] = value;
  }
  return out;
}

export function parseSip(packet) {
  const raw = Buffer.isBuffer(packet) ? packet.toString("utf8") : String(packet || "");
  const split = raw.search(/\r?\n\r?\n/);
  const head = split < 0 ? raw : raw.slice(0, split);
  const body = split < 0 ? "" : raw.slice(split).replace(/^\r?\n\r?\n/, "");
  const lines = head.split(/\r?\n/);
  const start = lines.shift() || "";
  const headers = headerMap(lines.join("\r\n"));
  const status = start.match(/^SIP\/2\.0\s+(\d+)\s*(.*)$/i);
  const request = start.match(/^([A-Z]+)\s+([^\s]+)\s+SIP\/2\.0$/i);
  return {
    raw, start, headers, body,
    isResponse: !!status,
    code: status ? Number(status[1]) : null,
    reason: status ? status[2] : "",
    method: request ? request[1].toUpperCase() : null,
    uri: request ? request[2] : null,
  };
}

function firstHeader(headers, name) {
  return String(headers[name] || "").split(/,\s*(?=<)/)[0].trim();
}

function userFromUri(value) {
  const match = String(value || "").match(/sip:([^@;>\s]+)/i);
  return match ? match[1] : "";
}

function tag(value) {
  const match = String(value || "").match(/;tag=([^;>\s]+)/i);
  return match ? match[1] : "";
}

function contactEndpoint(contact, fallback) {
  const match = String(contact || "").match(/sip:[^@>]+@([^:;>\s]+)(?::(\d+))?/i);
  return match ? { address: match[1], port: Number(match[2] || 5060) } : fallback;
}

export function parseSdp(body) {
  const address = String(body || "").match(/(?:^|\r?\n)c=IN IP4 ([^\r\n]+)/i)?.[1]?.trim();
  const port = String(body || "").match(/(?:^|\r?\n)m=audio\s+(\d+)\s+RTP\/AVP/i)?.[1];
  if (!address || !port || Number(port) < 1 || Number(port) > 65535) return null;
  return { address, port: Number(port) };
}

function sdpOffer(host, port) {
  const session = Math.floor(Math.random() * 0x7fffffff);
  return [
    "v=0",
    `o=airsim ${session} ${session} IN IP4 ${host}`,
    "s=AirSIM Air8000 bridge",
    `c=IN IP4 ${host}`,
    "t=0 0",
    `m=audio ${port} RTP/AVP 0`,
    "a=rtpmap:0 PCMU/8000",
    "a=ptime:20",
    "a=sendrecv",
    "",
  ].join("\r\n");
}

function compactCallId() {
  return `${crypto.randomBytes(12).toString("hex")}@airsim`;
}

export class SipUdpServer {
  constructor({ port = 5060, host = "0.0.0.0", domain = "airsim.local", advertiseHost, onRegister, onMedia, onState } = {}) {
    this.port = Number(port);
    this.host = host;
    this.domain = domain;
    this.advertiseHost = advertiseHost || "127.0.0.1";
    this.onRegister = onRegister || (() => {});
    this.onMedia = onMedia || (() => {});
    this.onState = onState || (() => {});
    this.socket = dgram.createSocket("udp4");
    this.registrations = new Map();
    this.calls = new Map();
    this.deviceCalls = new Map();
    this.socket.on("message", (packet, rinfo) => this.#message(packet, rinfo));
    this.socket.on("error", err => console.error(`SIP UDP error: ${err.message}`));
  }

  start() {
    return new Promise((resolve, reject) => {
      const onError = err => { this.socket.off("listening", onListen); reject(err); };
      const onListen = () => { this.socket.off("error", onError); resolve(); };
      this.socket.once("error", onError);
      this.socket.once("listening", onListen);
      this.socket.bind(this.port, this.host);
    });
  }

  registration(deviceId) {
    return [...this.registrations.values()].find(item => item.device_id === deviceId) || null;
  }

  call(deviceId) {
    return this.deviceCalls.get(deviceId) || null;
  }

  forget(deviceId) {
    const call=this.deviceCalls.get(deviceId);
    if(!call)return false;
    this.calls.delete(call.callId);
    this.deviceCalls.delete(deviceId);
    return true;
  }

  async invite(device, number, session) {
    return this.#invite(device, number, session, false);
  }

  async resume(device, session) {
    return this.#invite(device, "", session, true);
  }

  async #invite(device, number, session, resume) {
    if (!device?.device_id || !session) throw Error("device and RTP session are required");
    const registration = this.registration(device.device_id);
    if (!registration) throw Error("device SIP registration not found");

    // A replacement dialog intentionally forgets stale gateway state without
    // sending BYE. The Air8000 resume header tells the device to attach this
    // SIP media leg to its existing cellular call rather than dial again.
    if (resume) this.forget(device.device_id);
    else if (this.call(device.device_id)) throw Error("device already has an active SIP call");

    const callId = compactCallId();
    const branch = `z9hG4bK-${crypto.randomBytes(8).toString("hex")}`;
    const fromTag = crypto.randomBytes(6).toString("hex");
    const from = `<sip:gateway@${this.domain}>;tag=${fromTag}`;
    const to = `<sip:${registration.username}@${this.domain}>`;
    const requestUri = registration.contact || `sip:${registration.username}@${registration.address}:${registration.port}`;
    const body = sdpOffer(this.advertiseHost, session.port);
    const call = {
      device_id: device.device_id, number: String(number || ""), session, resume:!!resume,
      callId, branch, fromTag, from, to, requestUri,
      remote: { address: registration.address, port: registration.port },
      cseq: 1, state: "INVITING", established: false,
    };
    this.calls.set(callId, call);
    this.deviceCalls.set(device.device_id, call);
    this.#sendRequest(call, "INVITE", requestUri, [
      ["Via", `SIP/2.0/UDP ${this.advertiseHost}:${this.port};branch=${branch};rport`],
      ["Max-Forwards", "70"], ["From", from], ["To", to], ["Call-ID", callId],
      ["CSeq", `${call.cseq} INVITE`], ["Contact", `<sip:gateway@${this.advertiseHost}:${this.port}>`],
      ["Allow", "INVITE, ACK, CANCEL, BYE, OPTIONS"], ["Supported", "100rel"],
      resume ? ["X-AirSIM-Resume", "1"] : ["X-AirSIM-Number", call.number],
      ["Content-Type", "application/sdp"],
    ], body);
    this.onState({ type: resume ? "resume" : "dial", ...call });
    return { command_id: callId, resumed:!!resume };
  }

  hangup(deviceId) {
    const call = this.deviceCalls.get(deviceId);
    if (!call) return false;
    if (call.teardownRequested) return true;
    call.teardownRequested = true;
    if (call.established) {
      call.cseq += 1;
      this.#sendRequest(call, "BYE", call.requestUri, [
        ["Via", `SIP/2.0/UDP ${this.advertiseHost}:${this.port};branch=z9hG4bK-${crypto.randomBytes(8).toString("hex")};rport`],
        ["Max-Forwards", "70"], ["From", call.from], ["To", `${call.to};tag=${call.remoteTag || ""}`],
        ["Call-ID", call.callId], ["CSeq", `${call.cseq} BYE`], ["Content-Length", "0"],
      ], "");
    } else {
      call.cseq += 1;
      this.#sendRequest(call, "CANCEL", call.requestUri, [
        ["Via", `SIP/2.0/UDP ${this.advertiseHost}:${this.port};branch=${call.branch};rport`],
        ["Max-Forwards", "70"], ["From", call.from], ["To", call.to], ["Call-ID", call.callId],
        ["CSeq", `${call.cseq - 1} CANCEL`], ["Content-Length", "0"],
      ], "");
    }
    return true;
  }

  #send(message, remote) {
    const packet = Buffer.from(message, "utf8");
    this.socket.send(packet, remote.port, remote.address);
  }

  #sendRequest(call, method, uri, headers, body) {
    const content = body || "";
    const lines = [`${method} ${uri} SIP/2.0`, ...headers.filter(Boolean).map(([k, v]) => `${k}: ${v}`), `Content-Length: ${Buffer.byteLength(content)}`, "", content];
    this.#send(lines.join("\r\n"), call.remote);
  }

  #response(req, rinfo, code, reason, headers = [], body = "") {
    const via = req.headers.via || "";
    const from = req.headers.from || "";
    const to = req.headers.to || "";
    const callId = req.headers["call-id"] || "";
    const cseq = req.headers.cseq || "";
    const lines = [`SIP/2.0 ${code} ${reason}`, ["Via", via], ["From", from], ["To", to], ["Call-ID", callId], ["CSeq", cseq], ...headers].filter(Boolean).map(item => Array.isArray(item) ? `${item[0]}: ${item[1]}` : item);
    const content = body || "";
    lines.push(`Content-Length: ${Buffer.byteLength(content)}`, "", content);
    this.#send(lines.join("\r\n"), { address: rinfo.address, port: rinfo.port });
  }

  #register(req, rinfo) {
    const username = userFromUri(req.headers.to || req.headers.from);
    if (!username) return this.#response(req, rinfo, 400, "Bad Request");
    const contact = firstHeader(req.headers, "contact");
    const expires = Number((contact.match(/expires=(\d+)/i) || [])[1] || req.headers.expires || 600);
    if (expires === 0) {
      this.registrations.delete(username);
    } else {
      const endpoint = contactEndpoint(contact, { address: rinfo.address, port: rinfo.port });
      const registration = { username, contact: contact.match(/<([^>]+)>/)?.[1] || contact, address: endpoint.address, port: endpoint.port, device_id: username, expires_at: Date.now() + Math.min(expires, 3600) * 1000 };
      this.registrations.set(username, registration);
      this.onRegister(registration);
      console.log(`SIP registered user=${username} address=${registration.address}:${registration.port}`);
    }
    this.#response(req, rinfo, 200, "OK", [["Contact", contact || `<sip:${username}@${rinfo.address}:${rinfo.port}>`], ["Expires", String(expires)]]);
  }

  #message(packet, rinfo) {
    const req = parseSip(packet);
    if (!req.start) return;
    if (!req.isResponse) {
      if (req.method === "REGISTER") return this.#register(req, rinfo);
      if (req.method === "OPTIONS") return this.#response(req, rinfo, 200, "OK", [["Allow", "INVITE, ACK, CANCEL, BYE, OPTIONS"]]);
      if (req.method === "BYE") {
        this.#response(req, rinfo, 200, "OK");
        const call = this.calls.get(req.headers["call-id"]);
        if (call) { call.state = "ENDED"; this.onState({ type: "ended", ...call }); this.#close(call); }
        return;
      }
      if (req.method === "CANCEL") {
        this.#response(req, rinfo, 200, "OK");
        const call = this.calls.get(req.headers["call-id"]);
        if (call) { call.state = "ENDED"; this.onState({ type: "ended", ...call }); this.#close(call); }
        return;
      }
      return this.#response(req, rinfo, 405, "Method Not Allowed");
    }

    const call = this.calls.get(req.headers["call-id"]);
    if (!call) return;
    call.remoteTag = tag(req.headers.to) || call.remoteTag;
    if (req.code === 183 || req.code === 180) {
      const remote = parseSdp(req.body);
      if (remote) { call.session.remote = remote; this.onMedia({ type: "early", ...call, remote }); }
      this.onState({ type: req.code === 183 ? "progress" : "ringing", ...call });
      return;
    }
    if (req.code === 200 && /\s(?:BYE|CANCEL)\s*$/i.test(req.headers.cseq || "")) {
      call.state = "ENDED";
      this.onState({ type: "ended", ...call });
      this.#close(call);
      return;
    }
    if (req.code === 200 && /\sINVITE\s*$/i.test(req.headers.cseq || "")) {
      const remote = parseSdp(req.body);
      if (remote) { call.session.remote = remote; this.onMedia({ type: "ready", ...call, remote }); }
      call.established = true; call.state = "CONNECTED";
      this.#sendRequest(call, "ACK", call.requestUri, [
        ["Via", `SIP/2.0/UDP ${this.advertiseHost}:${this.port};branch=z9hG4bK-${crypto.randomBytes(8).toString("hex")};rport`],
        ["Max-Forwards", "70"], ["From", call.from], ["To", `${call.to};tag=${call.remoteTag || ""}`],
        ["Call-ID", call.callId], ["CSeq", `${call.cseq} ACK`], ["Content-Length", "0"],
      ], "");
      this.onState({ type: "connected", ...call });
      return;
    }
    if (req.code >= 300) { call.state = "FAILED"; this.onState({ type: "failed", ...call }); this.#close(call); }
  }

  #close(call) {
    this.calls.delete(call.callId);
    if (this.deviceCalls.get(call.device_id) === call) this.deviceCalls.delete(call.device_id);
  }
}
