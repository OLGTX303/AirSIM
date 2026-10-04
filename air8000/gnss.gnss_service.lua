local location = require("gnss.location")
local M = {}
function M.new(api, policy) return setmetatable({api=api,policy=policy or "on_request",state="disabled",last=nil}, {__index=M}) end
function M:start() self.state="searching"; return self.api and self.api.start and self.api.start() ~= false end
function M:sample(now) local raw=self.api and self.api.read and self.api.read(); self.last=location.normalize(raw,now); self.state=self.last.fix_state; return self.last end
return M
