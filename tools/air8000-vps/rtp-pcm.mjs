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

// Convert signed 16-bit little-endian mono PCM between the browser rate and
// the fixed 8 kHz SIP/PCMU rate.
export function resamplePcm16(pcm, fromRate, toRate) {
  if (!Buffer.isBuffer(pcm)) pcm = Buffer.from(pcm);
  if ((pcm.length & 1) !== 0) throw new Error("PCM S16LE frame must have an even byte length");
  fromRate = Number(fromRate); toRate = Number(toRate);
  if (!(fromRate > 0) || !(toRate > 0)) throw new Error("PCM sample rates must be positive");
  if (fromRate === toRate) return Buffer.from(pcm);
  const inputSamples = pcm.length / 2;
  const outputSamples = Math.max(1, Math.round(inputSamples * toRate / fromRate));
  const out = Buffer.allocUnsafe(outputSamples * 2);
  for (let i = 0; i < outputSamples; i++) {
    const position = i * fromRate / toRate;
    const left = Math.min(inputSamples - 1, Math.floor(position));
    const right = Math.min(inputSamples - 1, left + 1);
    const fraction = position - left;
    const sample = pcm.readInt16LE(left * 2) * (1 - fraction) + pcm.readInt16LE(right * 2) * fraction;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), i * 2);
  }
  return out;
}

// 63-tap Hamming-windowed sinc low-pass at 16 kHz. Cutoff 3.7 kHz keeps the
// telephone band (300-3400 Hz) flat and rejects >4.1 kHz by about 50 dB, so
// 16->8 kHz decimation does not fold sibilance back into speech and 8->16 kHz
// interpolation does not create images above the PCMU band.
function designLowpass(taps, cutoff, rate) {
  const h = new Float64Array(taps);
  const mid = (taps - 1) / 2;
  const fc = cutoff / rate;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - mid;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    h[i] = sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1)));
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}
const SPEECH_LOWPASS_16K = designLowpass(63, 3700, 16000);

function clamp16(value) {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

// Streaming 16 kHz -> 8 kHz S16LE decimator. Filter history and the output
// phase carry across WebSocket frames, so frame boundaries are seamless.
export function createDecimator2x(taps = SPEECH_LOWPASS_16K) {
  const keep = taps.length - 1;
  let history = new Float64Array(keep);
  let phase = 0;
  return function decimate(pcm) {
    if (!Buffer.isBuffer(pcm)) pcm = Buffer.from(pcm);
    if ((pcm.length & 1) !== 0) throw new Error("PCM S16LE frame must have an even byte length");
    const length = pcm.length >> 1;
    const x = new Float64Array(keep + length);
    x.set(history);
    for (let i = 0; i < length; i++) x[keep + i] = pcm.readInt16LE(i * 2);
    const count = length > phase ? Math.ceil((length - phase) / 2) : 0;
    const out = Buffer.allocUnsafe(count * 2);
    for (let k = 0; k < count; k++) {
      const newest = keep + phase + k * 2;
      let acc = 0;
      for (let t = 0; t < taps.length; t++) acc += taps[t] * x[newest - t];
      out.writeInt16LE(clamp16(acc), k * 2);
    }
    phase = phase + count * 2 - length;
    history = x.slice(x.length - keep);
    return out;
  };
}

// Streaming 8 kHz -> 16 kHz S16LE polyphase interpolator. The last input
// samples of each RTP packet feed the next one, avoiding the 50 Hz seam
// produced by resampling every 20 ms packet independently.
export function createInterpolator2x(taps = SPEECH_LOWPASS_16K) {
  const phases = Math.ceil(taps.length / 2);
  const even = new Float64Array(phases), odd = new Float64Array(phases);
  for (let k = 0; k < phases; k++) {
    even[k] = 2 * (taps[2 * k] || 0);
    odd[k] = 2 * (taps[2 * k + 1] || 0);
  }
  const keep = phases - 1;
  let history = new Float64Array(keep);
  return function interpolate(pcm) {
    if (!Buffer.isBuffer(pcm)) pcm = Buffer.from(pcm);
    if ((pcm.length & 1) !== 0) throw new Error("PCM S16LE frame must have an even byte length");
    const length = pcm.length >> 1;
    const x = new Float64Array(keep + length);
    x.set(history);
    for (let i = 0; i < length; i++) x[keep + i] = pcm.readInt16LE(i * 2);
    const out = Buffer.allocUnsafe(length * 4);
    for (let n = 0; n < length; n++) {
      const newest = keep + n;
      let a = 0, b = 0;
      for (let k = 0; k < phases; k++) { a += even[k] * x[newest - k]; b += odd[k] * x[newest - k]; }
      out.writeInt16LE(clamp16(a), n * 4);
      out.writeInt16LE(clamp16(b), n * 4 + 2);
    }
    history = x.slice(x.length - keep);
    return out;
  };
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
