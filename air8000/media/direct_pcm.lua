local M = {}

local RECORD_BUFFER_BYTES = 640
local MAX_PENDING_MS = 400

local function quality_rate(cc)
    if not cc or type(cc.quality) ~= "function" then return 8000 end
    local ok, quality = pcall(cc.quality)
    if not ok then return 8000 end
    if quality == 2 then return 16000 end
    if type(quality) == "table" then
        if quality.amr_wb == 1 or tonumber(quality.sample_rate) == 16000 then return 16000 end
    end
    return 8000
end

local function clear_buffer(buff)
    if buff and type(buff.del) == "function" then pcall(buff.del, buff) end
end

local function select_record_buffer(self, is_dl, point)
    if is_dl then return point == 0 and self.down1 or self.down2 end
    return point == 0 and self.up1 or self.up2
end

function M.new(cc, framing, health)
    return setmetatable({
        cc=cc, framing=framing, health=health, active=false, input_ready=false,
        external_started=false, generation=0, pending_uplink="",
        downlink_frames=0, downlink_bytes=0, uplink_frames=0, uplink_bytes=0,
        uplink_dropped_bytes=0,
    }, {__index=M})
end

function M:start(call_id, on_frame)
    if self.active then return true end
    if not self.cc or type(self.cc.record)~="function" or type(self.cc.input)~="function" or
       type(self.cc.extern_source)~="function" then return false,"unsupported" end
    if not zbuff or type(zbuff.create)~="function" then return false,"zbuff_unavailable" end

    self.call_id=call_id
    self.on_frame=on_frame
    self.active=true
    self.input_ready=false
    self.external_started=false
    self.pending_uplink=""
    self.downlink_frames=0
    self.downlink_bytes=0
    self.uplink_frames=0
    self.uplink_bytes=0
    self.uplink_dropped_bytes=0
    self.generation=self.generation+1
    local generation=self.generation
    self.sample_rate=quality_rate(self.cc)

    self.up1=zbuff.create(RECORD_BUFFER_BYTES,0)
    self.up2=zbuff.create(RECORD_BUFFER_BYTES,0)
    self.down1=zbuff.create(RECORD_BUFFER_BYTES,0)
    self.down2=zbuff.create(RECORD_BUFFER_BYTES,0)

    self.cc.on("record",function(is_dl,point)
        if not self.active or self.generation~=generation then return end
        local buff=select_record_buffer(self,is_dl==true,tonumber(point) or 0)
        if not buff then return end
        local used=type(buff.used)=="function" and buff:used() or 0
        local payload
        if used and used>0 and type(buff.toStr)=="function" then payload=buff:toStr(0,used) end
        clear_buffer(buff)
        if type(payload)=="string" and #payload>0 then
            if is_dl then
                self.downlink_frames=self.downlink_frames+1
                self.downlink_bytes=self.downlink_bytes+#payload
            end
            if self.on_frame then self.on_frame(is_dl==true,payload) end
        end
    end)

    local ok,result=pcall(self.cc.record,true,self.up1,self.up2,self.down1,self.down2)
    if not ok or result==false then
        self.active=false
        self.up1,self.up2,self.down1,self.down2=nil,nil,nil,nil
        return false,"cc_record_failed"
    end
    return true
end

function M:start_uplink_source()
    if not self.active then return false,"inactive" end
    if self.external_started then return true end
    local av=rawget(_G,"audio_v2")
    if not av or av.DATA_CODEC_TYPE_RAW==nil then return false,"audio_v2_raw_unavailable" end

    self.sample_rate=quality_rate(self.cc)
    self.uplink_sample_rate=16000
    pcall(self.cc.extern_source,nil)
    local ok,result=pcall(self.cc.extern_source,true,true,av.DATA_CODEC_TYPE_RAW,true,self.uplink_sample_rate,16,1,true)
    if not ok or result==false then return false,"extern_source_failed" end

    self.external_started=true
    self.input_ready=true
    if log then log.info("airsim.media","external_pcm_ready",self.sample_rate,self.uplink_sample_rate) end
    return true
end

function M:push_uplink(payload)
    if not self.active or type(payload)~="string" then return false,"inactive" end
    if not self.input_ready or not self.external_started then return false,"audio_not_ready" end
    if #payload==0 then return true end

    local data=self.pending_uplink..payload
    self.pending_uplink=""
    local max_pending=math.max(640,math.floor(self.sample_rate*2*MAX_PENDING_MS/1000))
    if #data>max_pending then
        local drop=#data-max_pending
        if drop%2~=0 then drop=drop+1 end
        self.uplink_dropped_bytes=self.uplink_dropped_bytes+math.min(drop,#data)
        data=data:sub(math.min(drop+1,#data+1))
    end

    local loops=0
    while #data>0 and loops<8 do
        loops=loops+1
        local ok,result,write_len,free_len=pcall(self.cc.input,true,data,false)
        if not ok or result==false then
            self.pending_uplink=data
            return false,"cc_input_failed"
        end
        write_len=tonumber(write_len)
        if write_len==nil then write_len=#data end
        if write_len<=0 then
            self.pending_uplink=data
            return true,"buffered"
        end
        if write_len>#data then write_len=#data end
        self.uplink_frames=self.uplink_frames+1
        self.uplink_bytes=self.uplink_bytes+write_len
        data=data:sub(write_len+1)
        if tonumber(free_len)==0 and #data>0 then
            self.pending_uplink=data
            return true,"buffered"
        end
    end
    if #data>0 then self.pending_uplink=data end
    return true,#self.pending_uplink>0 and "buffered" or nil
end

function M:stats()
    return {
        sample_rate=self.sample_rate or 8000,
        uplink_sample_rate=self.uplink_sample_rate or 16000,
        downlink_frames=self.downlink_frames,
        downlink_bytes=self.downlink_bytes,
        uplink_frames=self.uplink_frames,
        uplink_bytes=self.uplink_bytes,
        uplink_dropped_bytes=self.uplink_dropped_bytes,
        uplink_pending_bytes=#self.pending_uplink,
        external_started=self.external_started,
    }
end

function M:stop()
    local was_active=self.active
    self.active=false
    self.input_ready=false
    self.generation=self.generation+1
    if self.external_started and self.cc then
        if type(self.cc.input)=="function" then pcall(self.cc.input,true,"",true) end
        if type(self.cc.extern_source)=="function" then pcall(self.cc.extern_source,nil) end
    end
    self.external_started=false
    self.pending_uplink=""
    if was_active and self.cc and type(self.cc.record)=="function" then pcall(self.cc.record,false) end
    self.up1,self.up2,self.down1,self.down2=nil,nil,nil,nil
end

return M
