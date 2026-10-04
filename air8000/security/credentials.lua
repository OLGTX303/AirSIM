local M={}
function M.redact(v) if type(v)~="string" then return "<redacted>" end; if #v<=8 then return "******" end; return v:sub(1,4).."******"..v:sub(-4) end
return M
