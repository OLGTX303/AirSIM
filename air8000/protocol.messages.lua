local version = require("protocol.pv")
local M = {}
local function valid_string(v, max) return type(v) == "string" and #v > 0 and #v <= (max or 256) end
function M.envelope(device_id, typ, payload, now, nonce, id)
    assert(valid_string(device_id, 128) and valid_string(typ, 64), "invalid envelope")
    local m = { protocol_version=version.name, message_id=id or tostring(now or 0).."-"..typ, device_id=device_id, timestamp=now or os.time()*1000, nonce=nonce, type=typ, payload=payload or {} }
    m.canonical=M.canonical(m); return m
end
function M.canonical(m)
    local encoded=(json and json.encode and json.encode(m.payload or {})) or "{}"
    return table.concat({m.protocol_version or "",m.device_id or "",m.type or "",tostring(m.timestamp or ""),m.nonce or "",encoded},"|")
end
function M.validate(m,max)
    if type(m)~="table" or m.protocol_version~=version.name or not valid_string(m.message_id,128) or not valid_string(m.device_id,128) or not valid_string(m.type,64) or type(m.payload)~="table" then return false,"invalid_message" end
    if #((m.raw or ""))>(max or version.max_message_bytes) then return false,"message_too_large" end
    return true
end
return M
