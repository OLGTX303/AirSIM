local M={}
function M.new() return setmetatable({ attempts=0, last_delay=0 }, {__index=M}) end
function M:next() self.attempts=self.attempts+1; local base=math.min(60000,1000*2^(self.attempts-1)); self.last_delay=base+math.random(0,math.floor(base*.2)); return self.last_delay end
function M:reset() self.attempts=0; self.last_delay=0 end
return M
