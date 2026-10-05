local M = {}

local function has(api,name)
    return api and type(api[name])=="function"
end

function M.new(cc,voip,socket_api)
    return setmetatable({
        cc=cc,
        voip=voip,
        socket=socket_api,
        initialized=false,
        configured=false,
        active=false,
        call_id=nil,
        config=nil,
        early_media=false,
        connected=false,
        voip_state="idle",
        voip_stats={},
        cc_stats={},
    },{__index=M})
end

function M:supported()
    return self.cc and self.voip and
        self.cc.AUDIO_MODE_BRIDGE_PCM~=nil and
        has(self.cc,"bridgePcmStats") and has(self.cc,"bridgeAudioStop") and
        has(self.voip,"setAudioMode") and self.voip.AUDIO_MODE_BRIDGE~=nil and
        has(self.voip,"pcmIn") and has(self.voip,"pcmOut") and
        has(self.voip,"start") and has(self.voip,"stop") and has(self.voip,"on")
end

function M:init()
    if self.initialized then return true end
    if not self:supported() then return false,"carrier_rtp_unsupported" end

    local ok_mode,mode_result=pcall(self.voip.setAudioMode,self.voip.AUDIO_MODE_BRIDGE)
    if not ok_mode or mode_result==false then return false,"voip_bridge_mode_failed" end

    local ok_init,init_result,init_reason=pcall(self.cc.init,0,self.cc.AUDIO_MODE_BRIDGE_PCM)
    if not ok_init or init_result==false then
        return false,tostring(init_reason or init_result or "cc_bridge_pcm_init_failed")
    end

    pcall(self.voip.on,"state",function(state)
        self.voip_state=tostring(state or "unknown")
        if state=="started" then self.active=true end
        if state=="stopped" or state=="idle" or state=="error" then self.active=false end
        if log then log.info("airsim.carrier_rtp","voip_state",self.voip_state) end
    end)
    pcall(self.voip.on,"stats",function(stats)
        if type(stats)=="table" then self.voip_stats=stats end
    end)
    pcall(self.voip.on,"error",function(err)
        if log then log.error("airsim.carrier_rtp","voip_error",tostring(err or "unknown")) end
    end)

    self.initialized=true
    if log then log.info("airsim.carrier_rtp","cc_backend","bridge_pcm") end
    return true
end

function M:configure(value)
    if type(value)~="table" then return false,"invalid_rtp_config" end
    local host=value.host or value.remote_ip
    local port=tonumber(value.port or value.remote_port)
    if type(host)~="string" or #host<3 or #host>255 or not port or port<1 or port>65535 then
        return false,"invalid_rtp_endpoint"
    end
    self.config={
        host=host,
        port=math.floor(port),
        codec=tostring(value.codec or "PCMU"),
        sample_rate=tonumber(value.sample_rate) or 8000,
        ptime=tonumber(value.ptime) or 20,
        generation=value.generation,
    }
    self.configured=true
    if sys and sys.publish then sys.publish("AIRSIM_RTP_CONFIG") end
    if log then log.info("airsim.carrier_rtp","configured",host,port) end
    return true
end

function M:wait_for_config(timeout_ms)
    if self.configured then return true end
    if sys and sys.waitUntil then sys.waitUntil("AIRSIM_RTP_CONFIG",timeout_ms or 2000) end
    return self.configured
end

function M:start(call_id)
    if self.active and self.call_id==call_id then return true end
    if not self.initialized then
        local ok,err=self:init()
        if not ok then return false,err end
    end
    if not self:wait_for_config(2000) then return false,"rtp_endpoint_not_configured" end

    if self.active then self:stop(false) end

    local codec=self.voip.PCMU
    if self.config.codec=="PCMA" and self.voip.PCMA~=nil then codec=self.voip.PCMA end
    if codec==nil then codec=0 end

    local opts={
        remote_ip=self.config.host,
        remote_port=self.config.port,
        local_port=0,
        codec=codec,
        ptime=20,
        sample_rate=8000,
        jitter_depth=3,
        multimedia_id=0,
        stats_interval=5000,
        aec=false,
    }
    if self.socket and self.socket.LWIP_STA~=nil then opts.adapter=self.socket.LWIP_STA end

    local ok,result=pcall(self.voip.start,opts)
    if not ok or result==false then
        self.active=false
        return false,"voip_rtp_start_failed"
    end

    self.call_id=call_id
    self.active=true
    self.early_media=false
    self.connected=false
    if log then log.info("airsim.carrier_rtp","start",tostring(call_id),self.config.host,self.config.port) end
    return true
end

function M:on_cc(status,value,session)
    if status=="PLAY" and tonumber(value)~=0 then
        self.early_media=true
        if log then log.info("airsim.carrier_rtp","carrier_media_play",tostring(value),tostring(session or "")) end
    elseif status=="PLAY_STOP" or (status=="PLAY" and tonumber(value)==0) then
        self.early_media=false
    elseif status=="CONNECTED" or status=="CONNECTED_NUMBER" or status=="SPEECH_START" then
        self.connected=true
    elseif status=="DISCONNECTED" or status=="HANGUP_CALL_DONE" or status=="MAKE_CALL_FAILED" then
        self.connected=false
        self.early_media=false
    end

    if has(self.cc,"bridgePcmStats") then
        local ok,stats=pcall(self.cc.bridgePcmStats)
        if ok and type(stats)=="table" then self.cc_stats=stats end
    end
end

function M:stats()
    if has(self.cc,"bridgePcmStats") then
        local ok,stats=pcall(self.cc.bridgePcmStats)
        if ok and type(stats)=="table" then self.cc_stats=stats end
    end
    return {
        backend="carrier_rtp",
        active=self.active,
        configured=self.configured,
        call_id=self.call_id,
        early_media=self.early_media,
        connected=self.connected,
        sample_rate=8000,
        downlink_sample_rate=8000,
        uplink_sample_rate=8000,
        codec=self.config and self.config.codec or "PCMU",
        voip_state=self.voip_state,
        voip=self.voip_stats,
        cc=self.cc_stats,
    }
end

function M:stop(finalize_cc)
    if self.voip and type(self.voip.stop)=="function" then pcall(self.voip.stop) end
    if finalize_cc and self.cc and type(self.cc.bridgeAudioStop)=="function" then pcall(self.cc.bridgeAudioStop) end
    self.active=false
    self.call_id=nil
    self.early_media=false
    self.connected=false
end

return M
