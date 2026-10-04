local M={}
local function present(api) return api~=nil and (type(api)=="table" or type(api)=="function") end
function M.probe(env)
    local cc=env.cc or {}
    local av=env.audio_v2 or {}
    local c={
        voice=present(env.cc),
        sms=present(env.sms),
        gnss=present(env.gnss),
        wifi=present(env.wlan),
        websocket=present(env.websocket),
        crypto=present(env.crypto),
        fskv=present(env.fskv),
        fota=present(env.fota),
        direct_pcm=type(cc.record)=="function" and type(cc.input)=="function" and
            type(cc.extern_source)=="function" and av.DATA_CODEC_TYPE_RAW~=nil,
        sip_bridge=present(env.sip),
    }
    c.required_ok=c.voice and c.sms and c.websocket and c.crypto and c.fskv and c.gnss
    return c
end
return M
