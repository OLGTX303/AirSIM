local redact=require("security.credentials")
local M={}
function M.safe_identifier(v) return redact.redact(v) end
function M.log(level,event,data) if data then data.body=nil; data.secret=nil; data.pcm=nil; data.imsi=redact.redact(data.imsi); data.iccid=redact.redact(data.iccid) end; if log and log[level] then log[level]("airsim",event,data) end end
return M
