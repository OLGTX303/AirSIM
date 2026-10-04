import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export class Air8000Simulator extends EventEmitter {
  constructor() { super(); this.device_id="sim-air8000"; this.serial_number="SIM-AIR8000-001"; this.imei="123456789012345"; this.online=false; this.call=null; this.sms=[]; this.location={lat:3.139, lng:101.687}; this.seq=0; }
  register() { this.online=true; this.emit("device.register", {device_type:"air8000a", hardware_model:"Air8000A", serial_number:this.serial_number, imei:this.imei, capabilities:{voice:true,sms:true,gnss:true,wifi:true,direct_pcm:false,sip_bridge:true}}); }
  dial(number) { if (!this.online || this.call) throw new Error("unavailable"); this.call={call_id:randomUUID(),number,state:"DIALING"}; this.emit("call.state",this.call); return this.call.call_id; }
  answer() { if (!this.call) throw new Error("no call"); this.call.state="CONNECTED"; this.emit("call.state",this.call); }
  hangup() { if (!this.call) return; this.call.state="ENDED"; this.emit("call.state",this.call); this.call=null; }
  incoming(number="+60120000000") { this.call={call_id:randomUUID(),number,state:"INCOMING"}; this.emit("call.state",this.call); }
  receiveSms(sender, body) { const m={message_id:randomUUID(),sender,body,timestamp:Date.now()}; this.sms.push(m); this.emit("sms.received",m); }
  sendSms(number, body) { const m={message_id:randomUUID(),number,body,state:"SENT"}; this.emit("sms.sent",m); return m.message_id; }
  move(lat=this.location.lat+0.0001,lng=this.location.lng+0.0001) { this.location={lat,lng}; this.emit("device.location",{fix:true,...this.location,timestamp:Date.now()}); }
  networkLoss() { this.online=false; this.emit("network.changed",{state:"NO_NETWORK"}); }
  reconnect() { this.online=true; this.emit("network.changed",{state:"CELLULAR"}); }
}

if (process.argv.includes("--test")) {
  const s=new Air8000Simulator(); let seen=0; s.on("call.state",()=>seen++); s.register(); const id=s.dial("+6012"); s.answer(); s.hangup(); s.receiveSms("+6013","test"); s.move(); s.networkLoss(); s.reconnect(); if (!id || seen!==3 || !s.online) process.exit(1); console.log("Air8000 simulator: PASS");
}
