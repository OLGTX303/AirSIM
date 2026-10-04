local M={}
function M.new(cc,framing,health) return setmetatable({cc=cc,framing=framing,health=health,active=false,input_ready=false,generation=0,input_buffer=nil},{__index=M}) end
function M:start(call_id,on_frame)
    if not self.cc or not self.cc.record or not self.cc.input then return false,"unsupported" end
    self.call_id=call_id; self.on_frame=on_frame; self.active=true; self.input_ready=false; self.generation=self.generation+1
    local generation=self.generation
    self.sample_rate=(self.cc.quality and self.cc.quality()==2) and 16000 or 8000
    self.input_buffer=zbuff.create(4096,0)
    local z1,z2,z3,z4=zbuff.create(6400,0),zbuff.create(6400,0),zbuff.create(6400,0),zbuff.create(6400,0)
    self.cc.on("record",function(is_dl,point)
        if self.active and self.on_frame then self.on_frame(is_dl,point==0 and z1 or point==1 and z2 or point==2 and z3 or z4) end
    end)
    self.cc.record(true,z1,z2,z3,z4)
    if sys and sys.timerStart then
        sys.timerStart(function() if self.active and self.generation==generation then self.input_ready=true end end,500)
    else self.input_ready=true end
    return true
end
function M:push_uplink(payload)
    if not self.active or type(payload)~="string" then return false,"inactive" end
    if not self.cc.input or not self.input_buffer then return false,"unsupported" end
    if not self.input_ready then return false,"audio_not_ready" end
    if #payload==0 or #payload>4096 then return false,"frame_too_large" end
    self.input_buffer.used=0
    self.input_buffer:write(payload)
    return self.cc.input(self.input_buffer)~=false
end
function M:stop() self.active=false; self.input_ready=false; self.input_buffer=nil; self.generation=self.generation+1; if self.cc and self.cc.record then pcall(self.cc.record,false) end end
return M
