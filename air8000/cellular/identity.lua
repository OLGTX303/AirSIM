local M = {}
local function safe_call(fn)
    if type(fn) ~= "function" then return nil end
    local ok, value = pcall(fn)
    return ok and value or nil
end
-- LuatOS has no universal retail-label SN API. Use the MCU unique ID as the
-- stable serial fallback, with an optional vendor/board SN override.
function M.read(mobile, mcu, cfg)
    local imei = mobile and safe_call(mobile.imei) or nil
    local serial = cfg and cfg.serial_number or nil
    if not serial and mcu then
        local uid = safe_call(mcu.unique_id)
        if uid and type(uid.toHex) == "function" then serial = uid:toHex() end
    end
    return { serial_number = serial, imei = imei }
end
return M
