local M = {}
M.states = { IDLE=true, DIALING=true, RINGING_OUT=true, INCOMING=true, CONNECTING=true,
    CONNECTED=true, DISCONNECTING=true, ENDED=true, FAILED=true }
local transitions = {
    IDLE={dial="DIALING", incoming="INCOMING"}, DIALING={ringing="RINGING_OUT", connected="CONNECTED", failed="FAILED", cancel="DISCONNECTING", hangup="DISCONNECTING"},
    RINGING_OUT={connected="CONNECTED", failed="FAILED", cancel="DISCONNECTING", hangup="DISCONNECTING", remote_hangup="ENDED", ended="ENDED"}, INCOMING={answer="CONNECTING", reject="DISCONNECTING", hangup="DISCONNECTING", remote_hangup="ENDED", ended="ENDED"},
    CONNECTING={connected="CONNECTED", failed="FAILED", hangup="DISCONNECTING"}, CONNECTED={hangup="DISCONNECTING", remote_hangup="DISCONNECTING"},
    DISCONNECTING={ended="ENDED", remote_hangup="ENDED", failed="FAILED"}, ENDED={}, FAILED={}
}
function M.new(id, direction, now)
    return { call_id=id, direction=direction, state="IDLE", control_transport="relay", media_transport="relay_pcm",
        media_backend=nil, start_time=now, connect_time=nil, end_time=nil, generation=1 }
end
function M.step(call, event, now)
    local next_state = transitions[call.state] and transitions[call.state][event]
    if not next_state then
        if (call.state == "ENDED" or call.state == "FAILED") and event == "duplicate" then return true end
        return false, "invalid_transition" end
    call.state = next_state
    if next_state == "CONNECTED" then call.connect_time = now end
    if next_state == "ENDED" or next_state == "FAILED" then call.end_time = now end
    return true
end
return M
