local M = {}
function M.status(capabilities, identity, profile)
    identity = identity or {}
    profile=profile or {}
    local model=string.lower(tostring(profile.model or ""))
    local is_w=model:find("air8000w",1,true)~=nil
    return { device_type=is_w and "air8000w" or "air8000a",
        hardware_model=is_w and "Air8000W" or "Air8000A",
        module_model=profile.model, serial_number=identity.serial_number, imei=identity.imei,
        capabilities=capabilities or {},
        online=true, sim_ready=false, network_registered=false, volte_ready=false, relay_connected=false,
        media_ready=false, gnss_state="disabled", wifi_state="unknown", uptime_sec=0,
        counters={calls_total=0,calls_failed=0,sms_sent=0,sms_failed=0,relay_reconnects=0,media_underflows=0,media_overflows=0,network_recoveries=0} }
end
return M
