local M={}
function M.new(wlan,mobile,emit) return {wlan=wlan,mobile=mobile,emit=emit or function() end,state="NO_NETWORK"} end
function M:poll() local s=(self.wlan and self.wlan.ready and self.wlan.ready()) and "WIFI" or ((self.mobile and self.mobile.getState and self.mobile.getState()=="REGISTERED") and "CELLULAR" or "NO_NETWORK"); if s~=self.state then self.state=s; self.emit("network.changed",{state=s}) end; return s end
return M
