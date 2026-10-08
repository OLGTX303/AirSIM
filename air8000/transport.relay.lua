local messages=require("protocol.messages")
local M={}
function M.new(cfg, ws, emit) return setmetatable({cfg=cfg,ws=ws,emit=emit or function() end,seq=0}, {__index=M}) end
function M:send(typ,payload,now) self.seq=self.seq+1; local m=messages.envelope(self.cfg.device_id,typ,payload,now,tostring(self.seq),tostring(self.seq)); self.emit("transport.out",m); return self.ws:send(json.encode(m)) end
function M:register(status)
    local payload={device_type="air8000a",hardware_model="Air8000A",serial_number=status.serial_number,imei=status.imei,firmware=_G.VERSION,capabilities=status.capabilities,status=status,device_secret=self.cfg.device_secret,enrollment_token=self.cfg.enrollment_token}
    local m=messages.envelope(self.cfg.device_id,"device.register",payload,os.time()*1000,tostring(self.seq+1),tostring(self.seq+1))
    -- Keep registration credentials at the envelope level for the LAN gateway
    -- compatibility path; they are never logged or included in device status.
    m.serial_number=payload.serial_number
    m.imei=payload.imei
    m.device_secret=payload.device_secret
    m.enrollment_token=payload.enrollment_token
    self.seq=self.seq+1
    self.emit("transport.out",m)
    return self.ws:send(json.encode(m))
end
return M
