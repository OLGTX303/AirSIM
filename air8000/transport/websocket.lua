local M={}
function M.new(api, emit) return { api=api, emit=emit or function() end, connected=false } end
function M:connect(url, on_message) if not self.api or not self.api.connect then return false,"unsupported" end; self.connected=self.api.connect(url,function(data) on_message(data) end,function() self.connected=false; self.emit("transport.disconnected") end)==true; return self.connected end
function M:send(data) return self.connected and self.api.send and self.api.send(data)==true end
function M:close() if self.api and self.api.close then self.api.close() end; self.connected=false end
return M
