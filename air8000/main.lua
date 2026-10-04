PROJECT="airsim-air8000"; VERSION="001.000.000"
local cfg=require("config")
local settings=require("storage.settings")
local capability=require("system.capability")
local device=require("protocol.device")
local identity=require("cellular.identity")
local ble_prov=require("ble.prov")
local ws_transport=require("transport.ws")
local relay_module=require("transport.relay")
local reconnect=require("transport.reconnect")
local gnss_module=require("gnss.gnss_service")
local call_module=require("cellular.call")
local sms_module=require("cellular.sms")
local pcm_module=require("media.direct_pcm")
local kv_api=nil
if fskv then
    if fskv.init then pcall(fskv.init) end
    kv_api={
        get=function(_,key) if fskv.init then fskv.init() end; return fskv.get(key) end,
        set=function(_,key,value) if fskv.init then fskv.init() end; return fskv.set(key,value) end
    }
end
if kv_api then cfg=settings.load(kv_api,cfg) end
local caps=capability.probe({cc=cc,sms=sms,gnss=libgnss or exgnss,wlan=wlan,websocket=websocket,crypto=crypto,fskv=fskv,fota=fota,sip=exsipclient})
local device_identity=identity.read(mobile,mcu,cfg)
local status=device.status(caps,device_identity); status.firmware=tostring(_G.VERSION or VERSION)
if wlan and wlan.connect and cfg.wifi and type(cfg.wifi.ssid)=="string" and cfg.wifi.ssid ~= "" then
    local stored_bssid=cfg.wifi.bssid
    local bssid=type(stored_bssid)=="string" and stored_bssid:match("^[%da-fA-F]+$") and #stored_bssid==12 and string.fromHex(stored_bssid) or nil
    if bssid then sys.timerStart(wlan.connect,1000,cfg.wifi.ssid,cfg.wifi.password or "",1,bssid)
    else sys.timerStart(wlan.connect,1000,cfg.wifi.ssid,cfg.wifi.password or "",1) end
end
if cfg.ble_pairing_code and cfg.ble_pairing_code ~= "REPLACE_WITH_6_DIGIT_PAIRING_CODE" then
    local ok,err=ble_prov.start(cfg,device_identity,wlan,kv_api)
    if not ok and log then log.warn("airsim.ble",err) end
end
local pcm=pcm_module.new(cc,nil,nil)
local media_frames=0
local media_bytes=0
-- cc.hangUp() and cc.record() depend on the VoLTE control task created by
-- cc.init().  Initialize it once at boot; otherwise hang-up can be queued to
-- a missing task and speech start returns the modem error seen in the log.
if cc and cc.init then
    local init_ok, init_result = pcall(cc.init, 0)
    if log then log.info("airsim.call", "cc_init", tostring(init_ok and init_result)) end
end
local function stop_media()
    if pcm.active then pcm:stop() end
end
local function start_media(call)
    if not _G.relay_transport or not _G.relay_transport.send_binary then
        if log then log.warn("airsim.media", "start_failed", "transport_unavailable") end
        return false,"media_transport_unavailable"
    end
    media_frames=0
    media_bytes=0
    local ok,err=pcm:start(call.call_id,function(is_dl,point)
        if not is_dl then return end
        local used=point and point.used and point:used() or 0
        local payload=point and point.toStr and point:toStr(0,used) or nil
        if type(payload)=="string" and #payload > 0 and _G.relay_transport then
            local sent=_G.relay_transport:send_binary(payload)
            if sent then
                media_frames=media_frames+1
                media_bytes=media_bytes+#payload
                if log and (media_frames==1 or media_frames%50==0) then log.info("airsim.media", "downlink", media_frames, media_bytes) end
            elseif log then
                log.warn("airsim.media", "downlink_send_failed")
            end
        end
    end)
    if log then log.info("airsim.media", "start", tostring(ok), tostring(err or ""), tostring(pcm.sample_rate)) end
    if ok and _G.relay_client then _G.relay_client:send("media.open",{call_id=call.call_id,sample_rate=pcm.sample_rate,channels=1,bits=16,format="pcm_s16le"},os.time()*1000) end
    return ok,err
end
local function emit_event(kind,payload)
    if kind=="call.state" and payload and payload.call then
        if payload.event=="connected" then start_media(payload.call)
        elseif payload.event=="ended" or payload.event=="failed" or payload.event=="hangup" or payload.event=="reject" or payload.event=="remote_hangup" then stop_media() end
    end
    if _G.relay_client then _G.relay_client:send(kind,payload,os.time()*1000) end
end
_G.call_service=call_module.new(cc,emit_event)
_G.sms_service=sms_module.new(sms,function(kind,payload) if _G.relay_client then _G.relay_client:send(kind,payload,os.time()*1000) end end,cfg.limits and cfg.limits.max_sms_body)
_G.gnss_service=gnss_module.new(libgnss or exgnss,cfg.location_policy)

local function send_command_result(message_id, ok, error_message, payload)
    if _G.relay_client then _G.relay_client:send("device.command_result",{command_id=message_id,ok=ok,error=error_message,payload=payload},os.time()*1000) end
end
local function dispatch_call_command(message_id, fn)
    -- Never hold the WebSocket receive callback while the cellular stack is
    -- processing a call request.  This keeps dial/answer/hang-up responsive
    -- even when the modem or carrier takes time to acknowledge it.
    if not sys or not sys.taskInit then
        local ok, result, err = pcall(fn)
        send_command_result(message_id, ok and result == true, ok and (result == true and nil or tostring(err or "call_failed")) or tostring(result), nil)
        return
    end
    sys.taskInit(function()
        local ok, result, err = pcall(fn)
        if not ok then send_command_result(message_id,false,tostring(result),nil)
        else send_command_result(message_id,result == true, result == true and nil or tostring(err or "call_failed"),nil) end
    end)
end
local function save_wifi_config(ssid, password, bssid, security)
    if type(ssid) ~= "string" or #ssid == 0 or #ssid > 64 or type(password) ~= "string" or #password > 128 then return false, "invalid_wifi" end
    cfg.wifi={ssid=ssid,password=password,bssid=bssid,security=security or "auto"}
    if kv_api and kv_api.set then kv_api:set("config",cfg) end
    return true
end
local function handle_relay_message(raw,fin,opcode)
    if tonumber(opcode)==2 then
        if pcm.active then pcm:push_uplink(raw) end
        return
    end
    local msg=json.decode(raw or "")
    if type(msg) ~= "table" or type(msg.type) ~= "string" then return end
    local p=msg.payload or {}; local id=msg.message_id
    if msg.type == "device.register.ack" then return end
    if msg.type == "command.dial" then dispatch_call_command(id,function() return _G.call_service:dial(id,p.number) end); return end
    if msg.type == "command.answer" then dispatch_call_command(id,function() return _G.call_service:answer() end); return end
    if msg.type == "command.reject" then dispatch_call_command(id,function() return _G.call_service:reject() end); return end
    if msg.type == "command.hangup" then dispatch_call_command(id,function() return _G.call_service:hangup() end); return end
    if msg.type == "command.dtmf" then dispatch_call_command(id,function() return _G.call_service:dtmf(p.digit) end); return end
    if msg.type == "command.send_sms" then send_command_result(id,_G.sms_service:send(id,p.number,p.body),nil); return end
    if msg.type == "command.gps_request" then
        local started,start_error=_G.gnss_service:start()
        local sample=nil
        if started then
            for _=1,15 do
                sample=_G.gnss_service:sample(os.time()*1000)
                if sample and sample.fix_state=="fixed" then break end
                sys.wait(1000)
            end
        end
        send_command_result(id,started and sample and sample.fix_state=="fixed",started and nil or start_error or "gnss_unavailable",sample)
        return
    end
    if msg.type == "command.wifi_config" then send_command_result(id,true,nil,{configured=cfg.wifi and cfg.wifi.ssid~=nil,ssid=cfg.wifi and cfg.wifi.ssid,security=cfg.wifi and cfg.wifi.security}); return end
    if msg.type == "command.wifi_connect" then
        local saved,save_error=save_wifi_config(p.ssid,p.password,p.bssid,p.security)
        if not saved then send_command_result(id,false,save_error); return end
        local binary_bssid=type(p.bssid)=="string" and p.bssid:match("^[%da-fA-F]+$") and #p.bssid==12 and string.fromHex(p.bssid) or nil
        local ok
        if binary_bssid then ok=wlan and wlan.connect and wlan.connect(p.ssid,p.password,1,binary_bssid) else ok=wlan and wlan.connect and wlan.connect(p.ssid,p.password,1) end
        send_command_result(id,ok==nil and true or ok,ok and nil or "wifi_connect_failed",{ssid=p.ssid,security=p.security or "auto"})
        return
    end
    if msg.type == "command.wifi_disconnect" then
        local ok=wlan and wlan.disconnect and wlan.disconnect()
        send_command_result(id,ok==nil and true or ok,ok and nil or "wifi_disconnect_failed")
        return
    end
    send_command_result(id,false,"unsupported_command")
end
if websocket and cfg.relay_url and not cfg.relay_url:find("example%.invalid",1,true) then
    sys.taskInit(function()
        local backoff=reconnect.new()
        local ip_ready=false
        if sys.subscribe then
            sys.subscribe("IP_READY",function() ip_ready=true end)
        end
        local function network_ready()
            if ip_ready then return true end
            if socket and socket.adapter and socket.dft then
                local ok, adapter = pcall(socket.adapter, socket.dft())
                return ok and adapter ~= nil and adapter ~= false
            end
            return false
        end
        while true do
            -- The Air8000 WebSocket client must not be started during boot
            -- before the Wi-Fi adapter has acquired an address.  Otherwise
            -- connect() can remain pending without ever sending a handshake.
            local network_wait=0
            while not network_ready() and network_wait < 30000 do
                sys.waitUntil("IP_READY", 1000)
                network_wait=network_wait+1000
            end
            if not network_ready() then
                if log then log.warn("airsim.relay", "network_wait_timeout") end
                sys.wait(5000)
            end
            -- Air8000 has both cellular and Wi-Fi interfaces.  Make the
            -- WebSocket route explicit so it cannot follow a stale cellular
            -- default after Wi-Fi DHCP succeeds.
            if socket and socket.dft and socket.LWIP_STA then
                pcall(socket.dft, socket.LWIP_STA)
            end
            if log then log.info("airsim.relay", "network_ready") end
            local transport
            transport=ws_transport.new(websocket,handle_relay_message,function() backoff:reset(); _G.relay_transport=transport; _G.relay_client=relay_module.new(cfg,transport); _G.relay_client:register(status) end,function(reason) stop_media(); _G.relay_transport=nil; _G.relay_client=nil; if log then log.warn("airsim.relay", "disconnected", tostring(reason or "unknown")) end end)
            local ok=transport:connect(cfg.relay_url)
            if not ok and log then log.warn("airsim.relay", "connect_failed", tostring(cfg.relay_url)) end
            if ok then
                -- LuatOS websocket:connect starts asynchronously; wait for
                -- conack before deciding that registration failed.
                local waited=0
                while not transport.connected and waited < 10000 do
                    sys.wait(100)
                    waited=waited+100
                end
                if transport.connected then
                    while transport.connected do sys.wait(1000) end
                end
            end
            transport:close(); stop_media(); _G.relay_transport=nil; _G.relay_client=nil; sys.wait(backoff:next())
        end
    end)
end
if log then log.info("airsim","Air8000A backend starting",PROJECT,VERSION) end
if sys and sys.subscribe then sys.subscribe("CC_IND",function(s) if _G.call_service then _G.call_service:on_cc(s) end end); sys.subscribe("SMS_INC",function(sender,body,ts) if _G.sms_service then _G.sms_service:on_receive(sender,body,ts) end end) end
if sys and sys.run then sys.run() end
