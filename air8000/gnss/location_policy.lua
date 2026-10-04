local M = { modes={off=true,on_request=true,periodic=true} }
function M.allows(mode, requested) return mode ~= "off" and (mode == "periodic" or requested == true) end
return M
