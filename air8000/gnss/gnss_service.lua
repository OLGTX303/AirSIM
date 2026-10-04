local location = require("gnss.location")
local M = {}
function M.new(api, policy) return setmetatable({ api=api, policy=policy or "on_request", state="disabled", last=nil }, {__index=M}) end
function M:start()
    if not self.api then self.state="unavailable"; return false,"gnss_unavailable" end
    if self.api.start then
        local ok, result = pcall(self.api.start)
        if not ok or result == false then self.state="unavailable"; return false,"gnss_start_failed" end
        self.state="searching"; return true
    end
    -- Air8000 LuatOS uses exgnss.open rather than start.  TIMERORSUC keeps
    -- the receiver open until a fix or the configured timeout.
    if self.api.open then
        local mode=self.api.TIMERORSUC or self.api.DEFAULT
        local ok, result=pcall(self.api.open,mode,{tag="airsim",val=60})
        if not ok or result == false then self.state="unavailable"; return false,"gnss_open_failed" end
        self.state="searching"; return true
    end
    self.state="unavailable"; return false,"gnss_api_unsupported"
end
function M:read_raw()
    if not self.api then return nil end
    if self.api.read then return self.api.read() end
    if self.api.last_loc then
        local ok, value=pcall(self.api.last_loc)
        if ok and value then return value end
    end
    if self.api.rmc then
        local ok, value=pcall(self.api.rmc,2)
        if ok and value then return value end
    end
    if self.api.getRmc then
        local ok, value=pcall(self.api.getRmc,2)
        if ok and value then return value end
    end
    return nil
end
function M:sample(now)
    local raw=self:read_raw()
    self.last=location.normalize(raw,now)
    self.state=self.last.fix_state
    return self.last
end
return M
