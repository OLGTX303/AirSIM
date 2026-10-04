local M={}
function M.new(status) return status end
function M:update(status, now) status.uptime_sec=math.floor((now or 0)/1000); return status end
return M
