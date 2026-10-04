local calls = require("protocol.calls")
local M = {}
function M.new(cc, emit, now) return setmetatable({ cc=cc, emit=emit or function() end, now=now or function() return os.time()*1000 end, current=nil }, {__index=M}) end
function M:transition(event, data)
    if not self.current then return false,"no_call" end
    local ok,err=calls.step(self.current,event,self.now()); if not ok then return false,err end
    self.emit("call.state", { call=self.current, event=event, data=data }); return true
end
function M:dial(id, number)
    if self.current then return false,"busy" end
    local call=calls.new(id,"outgoing",self.now()); call.number=number; self.current=call
    local changed,err=calls.step(call,"dial",self.now())
    if not changed then self.current=nil; return false,err end
    -- Publish the local dialing state before entering the modem API.  The
    -- modem call is asynchronous, but some firmware revisions can spend time
    -- inside the API while waiting for the network command queue.  The relay
    -- and phone UI must not wait for that carrier-side work.
    self.emit("call.state",{call=call,event="dial"})
    local ok=self.cc and self.cc.dial and self.cc.dial(0,number) ~= false
    if not ok then call.state="FAILED"; self.emit("call.state",{call=call,event="failed"}); self.current=nil; return false,"dial_failed" end
    return true
end
function M:answer()
    if not self.current then return false,"no_call" end
    local call=self.current
    local changed,err=calls.step(call,"answer",self.now())
    if not changed then return false,err end
    self.emit("call.state",{call=call,event="answer"})
    local ok=self.cc and self.cc.accept and self.cc.accept(0) ~= false
    if not ok then call.state="FAILED"; self.emit("call.state",{call=call,event="failed"}); self.current=nil; return false,"answer_failed" end
    return true
end
function M:reject()
    if not self.current then return false,"no_call" end
    local call=self.current
    local changed,err=calls.step(call,"reject",self.now())
    if not changed then return false,err end
    local ok=self.cc and self.cc.hangUp and self.cc.hangUp(0) ~= false
    if not ok then call.state="FAILED"; self.emit("call.state",{call=call,event="failed"}); self.current=nil; return false,"reject_failed" end
    if self.current==call then self.emit("call.state",{call=call,event="reject"}) end
    return true
end
function M:hangup()
    if not self.current then return false,"no_call" end
    if not self.cc or not self.cc.hangUp then return false,"hangup_unsupported" end
    -- Move the local state first so a synchronous HANGUP_CALL_DONE callback
    -- from the modem is handled as DISCONNECTING.  Emit the relay event only
    -- after the modem call, so network I/O cannot delay the real hang-up.
    local call=self.current
    local changed,err=calls.step(call,"hangup",self.now())
    if not changed then return false,err end
    if log then log.info("airsim.call", "hangup_request", call.state) end
    local ok=self.cc.hangUp(0) ~= false
    if log then log.info("airsim.call", "hangup_queued", tostring(ok)) end
    if not ok then
        call.state="CONNECTED"
        return false,"hangup_failed"
    end
    -- Queue the modem release before emitting the relay event.  The event
    -- handler stops PCM; doing that first can delay cc.hangUp on Air8000.
    self.emit("call.state",{call=call,event="hangup"})
    -- The modem may already have emitted HANGUP_CALL_DONE and cleared the
    -- current call synchronously. In that case the ended event was emitted by
    -- on_cc and must not be duplicated here.
    return true
end
function M:dtmf(digit)
    if not self.current or self.current.state~="CONNECTED" then return false,"not_connected" end
    if not self.cc or not self.cc.dtmf then return false,"dtmf_unsupported" end
    return self.cc.dtmf(0,digit) ~= false
end
function M:on_cc(status)
    local map={INCOMINGCALL="incoming",MAKE_CALL_OK="ringing",MAKE_CALL_FAILED="failed",ANSWER_CALL_DONE="answer_done",SPEECH_START="connected",DISCONNECTED="remote_hangup",HANGUP_CALL_DONE="ended",CONNECTED="connected"}
    if status=="INCOMINGCALL" and not self.current then self.current=calls.new(tostring(self.now()),"incoming",self.now()); self.current.number=self.cc.lastNum and self.cc.lastNum(); self:transition("incoming"); return end
    local e=map[status]; if not e or not self.current then return end
    if log then log.info("airsim.call", "modem_event", tostring(status)) end
    if e=="ended" and (self.current.state=="DISCONNECTING" or self.current.state=="INCOMING" or self.current.state=="RINGING_OUT" or self.current.state=="DIALING" or self.current.state=="CONNECTING") then self:transition("ended") elseif e=="remote_hangup" then if self:transition("remote_hangup") then self:transition("ended") end elseif e=="failed" then self:transition("failed") elseif e=="ringing" then self:transition("ringing") elseif e=="answer_done" then self.emit("call.state",{call=self.current,event="answer_done"}) else self:transition(e) end
    if self.current.state=="ENDED" or self.current.state=="FAILED" then self.current=nil end
end
return M
