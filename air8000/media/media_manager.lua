local M = {}
function M.select(config, caps) if config == "direct_pcm" and caps.direct_pcm then return "direct_pcm" end
    if config == "sip_bridge" and caps.sip_bridge then return "sip_bridge" end
    if config == "auto" and caps.direct_pcm then return "direct_pcm" end
    if caps.sip_bridge then return "sip_bridge" end return nil end
return M
