local M={}
function M.select(config,caps,sip_enabled)
    config=config or "compatible"
    caps=caps or {}
    local sip_ok=caps.sip_bridge and sip_enabled==true
    if config=="compatible" or config=="sip_bridge" then
        if sip_ok then return "sip_bridge" end
        if caps.direct_pcm then return "direct_pcm" end
    elseif config=="wideband" or config=="direct_pcm" then
        if caps.direct_pcm then return "direct_pcm" end
        if sip_ok then return "sip_bridge" end
    elseif config=="carrier_rtp" or config=="auto" then
        if sip_ok then return "sip_bridge" end
        if caps.direct_pcm then return "direct_pcm" end
    end
    if sip_ok then return "sip_bridge" end
    if caps.direct_pcm then return "direct_pcm" end
    return nil
end
return M
