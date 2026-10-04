local M = {}
function M.new() return { last_rx=0,last_tx=0,underflows=0,overflows=0,dropped=0,heartbeat=0 } end
function M:tick(now) self.heartbeat=now; return (now-self.last_rx)<5000 or (now-self.last_tx)<5000 end
return M
