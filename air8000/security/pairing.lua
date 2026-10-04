local M = {}
function M.provision(store, cfg)
    assert(type(cfg.device_id)=="string" and #cfg.device_id > 0, "device_id required")
    assert(type(cfg.device_secret)=="string" and #cfg.device_secret >= 16, "per-device secret required")
    store:set("config", cfg); store:set("paired", true); return true
end
function M.factory_reset(store) store:delete("config"); store:delete("paired"); return true end
return M
