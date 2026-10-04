local M={}
function M.new(api) return {api=api,boot_count=0,last=0} end
function M:kick() return not self.api or not self.api.feed or self.api.feed()~=false end
function M:recover(kind) if self.api and self.api.recover then return self.api.recover(kind) end; return true end
return M
