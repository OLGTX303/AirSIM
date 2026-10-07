-- LuatTools flat-module compatibility entry for storage/settings.lua.
-- Keep this file at the Air8000 bundle root; the merge step does not reliably
-- resolve nested dotted module names.
local M = {}

function M.load(kv, defaults)
    local saved=kv and kv:get("config")
    if type(saved)~="table" or type(defaults)~="table" then return saved or defaults end
    local loaded={}
    for key,value in pairs(saved) do loaded[key]=value end
    -- The firmware bundle owns the control endpoint.  Do not let a stale
    -- persisted config keep using an endpoint from an older LAN test.
    if defaults.relay_url then loaded.relay_url=defaults.relay_url end
    return loaded
end

function M.save(kv, cfg)
    return kv and kv:set("config", cfg) or false
end

return M
