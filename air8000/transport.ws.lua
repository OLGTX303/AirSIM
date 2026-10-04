local M = {}
function M.new(api,on_message,on_connected,on_disconnected)
    return setmetatable({api=api,on_message=on_message,on_connected=on_connected,on_disconnected=on_disconnected,client=nil,connected=false},{__index=M})
end
function M:connect(url)
    if not self.api or not self.api.create then return false,"websocket_unavailable" end
    self.client=self.api.create(nil,url)
    if not self.client then return false,"websocket_create_failed" end
    if type(self.client.on)~="function" or type(self.client.connect)~="function" then return false,"websocket_api_incompatible" end
    local callback=function(_,event,data,fin,opcode)
        if event=="conack" then
            self.connected=true
            if self.on_connected then self.on_connected() end
        elseif event=="recv" then
            if self.on_message then self.on_message(data,fin,opcode) end
        elseif event=="disconnect" or event=="error" then
            self.connected=false
            if self.on_disconnected then self.on_disconnected(data or event) end
        end
    end
    local hooked=pcall(function() self.client:on(callback) end)
    if not hooked then return false,"websocket_callback_failed" end
    local connected,ok=pcall(function() return self.client:connect() end)
    if not connected or ok==false then return false,"websocket_connect_failed" end
    return true
end
function M:send(value)
    return self.connected and self.client and type(self.client.send)=="function" and self.client:send(value)==true
end
-- LuatOS V2052 websocket binding: the first numeric argument after data is a
-- binary selector. Passing 1 sets WebSocket opcode 0x02; passing protocol
-- opcode 2 here would be interpreted as text by the Lua binding.
function M:send_binary(value)
    return self.connected and self.client and type(self.client.send)=="function" and self.client:send(value,1)==true
end
function M:close()
    local client=self.client
    self.client=nil
    self.connected=false
    if client then
        if client.close then pcall(client.close,client)
        elseif client.disconnect then pcall(client.disconnect,client) end
    end
end
return M
