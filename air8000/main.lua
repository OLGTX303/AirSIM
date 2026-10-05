PROJECT="airsim-air8000"; VERSION="001.002.001"
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
local wifi_status=require("system.wifi_status")
local call_module=require("cellular.call")
local sms_module=require("cellular.sms")
local pcm_module=require("media.direct_pcm")
local carrier_rtp_module=require("media.carrier_rtp")
local media_manager=require("media.media_manager")
local exsip=nil
do
    local ok,module=pcall(require,"exsip")
    if ok and type(module)=="table" then exsip=module end
end
local kv_api=nil
if fskv then
    if fskv.init then pcall(fskv.init) end
    kv_api={
        get=function(_,key) if fskv.init then fskv.init() end; return fskv.get(key) end,
        set=function(_,key,value) if fskv.init then fskv.init() end; return fskv.set(key,value) end
    }
end
if kv_api then cfg=settings.load(kv_api,cfg) end
local gnss_api=_G.exgnss
if not gnss_api then
    local ok,module=pcall(require,"exgnss")
    if ok and module then gnss_api=module; _G.exgnss=module end
end
if not gnss_api then gnss_api=libgnss end
local sip_cfg=type(cfg.sip)=="table" and cfg.sip or {}
local requested_media_backend=cfg.media_backend or "auto"
-- Stock LuatOS CC<->SIP bridging must be selected before cc.init().  Keep it
-- explicitly opt-in because the VPS must also provide a SIP endpoint; the
-- normal LAN WebSocket path remains the safe default until then.
local sip_credentials_present=exsip and
    type(sip_cfg.password or sip_cfg.sip_password)=="string" and
    #(sip_cfg.password or sip_cfg.sip_password)>0
if requested_media_backend=="auto" and exsip and (sip_cfg.enabled==true or sip_credentials_present) then
    requested_media_backend="sip_bridge"
    -- Older generated configs only contain sip.password and leave enabled
    -- false.  Treat the supplied SIP credentials as an explicit migration
    -- signal, without rewriting the protected config file on disk.
    sip_cfg.enabled=true
end
local caps=capability.probe({cc=cc,sms=sms,gnss=gnss_api,wlan=wlan,websocket=websocket,crypto=crypto,fskv=fskv,fota=fota,sip=exsip,audio_v2=audio_v2,voip=voip})
local media_backend=media_manager.select(requested_media_backend,caps)
if log then log.info("airsim.media","selection",requested_media_backend,tostring(media_backend or "none"),"sip_enabled",tostring(sip_cfg.enabled==true),"exsip",tostring(exsip~=nil)) end
local device_identity=identity.read(mobile,mcu,cfg)
local status=device.status(caps,device_identity); status.firmware=tostring(_G.VERSION or VERSION); status.media_backend=media_backend; status.real_early_media=media_backend=="carrier_rtp" or media_backend=="sip_bridge"; status.target_cellular_voice_rate=16000; status.wideband_volte=false
local wifi_cache={ssid=cfg.wifi and cfg.wifi.ssid or nil}

local function now_ms()
    return os.time()*1000
end

local function wifi_snapshot(event,data)
    local snap=wifi_status.snapshot(wlan,cfg,wifi_cache,event,data,now_ms())
    status.wifi_state=snap.state
    status.wifi=snap
    return snap
end

local function publish_wifi(event,data)
    local snap=wifi_snapshot(event,data)
    if _G.relay_client then _G.relay_client:send("device.wifi",snap,now_ms()) end
    if log and event~="POLL" then log.info("airsim.wifi",snap.state,tostring(snap.ssid or ""),tostring(snap.ip or ""),tostring(snap.rssi or "")) end
    return snap
end

if wlan and wlan.init then pcall(wlan.init) end
wifi_snapshot("BOOT")
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
local carrier_rtp=carrier_rtp_module.new(cc,voip,socket)
local media_frames=0
local media_bytes=0
local uplink_frames=0
local uplink_bytes=0
local downlink_pending=""

local bridge_tone_active=false
local bridge_tone_generation=0

local function set_bridge_tone(enabled,reason)
    if media_backend~="sip_bridge" then enabled=false end
    bridge_tone_generation=bridge_tone_generation+1
    local generation=bridge_tone_generation

    local function apply()
        if generation~=bridge_tone_generation then return false end
        if enabled then
            -- The retry task can outlive the 183 phase; never start ringback
            -- once the cellular leg is carrying speech.
            local current=_G.call_service and _G.call_service.current
            if not current or tostring(current.state or "")=="CONNECTED" then return true end
        end
        local applied=false
        if cc and type(cc.bridgeTone)=="function" then
            local ok,result=pcall(cc.bridgeTone,enabled)
            applied=ok and result~=false
        elseif voip and type(voip.bridgeTone)=="function" then
            local ok,result=pcall(voip.bridgeTone,enabled)
            applied=ok and result~=false
        end
        if applied then
            bridge_tone_active=enabled
            if log then log.info("airsim.media","bridge_ringback",enabled and "on" or "off",tostring(reason or "")) end
        end
        return applied
    end

    if not enabled then
        apply()
        return true
    end

    -- cc.bridgeTone() only starts after the VoIP RTP engine is RUNNING. 183
    -- media-ready can arrive a few milliseconds earlier, so retry briefly.
    if sys and sys.taskInit then
        sys.taskInit(function()
            for _=1,20 do
                if generation~=bridge_tone_generation then return end
                if apply() then return end
                if sys.wait then sys.wait(50) end
            end
            if log then log.warn("airsim.media","bridge_ringback_start_timeout") end
        end)
        return true
    end
    return apply()
end

local function disable_bridge_tone(reason)
    return set_bridge_tone(false,reason or "disable")
end

local function cellular_voice_rate()
    if not cc or type(cc.quality)~="function" then return 0 end
    local ok,value=pcall(cc.quality)
    if not ok then return 0 end
    value=tonumber(value) or 0
    if value==1 then return 8000 end
    if value==2 then return 16000 end
    if value>=8000 then return value end
    return 0
end

local function publish_voice_quality(reason)
    local rate=cellular_voice_rate()
    if rate<=0 then return nil end
    local wideband=rate>=16000
    status.cellular_voice_rate=rate
    status.wideband_volte=wideband
    status.voice_codec=wideband and "AMR-WB" or "AMR-NB"
    if _G.relay_client then
        _G.relay_client:send("media.voice_quality",{
            backend=media_backend,
            cellular_sample_rate=rate,
            wideband_volte=wideband,
            voice_codec=status.voice_codec,
            target_cellular_sample_rate=16000,
            sip_rtp_sample_rate=media_backend=="sip_bridge" and 8000 or rate,
            reason=reason,
        },os.time()*1000)
    end
    if log then log.info("airsim.media","volte_quality",status.voice_codec,rate,tostring(reason or "")) end
    return rate
end

local function init_stock_sip_bridge()
    if not exsip then return false,"exsip_unavailable" end
    if sip_cfg.enabled~=true then return false,"sip_bridge_disabled" end
    local username=sip_cfg.sip_username or sip_cfg.username or cfg.device_id
    local password=sip_cfg.sip_password or sip_cfg.password
    local relay_host=type(cfg.relay_url)=="string" and cfg.relay_url:match("^[%w+.-]+://([^/:]+)") or nil
    local server=sip_cfg.sip_server_addr or sip_cfg.server_addr or relay_host
    if type(server)~="string" or server=="" or type(username)~="string" or username=="" or
       type(password)~="string" or password=="" then
        return false,"sip_bridge_config_incomplete"
    end
    local init_config={
        sip_server_addr=server,
        sip_server_port=tonumber(sip_cfg.sip_server_port or sip_cfg.server_port or 5060),
        sip_domain=sip_cfg.sip_domain or sip_cfg.domain or server,
        sip_username=username,
        sip_password=password,
        sip_transport=sip_cfg.sip_transport or "udp",
        rtp_port=tonumber(sip_cfg.rtp_port or 40000),
        codecs=sip_cfg.codecs or {"PCMU"},
        ptime=tonumber(sip_cfg.ptime or 20),
        cc_sip_bridge=true,
        auto_answer=sip_cfg.auto_answer==true,
        early_media=sip_cfg.early_media~=false,
        early_media_response=tonumber(sip_cfg.early_media_response or 183),
        adapter=sip_cfg.adapter or (socket and socket.LWIP_STA),
    }
    local ok,result=pcall(exsip.init,init_config)
    if not ok or result==false then return false,ok and "exsip_init_failed" or tostring(result) end
    disable_bridge_tone("bridge_init")
    if log then log.info("airsim.media","backend","sip_bridge","early_media",true,"target_volte_hz",16000) end
    return true
end

local function init_cc_backend()
    if media_backend=="sip_bridge" then
        local bridge_ok,bridge_err=init_stock_sip_bridge()
        if not bridge_ok then
            if log then log.warn("airsim.media","sip_bridge_init_failed",tostring(bridge_err or "unknown")) end
            if caps.direct_pcm then
                media_backend="direct_pcm"
                status.media_backend=media_backend
                status.real_early_media=false
            else
                return false,bridge_err
            end
        else
            if not cc or type(cc.init)~="function" then return false,"cc_init_unavailable" end
            local init_ok,init_result=pcall(cc.init,0)
            if log then log.info("airsim.call","cc_init",tostring(init_ok and init_result),"sip_bridge") end
            if not init_ok or init_result==false then return false,"cc_init_failed" end
            local start_ok,start_result=pcall(exsip.start)
            if log then log.info("airsim.sip","start",tostring(start_ok and start_result)) end
            if not start_ok or start_result==false then return false,"exsip_start_failed" end
            return true
        end
    end
    if media_backend=="carrier_rtp" then
        local ok,err=carrier_rtp:init()
        if ok then
            if log then log.info("airsim.media","backend","carrier_rtp","real_early_media") end
            return true
        end
        if log then log.warn("airsim.media","carrier_rtp_init_failed",tostring(err or "unknown")) end
        -- A failed bridge-PCM init does not lock the CC backend. Fall back to
        -- the legacy direct path only when its complete API is available.
        if caps.direct_pcm then
            media_backend="direct_pcm"
            status.media_backend=media_backend
                status.real_early_media=false
        else
            return false,err
        end
    end

    if cc and cc.init then
        local init_ok,init_result=pcall(cc.init,0)
        if log then log.info("airsim.call","cc_init",tostring(init_ok and init_result),tostring(media_backend or "none")) end
        return init_ok and init_result~=false
    end
    return false,"cc_init_unavailable"
end

init_cc_backend()

local function stop_media(finalize_cc)
    if media_backend=="carrier_rtp" then
        carrier_rtp:stop(finalize_cc==true)
    else
        if pcm.active then pcm:stop() end
    end
    downlink_pending=""
    uplink_frames=0
    uplink_bytes=0
end

local function send_downlink(payload)
    if media_backend~="direct_pcm" then return end
    if type(payload)~="string" or #payload==0 or not _G.relay_transport then return end
    downlink_pending=downlink_pending..payload
    local frame_bytes=pcm.sample_rate==16000 and 1280 or 640
    while #downlink_pending>=frame_bytes do
        local frame=downlink_pending:sub(1,frame_bytes)
        downlink_pending=downlink_pending:sub(frame_bytes+1)
        local sent=_G.relay_transport:send_binary(frame)
        if sent then
            media_frames=media_frames+1
            media_bytes=media_bytes+#frame
            if log and (media_frames==1 or media_frames%25==0) then
                log.info("airsim.media","downlink",media_frames,media_bytes)
            end
        else
            downlink_pending=frame..downlink_pending
            local max_tail=(pcm.sample_rate==16000 and 6400 or 3200)
            if #downlink_pending>max_tail then
                downlink_pending=downlink_pending:sub(#downlink_pending-max_tail+1)
            end
            if log then log.warn("airsim.media","downlink_send_failed",#frame) end
            break
        end
    end
end

local function current_media_stats()
    if media_backend=="carrier_rtp" then return carrier_rtp:stats() end
    return pcm:stats()
end

local function announce_media(kind)
    if not _G.relay_client then return end
    if media_backend=="sip_bridge" then
        _G.relay_client:send(kind,{
            call_id=exsip and exsip.get_current_call and exsip.get_current_call() or nil,
            backend="sip_bridge",
            transport="sip_rtp",
            real_early_media=true,
            sample_rate=8000,
            downlink_sample_rate=8000,
            uplink_sample_rate=8000,
            cellular_sample_rate=cellular_voice_rate(),
            target_cellular_sample_rate=16000,
            wideband_volte=cellular_voice_rate()>=16000,
            channels=1,
            bits=16,
            codec="PCMU",
            cellular_codec=cellular_voice_rate()>=16000 and "AMR-WB" or "AMR-NB/negotiating",
            format="pcm_s16le",
            frame_duration_ms=20,
        },os.time()*1000)
        return
    end
    local stats=current_media_stats()
    _G.relay_client:send(kind,{
        call_id=stats.call_id,
        backend=media_backend,
        transport=media_backend=="carrier_rtp" and "rtp_pcmu" or "websocket_pcm",
        real_early_media=media_backend=="carrier_rtp",
        sample_rate=stats.sample_rate or stats.downlink_sample_rate or 8000,
        downlink_sample_rate=stats.downlink_sample_rate or stats.sample_rate or 8000,
        uplink_sample_rate=stats.uplink_sample_rate or stats.sample_rate or 8000,
        channels=1,
        bits=16,
        codec=stats.codec,
        format="pcm_s16le",
        frame_duration_ms=media_backend=="carrier_rtp" and 20 or 40,
        stats=stats,
    },os.time()*1000)
end

local function start_direct_media(call)
    if pcm.active then return true end
    if not _G.relay_transport or not _G.relay_transport.send_binary then
        return false,"media_transport_unavailable"
    end
    media_frames=0
    media_bytes=0
    uplink_frames=0
    uplink_bytes=0
    downlink_pending=""
    local ok,err=pcm:start(call.call_id,function(is_dl,payload)
        if is_dl then send_downlink(payload) end
    end)
    if log then log.info("airsim.media","start_direct",tostring(ok),tostring(err or ""),tostring(pcm.sample_rate)) end
    if ok then announce_media("media.open") end
    return ok,err
end

local function start_carrier_media(call)
    local ok,err=carrier_rtp:start(call.call_id)
    if log then log.info("airsim.media","start_carrier_rtp",tostring(ok),tostring(err or "")) end
    if ok then announce_media("media.open") end
    return ok,err
end

local function start_uplink_source(call)
    if media_backend=="carrier_rtp" then
        if not carrier_rtp.active then return start_carrier_media(call) end
        return true
    end
    if not pcm.active then
        local ok,err=start_direct_media(call)
        if not ok then return false,err end
    end
    local ok,err=pcm:start_uplink_source()
    if log then
        local s=pcm:stats()
        log.info("airsim.media","uplink_source",tostring(ok),tostring(err or ""),s.sample_rate,s.uplink_sample_rate)
    end
    if ok then announce_media("media.ready") end
    return ok,err
end

local function emit_event(kind,payload)
    if kind=="call.state" then
        local ended=payload and (payload.event=="ended" or payload.event=="failed" or payload.event=="hangup" or
            payload.event=="reject" or payload.event=="remote_hangup" or payload.event=="disconnected")
        status.active_call=ended and nil or (payload and payload.call or status.active_call)
    end
    if kind=="call.state" and payload and payload.call then
        if media_backend=="carrier_rtp" then
            -- Start the native CC<->VoIP RTP bridge before cc.dial()/cc.accept()
            -- so carrier early media is not missed. No synthetic ringback is used.
            if payload.event=="dial" or payload.event=="answer" then
                start_carrier_media(payload.call)
            elseif payload.event=="ended" or payload.event=="failed" or payload.event=="hangup" or
                   payload.event=="reject" or payload.event=="remote_hangup" then
                stop_media(true)
            end
        elseif media_backend=="sip_bridge" then
            -- SIP owns the VoIP media engine.  CC remains the cellular leg:
            -- send 200/ACK only after the carrier reports connected, and tear
            -- down both legs when either side ends.
            if payload.event=="connected" then
                disable_bridge_tone("cellular_connected")
                if exsip then pcall(exsip.accept) end
                if sys and sys.timerStart then sys.timerStart(publish_voice_quality,250,"connected") end
            elseif payload.event=="failed" or payload.event=="hangup" or
                   payload.event=="reject" or payload.event=="remote_hangup" or payload.event=="ended" then
                disable_bridge_tone("call_end")
                if exsip then pcall(exsip.hangUp) end
            end
        else
            if payload.event=="connected" then
                start_direct_media(payload.call)
            elseif payload.event=="ended" or payload.event=="failed" or payload.event=="hangup" or
                   payload.event=="reject" or payload.event=="remote_hangup" then
                stop_media(true)
            end
        end
    elseif kind=="call.audio_start" and payload and payload.call then
        -- In stock CC<->SIP bridge mode the modem/VoIP C layer owns both
        -- directions. Starting the legacy direct_pcm source here races the
        -- bridge and produces "cc is not true start"/extern_source_failed.
        if media_backend~="sip_bridge" then
            start_uplink_source(payload.call)
        else
            disable_bridge_tone("audio_start")
            if sys and sys.timerStart then sys.timerStart(publish_voice_quality,250,"audio_start") end
            if log then log.info("airsim.media","sip_bridge_audio_start") end
        end
    elseif kind=="call.media" and media_backend=="carrier_rtp" then
        announce_media(payload.event=="play" and "media.early" or "media.phase")
    end
    if _G.relay_client then _G.relay_client:send(kind,payload,os.time()*1000) end
end
_G.call_service=call_module.new(cc,emit_event)
_G.sms_service=sms_module.new(sms,function(kind,payload) if _G.relay_client then _G.relay_client:send(kind,payload,os.time()*1000) end end,cfg.limits and cfg.limits.max_sms_body)
_G.gnss_service=gnss_module.new(gnss_api,cfg.location_policy)

local sip_refreshing=false
local last_sip_server_instance=nil

if media_backend=="sip_bridge" and exsip then
    exsip.on(function(event_type,action,payload)
        if event_type=="call" and action=="incoming" then
            local headers=type(payload) == "table" and payload.headers or {}
            local resume=headers and tostring(headers["x-airsim-resume"] or "")=="1"
            if resume then
                local current=_G.call_service and _G.call_service.current
                if not current then
                    pcall(exsip.fail,481,"No cellular call to resume")
                    return
                end
                if log then log.info("airsim.sip","resume_existing_cc",tostring(current.state or "")) end
                if tostring(current.state or "")=="CONNECTED" then
                    disable_bridge_tone("sip_resume_connected")
                    pcall(exsip.accept)
                    if sys and sys.timerStart then sys.timerStart(publish_voice_quality,250,"sip_resume") end
                else
                    pcall(exsip.progress)
                    set_bridge_tone(true,"sip_resume_progress")
                end
                return
            end
            local number=headers and (headers["x-airsim-number"] or headers["x-air8000-number"])
            if type(number)~="string" or number=="" then
                pcall(exsip.fail,400,"Missing cellular destination")
                return
            end
            local ok,err=_G.call_service:dial(payload.call_id or tostring(os.time()),number)
            if ok then
                -- Open SIP early media before the cellular leg answers.
                pcall(exsip.progress)
            else
                pcall(exsip.fail,486,tostring(err or "Cellular line busy"))
            end
        elseif event_type=="media" and action=="ready" then
            announce_media("media.open")
            -- A gateway resume re-opens SIP media on an already CONNECTED
            -- cellular call. Ringback must never be mixed into live speech.
            local current=_G.call_service and _G.call_service.current
            if current and tostring(current.state or "")~="CONNECTED" then
                set_bridge_tone(true,"sip_183_media_ready")
            else
                disable_bridge_tone("sip_media_ready_connected")
            end
        elseif event_type=="media" and action=="stop" then
            disable_bridge_tone("sip_media_stop")
            announce_media("media.close")
        elseif event_type=="voip" and action=="state" and tostring(payload)=="started" then
            if _G.call_service and _G.call_service.current and
               _G.call_service.current.state~="CONNECTED" then
                set_bridge_tone(true,"voip_started")
            end
        elseif event_type=="call" and (action=="ended" or action=="failed") then
            -- During a gateway-instance refresh the SIP dialog is intentionally
            -- replaced while the cellular call remains alive.
            if not sip_refreshing and _G.call_service.current then pcall(_G.call_service.hangup) end
        elseif event_type=="error" and log then
            log.warn("airsim.sip", "event_error")
        end
    end)
end
status.gnss_state=_G.gnss_service.state
status.location=_G.gnss_service.last

local function publish_location(sample)
    sample=sample or (_G.gnss_service and _G.gnss_service.last)
    if not sample then return nil end
    status.gnss_state=sample.fix_state or (_G.gnss_service and _G.gnss_service.state) or "unknown"
    status.location=sample
    if _G.relay_client then _G.relay_client:send("device.location",sample,now_ms()) end
    if log then log.info("airsim.gnss",tostring(sample.fix_state or "unknown"),tostring(sample.latitude or ""),tostring(sample.longitude or ""),tostring(sample.satellites or "")) end
    return sample
end

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
local function save_wifi_config(ssid,password,bssid,security)
    if type(ssid)~="string" or #ssid==0 or #ssid>64 or type(password)~="string" or #password>128 then return false,"invalid_wifi" end
    cfg.wifi={ssid=ssid,password=password,bssid=bssid,security=security or "auto"}
    wifi_cache.ssid=ssid
    if kv_api and kv_api.set then kv_api:set("config",cfg) end
    return true
end

local function run_async(fn)
    if sys and sys.taskInit then sys.taskInit(fn) else fn() end
end

local function refresh_sip_registration(reason)
    if media_backend~="sip_bridge" or not exsip or sip_refreshing then return false end
    sip_refreshing=true
    run_async(function()
        disable_bridge_tone("sip_refresh")
        if log then log.warn("airsim.sip","refresh_start",tostring(reason or "")) end
        pcall(exsip.stop)
        if sys and sys.wait then sys.wait(150) end
        local ok,result=pcall(exsip.start)
        sip_refreshing=false
        if log then log.info("airsim.sip","refresh_done",tostring(ok and result~=false),tostring(reason or "")) end
    end)
    return true
end

local function handle_gps_request(message_id)
    run_async(function()
        local started,start_error=_G.gnss_service:start()
        if not started then
            local failed={fix=false,fix_state="unavailable",error=start_error,timestamp=now_ms()}
            publish_location(failed)
            send_command_result(message_id,false,start_error or "gnss_unavailable",failed)
            return
        end

        publish_location({fix=false,fix_state="searching",timestamp=now_ms()})
        local sample
        for i=1,60 do
            sample=_G.gnss_service:sample(now_ms())
            if sample and sample.fix then break end
            if i==1 or i%5==0 then publish_location(sample) end
            if sys and sys.wait then sys.wait(1000) end
        end
        sample=sample or {fix=false,fix_state="lost",timestamp=now_ms()}
        publish_location(sample)
        send_command_result(message_id,sample.fix==true,sample.fix and nil or "gnss_fix_timeout",sample)
    end)
end

local function handle_wifi_connect(message_id,p)
    run_async(function()
        local saved,save_error=save_wifi_config(p.ssid,p.password,p.bssid,p.security)
        if not saved then send_command_result(message_id,false,save_error); return end
        publish_wifi("CONNECTING",p.ssid)

        local binary_bssid=type(p.bssid)=="string" and p.bssid:match("^[%da-fA-F]+$") and #p.bssid==12 and string.fromHex(p.bssid) or nil
        local initiated
        if binary_bssid then initiated=wlan and wlan.connect and wlan.connect(p.ssid,p.password,1,binary_bssid)
        else initiated=wlan and wlan.connect and wlan.connect(p.ssid,p.password,1) end
        if initiated==false then
            local snap=publish_wifi("DISCONNECTED","connect_rejected")
            send_command_result(message_id,false,"wifi_connect_failed",snap)
            return
        end

        local snap
        for _=1,40 do
            snap=wifi_snapshot("POLL")
            if snap.connected then break end
            if sys and sys.wait then sys.wait(500) end
        end
        snap=publish_wifi(snap and snap.connected and "IP_READY" or "POLL")
        send_command_result(message_id,snap.connected==true,snap.connected and nil or "wifi_connect_timeout",snap)
    end)
end
local function handle_relay_message(raw,fin,opcode)
    if tonumber(opcode)==2 then
        if media_backend=="direct_pcm" and pcm.active then
            local ok,err=pcm:push_uplink(raw)
            if ok then
                uplink_frames=uplink_frames+1
                uplink_bytes=uplink_bytes+#raw
                if log and (uplink_frames==1 or uplink_frames%25==0) then
                    log.info("airsim.media","uplink",uplink_frames,uplink_bytes,pcm:stats().uplink_pending_bytes)
                end
            elseif err~="audio_not_ready" and log then
                log.warn("airsim.media","uplink_failed",tostring(err or "unknown"))
            end
        end
        return
    end
    local msg=json.decode(raw or "")
    if type(msg) ~= "table" or type(msg.type) ~= "string" then return end
    local p=msg.payload or {}; local id=msg.message_id
    if msg.type == "device.register.ack" then
        local instance=msg.server_instance_id or p.server_instance_id
        if media_backend=="sip_bridge" and type(instance)=="string" and instance~="" and instance~=last_sip_server_instance then
            local previous=last_sip_server_instance
            last_sip_server_instance=instance
            refresh_sip_registration(previous and "gateway_restarted" or "gateway_sync")
        end
        return
    end
    if msg.type == "media.rtp_config" then
        if media_backend~="carrier_rtp" then return end
        local ok,err=carrier_rtp:configure(p)
        if _G.relay_client then
            _G.relay_client:send("media.rtp_config.ack",{ok=ok,error=err,backend=media_backend},os.time()*1000)
        end
        return
    end
    if msg.type == "command.dial" then
        dispatch_call_command(id,function()
            if media_backend=="carrier_rtp" then
                local ok,err=carrier_rtp:start(id)
                if not ok then return false,err end
            end
            local ok,err=_G.call_service:dial(id,p.number)
            if not ok and media_backend=="carrier_rtp" then carrier_rtp:stop(true) end
            return ok,err
        end)
        return
    end
    if msg.type == "command.answer" then
        dispatch_call_command(id,function()
            if media_backend=="carrier_rtp" then
                local call=_G.call_service.current
                local ok,err=carrier_rtp:start(call and call.call_id or id)
                if not ok then return false,err end
            end
            return _G.call_service:answer()
        end)
        return
    end
    if msg.type == "command.reject" then dispatch_call_command(id,function() return _G.call_service:reject() end); return end
    if msg.type == "command.hangup" then dispatch_call_command(id,function() return _G.call_service:hangup() end); return end
    if msg.type == "command.dtmf" then dispatch_call_command(id,function() return _G.call_service:dtmf(p.digit) end); return end
    if msg.type == "command.send_sms" then send_command_result(id,_G.sms_service:send(id,p.number,p.body),nil); return end
    if msg.type == "command.gps_request" then handle_gps_request(id); return end
    if msg.type == "command.wifi_config" then
        local snap=publish_wifi("POLL")
        snap.security=cfg.wifi and cfg.wifi.security or nil
        send_command_result(id,true,nil,snap)
        return
    end
    if msg.type == "command.wifi_connect" then handle_wifi_connect(id,p); return end
    if msg.type == "command.wifi_disconnect" then
        local before=publish_wifi("DISCONNECTING")
        send_command_result(id,true,nil,before)
        if wlan and wlan.disconnect then wlan.disconnect() end
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
            sys.subscribe("IP_LOSE",function() ip_ready=false end)
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
            transport=ws_transport.new(websocket,handle_relay_message,function()
                backoff:reset()
                _G.relay_transport=transport
                _G.relay_client=relay_module.new(cfg,transport)
                status.media_backend=media_backend
                status.real_early_media=media_backend=="carrier_rtp" or media_backend=="sip_bridge"
                status.wifi=wifi_snapshot("REGISTER")
                status.wifi_state=status.wifi.state
                status.gnss_state=_G.gnss_service and _G.gnss_service.state or status.gnss_state
                status.location=_G.gnss_service and _G.gnss_service.last or status.location
                status.active_call=_G.call_service and _G.call_service.current or nil
                _G.relay_client:register(status)
                publish_wifi("REGISTER")
                if status.location then publish_location(status.location) end
            end,function(reason)
                stop_media(false)
                _G.relay_transport=nil
                _G.relay_client=nil
                if log then log.warn("airsim.relay","disconnected",tostring(reason or "unknown")) end
            end)
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
            transport:close(); stop_media(false); _G.relay_transport=nil; _G.relay_client=nil; sys.wait(backoff:next())
        end
    end)
end
if log then log.info("airsim","Air8000A backend starting",PROJECT,VERSION) end
if sys and sys.subscribe then
    sys.subscribe("CC_IND",function(s,value,session)
        if media_backend=="carrier_rtp" then carrier_rtp:on_cc(s,value,session) end
        if _G.call_service then _G.call_service:on_cc(s,value,session) end
    end)
    sys.subscribe("SMS_INC",function(sender,body,ts)
        if _G.sms_service then _G.sms_service:on_receive(sender,body,ts) end
    end)
    sys.subscribe("WLAN_STA_INC",function(event,data)
        publish_wifi(event,data)
    end)
    sys.subscribe("IP_READY",function()
        if wlan and wlan.ready and wlan.ready() then publish_wifi("IP_READY") end
    end)
    sys.subscribe("IP_LOSE",function()
        if not (wlan and wlan.ready and wlan.ready()) then publish_wifi("IP_LOSE") end
    end)
    sys.subscribe("GNSS_STATE",function(event,ticks)
        if _G.gnss_service then publish_location(_G.gnss_service:on_state(event,now_ms())) end
    end)
end
if sys and sys.timerLoopStart then
    sys.timerLoopStart(function() publish_wifi("POLL") end,10000)
end
if sys and sys.run then sys.run() end
