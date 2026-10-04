local M={}
function M.ready(cc, mobile) return cc~=nil and type(cc.init)=="function" and mobile~=nil end
return M
