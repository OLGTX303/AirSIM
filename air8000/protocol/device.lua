local M = {}
function M.status(capabilities, identity)
    identity = identity or {}
    return { device_type="air8000a", hardware_model="Air8000A", serial_number=identity.serial_number,
        imei=identity.imei, capabilities=capabilities or {},
        online=true, sim_ready=false, network_registered=false, volte_ready=false, relay_connected=false,
        media_ready=false, gnss_state="disabled", wifi_state="unknown", uptime_sec=0,
        counters={calls_total=0,calls_failed=0,sms_sent=0,sms_failed=0,relay_reconnects=0,media_underflows=0,media_overflows=0,network_recoveries=0} }
end
return M
