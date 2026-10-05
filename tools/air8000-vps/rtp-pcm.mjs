const RTP_HEADER_BYTES = 12;

export function mulawDecodeByte(value) {
  let u = (~value) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

export function mulawEncodeSample(input) {
  let sample = Math.max(-32768, Math.min(32767, Number(input) || 0));
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > 32635) sample = 32635;
  sample += 0x84;

  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

export function decodePcmuPayload(payload) {
  const pcm = Buffer.allocUnsafe(payload.length * 2);
  for (let i = 0; i < payload.length; i++) pcm.writeInt16LE(mulawDecodeByte(payload[i]), i * 2);
  return pcm;
}

export function encodePcmuFrame(pcm) {
  if (!Buffer.isBuffer(pcm)) pcm = Buffer.from(pcm);
  if ((pcm.length & 1) !== 0) throw new Error("PCM S16LE frame must have an even byte length");
  const out = Buffer.allocUnsafe(pcm.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = mulawEncodeSample(pcm.readInt16LE(i * 2));
  return out;
}

export function parseRtpPacket(packet) {
  if (!Buffer.isBuffer(packet)) packet = Buffer.from(packet);
  if (packet.length < RTP_HEADER_BYTES) return null;
  const version = packet[0] >> 6;
  if (version !== 2) return null;

  const padding = (packet[0] & 0x20) !== 0;
  const extension = (packet[0] & 0x10) !== 0;
  const csrcCount = packet[0] & 0x0f;
  let offset = RTP_HEADER_BYTES + csrcCount * 4;
  if (offset > packet.length) return null;

  if (extension) {
    if (offset + 4 > packet.length) return null;
    const words = packet.readUInt16BE(offset + 2);
    offset += 4 + words * 4;
    if (offset > packet.length) return null;
  }

  let end = packet.length;
  if (padding) {
    const bytes = packet[packet.length - 1];
    if (bytes <= 0 || bytes > packet.length - offset) return null;
    end -= bytes;
  }
  if (end < offset) return null;

  return {
    marker: (packet[1] & 0x80) !== 0,
    payloadType: packet[1] & 0x7f,
    sequence: packet.readUInt16BE(2),
    timestamp: packet.readUInt32BE(4),
    ssrc: packet.readUInt32BE(8),
    payload: packet.subarray(offset, end),
  };
}

export function buildRtpPacket(payload, state, payloadType = 0, marker = false) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
  const packet = Buffer.allocUnsafe(RTP_HEADER_BYTES + payload.length);
  packet[0] = 0x80;
  packet[1] = (marker ? 0x80 : 0) | (payloadType & 0x7f);
  packet.writeUInt16BE(state.sequence & 0xffff, 2);
  packet.writeUInt32BE(state.timestamp >>> 0, 4);
  packet.writeUInt32BE(state.ssrc >>> 0, 8);
  payload.copy(packet, RTP_HEADER_BYTES);

  state.sequence = (state.sequence + 1) & 0xffff;
  state.timestamp = (state.timestamp + 160) >>> 0;
  return packet;
}

export function randomRtpState(randomBytes) {
  const bytes = randomBytes(10);
  return {
    sequence: bytes.readUInt16BE(0),
    timestamp: bytes.readUInt32BE(2),
    ssrc: bytes.readUInt32BE(6),
  };
}
