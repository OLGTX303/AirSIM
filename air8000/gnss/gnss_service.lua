local location=require("gnss.location")
local M={}

local function call(api,name,...)
    if not api or type(api[name])~="function" then return nil,false end
    local ok,value=pcall(api[name],...)
    if ok then return value,true end
    return nil,false
end

local function copy_table(src)
    local out={}
    if type(src)=="table" then for k,v in pairs(src) do out[k]=v end end
    return out
end

-- A cold fix without AGPS commonly needs 30-60 s outdoors and more indoors.
M.OPEN_SECONDS=120

function M.new(api,policy)
    return setmetatable({
        api=api,
        policy=policy or "on_request",
        state="disabled",
        last=nil,
        configured=false,
        opened=false,
        last_event=nil,
    },{__index=M})
end

function M:setup()
    if self.configured then return true end
    if self.api and type(self.api.setup)=="function" then
        -- exgnss AGPS needs lbsLoc2 for a cell-based seed position. The
        -- AirSIM bundle does not ship it, so only enable AGPS when present;
        -- otherwise the AGPS task errors before the receiver gets data.
        local agps=type(package)=="table" and type(package.searchpath)=="function" and
            package.searchpath("lbsLoc2",package.path or "")~=nil
        local ok=pcall(self.api.setup,{
            gnssmode=1,
            agps_enable=agps==true,
            debug=false,
            hz=1,
        })
        if not ok then return false,"gnss_setup_failed" end
    end
    self.configured=true
    return true
end

function M:start()
    if not self.api then self.state="unavailable"; return false,"gnss_unavailable" end
    local setup_ok,setup_err=self:setup()
    if not setup_ok then self.state="unavailable"; return false,setup_err end

    -- Air8000 exgnss.open() intentionally returns nil. Success is determined
    -- by whether the call itself completed without throwing.
    if type(self.api.open)=="function" then
        local mode=self.api.TIMERORSUC or self.api.DEFAULT
        local ok,err=pcall(self.api.open,mode,{tag="airsim",val=M.OPEN_SECONDS})
        if not ok then
            self.state="unavailable"
            return false,"gnss_open_failed:"..tostring(err)
        end
        self.opened=true
        self.state="searching"
        return true
    end

    if type(self.api.start)=="function" then
        local ok,result=pcall(self.api.start)
        if not ok or result==false then self.state="unavailable"; return false,"gnss_start_failed" end
        self.opened=true
        self.state="searching"
        return true
    end

    self.state="unavailable"
    return false,"gnss_api_unsupported"
end

function M:is_fixed()
    local value,ok=call(self.api,"is_fix")
    if ok then return value==true end
    value,ok=call(self.api,"isFix")
    if ok then return value==true end
    return nil
end

function M:read_raw()
    if not self.api then return nil end

    local fixed=self:is_fixed()
    local raw

    raw=select(1,call(self.api,"rmc",2))
    if type(raw)~="table" then raw=select(1,call(self.api,"getRmc",2)) end
    if type(raw)~="table" then raw=select(1,call(self.api,"read")) end
    if type(raw)~="table" then raw=select(1,call(self.api,"last_loc")) end
    raw=copy_table(raw)

    if fixed==false then raw.valid=false end
    if next(raw)==nil and fixed~=true then return {valid=false} end

    local gga=select(1,call(self.api,"gga",2))
    if type(gga)~="table" then gga=select(1,call(self.api,"getGga",2)) end
    if type(gga)=="table" then
        raw.alt=raw.alt or gga.altitude
        raw.satellites=raw.satellites or gga.satellites_tracked
        raw.hdop=raw.hdop or gga.hdop
        raw.fix_quality=gga.fix_quality
    end

    local gsv=select(1,call(self.api,"gsv"))
    if type(gsv)~="table" then gsv=select(1,call(self.api,"getGsv")) end
    if type(gsv)=="table" then raw.satellites_visible=gsv.total_sats end

    local gsa=select(1,call(self.api,"gsa"))
    if type(gsa)~="table" then gsa=select(1,call(self.api,"getGsa")) end
    if type(gsa)=="table" then
        raw.hdop=raw.hdop or gsa.hdop
        raw.vdop=gsa.vdop
        raw.pdop=gsa.pdop
        raw.fix_type=gsa.fix_type
    end

    return raw
end

function M:sample(now)
    local raw=self:read_raw()
    self.last=location.normalize(raw,now)
    if self.state=="searching" and not self.last.fix then
        self.last.fix_state="searching"
    end
    if self.last.fix then self.state="fixed"
    elseif self.state~="unavailable" and self.state~="disabled" and self.state~="closed" then self.state=self.last.fix_state end
    return self.last
end

function M:on_state(event,now)
    self.last_event=event
    if event=="FIXED" then
        self.state="fixed"
        return self:sample(now)
    elseif event=="LOSE" then
        self.state="lost"
        local sample=self:sample(now)
        sample.fix=false
        sample.fix_state="lost"
        self.last=sample
        return sample
    elseif event=="CLOSE" then
        self.opened=false
        self.state="closed"
        if self.last then
            local copy=copy_table(self.last)
            copy.receiver_state="closed"
            copy.timestamp=now or copy.timestamp
            self.last=copy
            return copy
        end
        return {fix=false,fix_state="closed",receiver_state="closed",timestamp=now or 0}
    end
    return self:sample(now)
end

return M
