local M={}
local function present(api) return api~=nil and (type(api)=="table" or type(api)=="function") end
local function fn(api,name) return api and type(api[name])=="function" end
function M.probe(env)
    local cc=env.cc or {}
    local av=env.audio_v2 or {}
    local vp=env.voip or {}
    local c={
        voice=present(env.cc),
        sms=present(env.sms),
        gnss=present(env.gnss),
        wifi=present(env.wlan),
        websocket=present(env.websocket),
        crypto=present(env.crypto),
        fskv=present(env.fskv),
        fota=present(env.fota),
        direct_pcm=fn(cc,"record") and fn(cc,"input") and fn(cc,"extern_source") and av.DATA_CODEC_TYPE_RAW~=nil,
        carrier_rtp_pcm=cc.AUDIO_MODE_BRIDGE_PCM~=nil and fn(cc,"bridgePcmStats") and fn(cc,"bridgeAudioStop") and
            fn(vp,"setAudioMode") and vp.AUDIO_MODE_BRIDGE~=nil and fn(vp,"pcmIn") and fn(vp,"pcmOut") and fn(vp,"start") and fn(vp,"stop") and fn(vp,"on"),
        sip_bridge=present(env.sip),
    }
    c.real_early_media=c.carrier_rtp_pcm
    c.required_ok=c.voice and c.sms and c.websocket and c.crypto and c.fskv and c.gnss
    return c
end
return M
