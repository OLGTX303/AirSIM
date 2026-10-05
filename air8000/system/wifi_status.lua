local M={}

local function call(api,name,...)
    if not api or type(api[name])~="function" then return nil end
    local ok,value=pcall(api[name],...)
    if ok then return value end
    return nil
end

local function valid_ip(value)
    return type(value)=="string" and value~="" and value~="0.0.0.0"
end

function M.snapshot(wlan,cfg,cache,event,data,now)
    cache=cache or {}
    cfg=cfg or {}
    local saved=cfg.wifi or {}

    if event=="CONNECTED" and type(data)=="string" and data~="" then
        cache.ssid=data
        cache.disconnect_reason=nil
    elseif event=="DISCONNECTED" then
        cache.disconnect_reason=data
    end

    local ready=call(wlan,"ready")==true
    local info=call(wlan,"getInfo")
    if type(info)~="table" then info={} end

    local ssid=call(wlan,"getSsid")
    if type(ssid)~="string" or ssid=="" then ssid=cache.ssid or saved.ssid end
    if type(ssid)=="string" and ssid~="" then cache.ssid=ssid end

    local ip=call(wlan,"getIP")
    if not valid_ip(ip) then ip=call(wlan,"getIp") end
    if not valid_ip(ip) then ip=nil end

    local bssid=info.bssid or call(wlan,"getBssid") or saved.bssid
    local mac=call(wlan,"getMac")
    local state
    if ready and ip then state="connected"
    elseif event=="CONNECTED" then state="associated"
    elseif event=="CONNECTING" then state="connecting"
    elseif event=="DISCONNECTING" then state="disconnecting"
    elseif event=="DISCONNECTED" or event=="IP_LOSE" then state="disconnected"
    elseif saved.ssid then state="configured"
    else state="unconfigured" end

    return {
        configured=type(saved.ssid)=="string" and saved.ssid~="",
        connected=ready and ip~=nil,
        state=state,
        ssid=ssid,
        ip=ip,
        gateway=info.gw or info.gateway,
        bssid=bssid,
        rssi=tonumber(info.rssi),
        mac=mac,
        disconnect_reason=state=="disconnected" and cache.disconnect_reason or nil,
        last_event=event,
        timestamp=now or 0,
    }
end

return M
