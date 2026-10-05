import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  mulawDecodeByte, mulawEncodeSample, encodePcmuFrame, decodePcmuPayload, resamplePcm16,
  buildRtpPacket, parseRtpPacket, randomRtpState, createDecimator2x, createInterpolator2x,
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

function tone(freq,rate,samples,amp=12000){
  const b=Buffer.alloc(samples*2);
  for(let i=0;i<samples;i++)b.writeInt16LE(Math.round(Math.sin(2*Math.PI*freq*i/rate)*amp),i*2);
  return b;
}
function rms(b,skip=0){
  let sum=0,n=0;
  for(let i=skip*2;i+1<b.length;i+=2){const v=b.readInt16LE(i);sum+=v*v;n++}
  return Math.sqrt(sum/Math.max(1,n));
}
function chunked(fn,input,bytes){
  const parts=[];
  for(let i=0;i<input.length;i+=bytes)parts.push(fn(input.subarray(i,i+bytes)));
  return Buffer.concat(parts);
}

// Streaming resamplers must give identical output whether audio arrives in
// one block or in 20 ms RTP/WebSocket frames: no per-frame seams.
const narrow=tone(1000,8000,8000);
const upWhole=createInterpolator2x()(narrow);
const upFramed=chunked(createInterpolator2x(),narrow,320);
assert.equal(upFramed.length,narrow.length*2);
assert.deepEqual(upFramed,upWhole);
assert.ok(Math.abs(rms(upFramed,200)-12000/Math.SQRT2)<12000*0.05, "8->16 kHz keeps 1 kHz speech level");

const wideSpeech=tone(1000,16000,16000);
const downFramed=chunked(createDecimator2x(),wideSpeech,640);
assert.deepEqual(downFramed,createDecimator2x()(wideSpeech));
assert.equal(downFramed.length,wideSpeech.length/2);
assert.ok(Math.abs(rms(downFramed,100)-12000/Math.SQRT2)<12000*0.05, "16->8 kHz keeps 1 kHz speech level");

// A 6 kHz component would alias to 2 kHz with plain decimation.
const alias=createDecimator2x()(tone(6000,16000,16000));
assert.ok(rms(alias,100)<12000*0.01, `16->8 kHz anti-alias rejection rms=${rms(alias,100)}`);
const naiveAlias=resamplePcm16(tone(6000,16000,16000),16000,8000);
assert.ok(rms(naiveAlias,100)>12000*0.5, "control: naive decimation aliases");

// Odd-length chunks keep the decimation phase.
const odd=createDecimator2x();
const oddOut=Buffer.concat([odd(wideSpeech.subarray(0,642)),odd(wideSpeech.subarray(642,1282)),odd(wideSpeech.subarray(1282))]);
assert.deepEqual(oddOut,createDecimator2x()(wideSpeech));

console.log("Air8000 RTP/PCMU tests passed");
