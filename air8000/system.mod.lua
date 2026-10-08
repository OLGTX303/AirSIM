-- LuatTools flat-module compatibility entry.
local M={}
local function read_model()
    local providers={_G.hmeta,_G.rtos}
    for _,provider in ipairs(providers) do
        if provider then
            for _,name in ipairs({"model","bsp"}) do
                if type(provider[name])=="function" then
                    local ok,value=pcall(provider[name])
                    if ok and type(value)=="string" and value~="" then return value end
                end
            end
        end
    end
    return "unknown"
end
local raw=read_model()
local model=string.lower(raw)
M.raw_model=raw
M.model=raw
M.is_air8000a=model:find("air8000a",1,true)~=nil and model:find("air8000w",1,true)==nil
M.is_air8000w=model:find("air8000w",1,true)~=nil
-- The Air8000 A/W bridge hardware has no ES8311 codec.  SIP/CC bridge audio
-- is handled by the modem/VoIP bridge; only GNSS is A-module-specific here.
M.has_gnss=M.is_air8000a
M.has_es8311=false
M.has_local_audio=false
M.a_only_features={gnss=M.has_gnss,es8311=M.has_es8311,local_audio=M.has_local_audio}
return M
