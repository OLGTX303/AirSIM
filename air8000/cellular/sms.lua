local proto = require("protocol.sms")
local M = {}
function M.new(api, emit, max) return setmetatable({ api=api, emit=emit or function() end, max=max or 4096, seen={} }, {__index=M}) end
function M:send(id, number, body) if type(body)~="string" or #body==0 or #body>self.max then return false,"invalid_body" end; if not self.api or not self.api.send then return false,"unsupported" end; local ok=self.api.send(number,body); self.emit("sms.sent",{message_id=id,number=number,ok=ok==true}); return ok~=false end
function M:on_receive(sender, body, timestamp) local id=tostring(sender)..":"..tostring(timestamp)..":"..tostring(#body); if self.seen[id] then return false,"duplicate" end; self.seen[id]=true; self.emit("sms.received",proto.normalize(id,sender,body,timestamp)); return true end
return M
