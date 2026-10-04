local M = {}
function M.new(capacity) return { capacity=capacity or 32, packets={}, next=nil, underflows=0, overflows=0, duplicates=0, late=0 } end
function M:push(packet)
    local s=packet.header.sequence; if self.packets[s] then self.duplicates=self.duplicates+1; return false,"duplicate" end
    if self.next and s < self.next then self.late=self.late+1; return false,"late" end
    if #self:keys() >= self.capacity then self.overflows=self.overflows+1; return false,"overflow" end
    self.packets[s]=packet; return true
end
function M:pop()
    if not self.next then for s in pairs(self.packets) do self.next=s; break end end
    local p=self.packets[self.next]; if not p then self.underflows=self.underflows+1; return nil end
    self.packets[self.next]=nil; self.next=self.next+1; return p
end
function M:keys() local r={}; for k in pairs(self.packets) do r[#r+1]=k end; return r end
return M
