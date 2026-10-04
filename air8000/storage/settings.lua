local M = {}
function M.load(kv, defaults) return kv and kv:get("config") or defaults end
function M.save(kv, cfg) return kv and kv:set("config", cfg) or false end
return M
