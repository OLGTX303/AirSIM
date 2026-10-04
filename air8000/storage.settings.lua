-- LuatTools flat-module compatibility entry for storage/settings.lua.
-- Keep this file at the Air8000 bundle root; the merge step does not reliably
-- resolve nested dotted module names.
local M = {}

function M.load(kv, defaults)
    return kv and kv:get("config") or defaults
end

function M.save(kv, cfg)
    return kv and kv:set("config", cfg) or false
end

return M
