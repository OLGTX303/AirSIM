local M={}
function M.new(bind, allowlist) return {bind=bind or "127.0.0.1",allowlist=allowlist or {},authenticated=false} end
function M:accept(peer, authenticated) if self.bind~="127.0.0.1" and not self.allowlist[peer] then return false end; self.authenticated=authenticated==true; return self.authenticated end
return M
