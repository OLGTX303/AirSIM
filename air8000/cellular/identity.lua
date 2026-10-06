local M = {}
local function safe_call(fn, ...)
    if type(fn) ~= "function" then return nil end
    local ok, value = pcall(fn, ...)
    return ok and value or nil
end
-- mobile.imei() returns nil or "" until the modem has started, so callers
-- must retry; an empty value is reported as missing, never as an IMEI.
function M.imei(mobile)
    local value = mobile and safe_call(mobile.imei) or nil
    if type(value) ~= "string" then return nil end
    value = value:match("^%s*(%d+)%s*$")
    if not value or #value < 14 or #value > 17 then return nil end
    return value
end
-- LuatOS has no universal retail-label SN API. Use the MCU unique ID as the
-- stable serial fallback, with an optional vendor/board SN override.
function M.read(mobile, mcu, cfg)
    local serial = cfg and cfg.serial_number or nil
    if not serial and mcu then
        local uid = safe_call(mcu.unique_id)
        if uid and type(uid.toHex) == "function" then serial = uid:toHex() end
    end
    return { serial_number = serial, imei = M.imei(mobile) }
end
return M
