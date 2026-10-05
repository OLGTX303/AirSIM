local M = {}
M.IDLE = "IDLE"
M.DIALING = "DIALING"
M.SIP_EARLY_MEDIA = "SIP_EARLY_MEDIA"
M.SWITCHING_TO_DIRECT_PCM = "SWITCHING_TO_DIRECT_PCM"
M.DIRECT_PCM_CONNECTED = "DIRECT_PCM_CONNECTED"
M.ENDING = "ENDING"
local allowed = {
    IDLE={DIALING=true,SIP_EARLY_MEDIA=true},
    DIALING={SIP_EARLY_MEDIA=true,SWITCHING_TO_DIRECT_PCM=true,ENDING=true,IDLE=true},
    SIP_EARLY_MEDIA={SWITCHING_TO_DIRECT_PCM=true,ENDING=true,IDLE=true},
    SWITCHING_TO_DIRECT_PCM={DIRECT_PCM_CONNECTED=true,SIP_EARLY_MEDIA=true,ENDING=true,IDLE=true},
    DIRECT_PCM_CONNECTED={ENDING=true,IDLE=true},
    ENDING={IDLE=true},
}
function M.new(emit)
    return setmetatable({state=M.IDLE,emit=emit or function() end},{__index=M})
end
function M:transition(next_state,reason)
    if self.state==next_state then return true end
    if not allowed[self.state] or not allowed[self.state][next_state] then
        return false,"invalid_media_phase:"..tostring(self.state).."->"..tostring(next_state)
    end
    local previous=self.state; self.state=next_state; self.emit(next_state,previous,reason); return true
end
function M:is(state) return self.state==state end
return M
