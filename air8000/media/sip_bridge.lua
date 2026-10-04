local M = {}
function M.new(exsipclient) return { client=exsipclient, active=false, codec="PCMU", sample_rate=8000, frame_duration_ms=20 } end
function M:start() if not self.client then return false,"unsupported" end; self.active=true; return true end
function M:stop() self.active=false end
return M
