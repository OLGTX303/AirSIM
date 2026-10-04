local messages=require("protocol.messages")
local M={}
function M.new(cfg, ws, emit) return setmetatable({cfg=cfg,ws=ws,emit=emit or function() end,seq=0}, {__index=M}) end
function M:send(typ,payload,now) self.seq=self.seq+1; local m=messages.envelope(self.cfg.device_id,typ,payload,now,tostring(self.seq),tostring(self.seq)); self.emit("transport.out",m); return self.ws:send(json.encode(m)) end
function M:register(status) return self:send("device.register",{device_type="air8000a",hardware_model="Air8000A",serial_number=status.serial_number,imei=status.imei,firmware=_G.VERSION,capabilities=status.capabilities,status=status,device_secret=self.cfg.device_secret,enrollment_token=self.cfg.enrollment_token}) end
return M
