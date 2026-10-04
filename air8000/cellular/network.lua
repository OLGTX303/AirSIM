local M={}
function M.state(wlan, mobile) if wlan and wlan.ready and wlan.ready() then return "WIFI" end; if mobile and mobile.getState and mobile.getState()=="REGISTERED" then return "CELLULAR" end; return "NO_NETWORK" end
return M
