-- Runtime hardware profile for Air8000 variants.
local M={}
local function read_model()
    local providers={_G.hmeta,_G.rtos}
    for _,provider in ipairs(providers) do
        if provider then
            for _,name in ipairs({"model","bsp"}) do
                if type(provider[name])=="function" then
                    local ok,value=pcall(provider[name])
                    if ok and type(value)=="string" and value~="" then return value end
                end
            end
        end
    end
    return "unknown"
end
local raw=read_model()
local model=string.lower(raw)
M.raw_model=raw
M.model=raw
M.is_air8000a=model:find("air8000a",1,true)~=nil and model:find("air8000w",1,true)==nil
M.is_air8000w=model:find("air8000w",1,true)~=nil
M.has_gnss=M.is_air8000a
M.a_only_features={gnss=M.has_gnss}
return M
