local M={}

local function safe_call(fn,...)
    if type(fn)~="function" then return false end
    local ok,result=pcall(fn,...)
    return ok and result~=false
end

local function pin_value(active_high,on)
    if active_high then return on and 1 or 0 end
    return on and 0 or 1
end

function M.new(cfg)
    cfg=type(cfg)=="table" and cfg or {}
    local active_high=cfg.active_high~=false
    local pins={
        wifi=tonumber(cfg.wifi_gpio or 146),
        cellular=tonumber(cfg.cellular_gpio or 20),
    }
    local setters={}
    local state={wifi=false,cellular=false}

    local function setup(name,pin)
        if not pin or not gpio or type(gpio.setup)~="function" then
            if log then log.warn("airsim.led","unavailable",name,"gpio",tostring(pin)) end
            return
        end
        local ok=pcall(gpio.setup,pin,pin_value(active_high,false))
        setters[name]=function(value)
            return pcall(gpio.setup,pin,value)
        end
        if log then log.info("airsim.led","init",name,"gpio",pin,"ok",ok) end
    end

    setup("wifi",pins.wifi)
    setup("cellular",pins.cellular)

    local function set(name,on)
        on=on==true
        if state[name]==on then return end
        state[name]=on
        local setter=setters[name]
        if setter then pcall(setter,pin_value(active_high,on)) end
        if log then log.info("airsim.led",name,on and "on" or "off") end
    end

    local api={}
    function api:set_wifi(connected) set("wifi",connected) end
    function api:set_cellular(registered) set("cellular",registered) end
    function api:update_cellular(mobile)
        local registered=false
        if mobile then
            local ok,value=pcall(function()
                if type(mobile.status)=="function" then return mobile.status() end
                if type(mobile.getState)=="function" then return mobile.getState() end
            end)
            if ok then
                local text=tostring(value or "")
                registered=text=="REGISTERED" or text=="REGISTERED_ROAMING" or
                    value==mobile.REGISTERED or value==mobile.REGISTERED_ROAMING or
                    text==tostring(mobile.REGISTERED) or text==tostring(mobile.REGISTERED_ROAMING)
            end
        end
        set("cellular",registered)
        return registered
    end
    function api:state() return {wifi=state.wifi,cellular=state.cellular} end
    return api
end

return M
