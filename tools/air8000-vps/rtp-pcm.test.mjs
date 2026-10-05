import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  mulawDecodeByte, mulawEncodeSample, encodePcmuFrame, decodePcmuPayload, resamplePcm16,
  buildRtpPacket, parseRtpPacket, randomRtpState,
} from "./rtp-pcm.mjs";

for (const sample of [-30000,-10000,-1000,0,1000,10000,30000]) {
  const decoded=mulawDecodeByte(mulawEncodeSample(sample));
  assert.ok(Math.abs(decoded-sample)<Math.max(700,Math.abs(sample)*0.08), `mu-law error sample=${sample} decoded=${decoded}`);
}

const pcm=Buffer.alloc(320);
for(let i=0;i<160;i++) pcm.writeInt16LE(Math.round(Math.sin(i/10)*12000),i*2);
const encoded=encodePcmuFrame(pcm);
assert.equal(encoded.length,160);
const decoded=decodePcmuPayload(encoded);
assert.equal(decoded.length,320);
const wide=resamplePcm16(decoded,8000,16000);
assert.equal(wide.length,640);
assert.equal(resamplePcm16(wide,16000,8000).length,320);

const state=randomRtpState(crypto.randomBytes);
const seq=state.sequence,ts=state.timestamp,ssrc=state.ssrc;
const packet=buildRtpPacket(encoded,state,0,true);
const parsed=parseRtpPacket(packet);
assert.ok(parsed);
assert.equal(parsed.payloadType,0);
assert.equal(parsed.marker,true);
assert.equal(parsed.sequence,seq);
assert.equal(parsed.timestamp,ts);
assert.equal(parsed.ssrc,ssrc);
assert.deepEqual(parsed.payload,encoded);
assert.equal(state.timestamp,(ts+160)>>>0);

assert.equal(parseRtpPacket(Buffer.from([0,1,2])),null);
console.log("Air8000 RTP/PCMU tests passed");
