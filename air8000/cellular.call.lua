local calls = require("protocol.calls")
local M = {}

function M.new(cc,emit,now)
    return setmetatable({
        cc=cc,
        emit=emit or function() end,
        now=now or function() return os.time()*1000 end,
        current=nil,
        audio_started=false,
    },{__index=M})
end

function M:transition(event,data)
    if not self.current then return false,"no_call" end
    local ok,err=calls.step(self.current,event,self.now())
    if not ok then return false,err end
    self.emit("call.state",{call=self.current,event=event,data=data})
    return true
end

function M:dial(id,number)
    if self.current then return false,"busy" end
    local call=calls.new(id,"outgoing",self.now())
    call.number=number
    self.current=call
    self.audio_started=false
    local changed,err=calls.step(call,"dial",self.now())
    if not changed then self.current=nil; return false,err end
    self.emit("call.state",{call=call,event="dial"})
    local ok=self.cc and self.cc.dial and self.cc.dial(0,number)~=false
    if not ok then
        call.state="FAILED"
        self.emit("call.state",{call=call,event="failed"})
        self.current=nil
        return false,"dial_failed"
    end
    return true
end

function M:answer()
    if not self.current then return false,"no_call" end
    local call=self.current
    local changed,err=calls.step(call,"answer",self.now())
    if not changed then return false,err end
    self.emit("call.state",{call=call,event="answer"})
    local ok=self.cc and self.cc.accept and self.cc.accept(0)~=false
    if not ok then
        call.state="FAILED"
        self.emit("call.state",{call=call,event="failed"})
        self.current=nil
        return false,"answer_failed"
    end
    return true
end

function M:reject()
    if not self.current then return false,"no_call" end
    local call=self.current
    local changed,err=calls.step(call,"reject",self.now())
    if not changed then return false,err end
    local ok=self.cc and self.cc.hangUp and self.cc.hangUp(0)~=false
    if not ok then
        call.state="FAILED"
        self.emit("call.state",{call=call,event="failed"})
        self.current=nil
        return false,"reject_failed"
    end
    if self.current==call then self.emit("call.state",{call=call,event="reject"}) end
    return true
end

function M:hangup()
    if not self.current then return false,"no_call" end
    if not self.cc or not self.cc.hangUp then return false,"hangup_unsupported" end
    local call=self.current
    local changed,err=calls.step(call,"hangup",self.now())
    if not changed then return false,err end
    if log then log.info("airsim.call","hangup_request",call.state) end
    local ok=self.cc.hangUp(0)~=false
    if log then log.info("airsim.call","hangup_queued",tostring(ok)) end
    if not ok then
        call.state="CONNECTED"
        return false,"hangup_failed"
    end
    self.emit("call.state",{call=call,event="hangup"})
    return true
end

function M:dtmf(digit)
    if not self.current or self.current.state~="CONNECTED" then return false,"not_connected" end
    if not self.cc or not self.cc.dtmf then return false,"dtmf_unsupported" end
    return self.cc.dtmf(0,digit)~=false
end

function M:emit_audio_start(source,value,session)
    if not self.current or self.audio_started then return end
    self.audio_started=true
    self.emit("call.audio_start",{call=self.current,event=source or "audio_start",value=value,session=session})
end

function M:on_cc(status,value,session)
    if status=="PLAY" then
        if self.current then
            self.emit("call.media",{call=self.current,event=tonumber(value)==0 and "play_stop" or "play",value=value,session=session})
        end
        return
    end
    if status=="PLAY_STOP" then
        if self.current then self.emit("call.media",{call=self.current,event="play_stop",value=value,session=session}) end
        return
    end
    if status=="AUDIO_START" then
        if log then log.info("airsim.call","modem_event","AUDIO_START",tostring(value or ""),tostring(session or "")) end
        self:emit_audio_start("audio_start",value,session)
        return
    end
    if status=="EXT_SRC_DONE" then
        if self.current then self.emit("call.audio_source_done",{call=self.current,value=value,session=session}) end
        return
    end

    local map={
        INCOMINGCALL="incoming",
        MAKE_CALL_OK="ringing",
        MAKE_CALL_FAILED="failed",
        ANSWER_CALL_DONE="answer_done",
        SPEECH_START="connected",
        DISCONNECTED="remote_hangup",
        HANGUP_CALL_DONE="ended",
        CONNECTED="connected",
        CONNECTED_NUMBER="connected",
    }

    if status=="INCOMINGCALL" and not self.current then
        self.current=calls.new(tostring(self.now()),"incoming",self.now())
        self.current.number=self.cc.lastNum and self.cc.lastNum()
        self.current.session=session
        self.audio_started=false
        self:transition("incoming",{value=value,session=session})
        return
    end

    local e=map[status]
    if not e or not self.current then return end
    if session~=nil then self.current.session=session end
    if log then log.info("airsim.call","modem_event",tostring(status),tostring(value or ""),tostring(session or "")) end

    if e=="connected" and self.current.state=="CONNECTED" then
        if status=="SPEECH_START" then self:emit_audio_start("speech_start_fallback",value,session) end
        return
    end

    if e=="ended" then
        local state=self.current.state
        if state=="DISCONNECTING" or state=="INCOMING" or state=="RINGING_OUT" or
           state=="DIALING" or state=="CONNECTING" or state=="CONNECTED" then
            self:transition("ended",{value=value,session=session})
        end
    elseif e=="remote_hangup" then
        if self:transition("remote_hangup",{value=value,session=session}) and self.current then
            self:transition("ended",{value=value,session=session})
        end
    elseif e=="failed" then
        self:transition("failed",{value=value,session=session})
    elseif e=="ringing" then
        self:transition("ringing",{value=value,session=session})
    elseif e=="answer_done" then
        self.emit("call.state",{call=self.current,event="answer_done",data={value=value,session=session}})
    else
        self:transition(e,{value=value,session=session})
    end

    if status=="SPEECH_START" then self:emit_audio_start("speech_start_fallback",value,session) end

    if self.current and (self.current.state=="ENDED" or self.current.state=="FAILED") then
        self.current=nil
        self.audio_started=false
    end
end

return M
