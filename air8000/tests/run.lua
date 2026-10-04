package.path = "./?.lua;./?/init.lua;" .. package.path
local n=0
local function ok(name, fn) local yes,err=pcall(fn); if not yes then error(name..": "..tostring(err)) end; n=n+1; print("PASS "..name) end
ok("call state and duplicate events", function()
  local C=require("cellular.call"); local events={}; local cc={dial=function() return true end,accept=function() return true end,hangUp=function() return true end,lastNum=function() return "+6012" end}; local c=C.new(cc,function(e,p) events[#events+1]=e end,function() return 1 end)
  assert(c:dial("c1","+6012")); c:on_cc("SPEECH_START"); assert(c.current.state=="CONNECTED"); c:on_cc("DISCONNECTED"); assert(c.current==nil); c:on_cc("DISCONNECTED"); assert(#events==2)
end)
ok("SMS duplicate suppression", function()
  local S=require("cellular.sms"); local count=0; local s=S.new({send=function() return true end},function(e) if e=="sms.received" then count=count+1 end end); assert(s:on_receive("+1","hi",10)); assert(not s:on_receive("+1","hi",10)); assert(count==1)
end)
ok("nonce replay", function() local N=require("security.nonce"); local c={}; assert(N.new(c,"nonce-1234",100)); assert(not N.new(c,"nonce-1234",101)) end)
ok("media framing and jitter", function()
  local F=require("media.framing"); local J=require("media.jitter_buffer"); local j=J.new(2); local h=F.header("c",1,1,"rx",8000,20,2); assert(F.accept(h,"ab")); assert(j:push({header=h,payload="ab"})); assert(not j:push({header=h,payload="ab"})); assert(j:pop().payload=="ab")
end)
ok("location normalization", function() local L=require("gnss.location"); local x=L.normalize({lat=1,lng=2,alt=3},99); assert(x.fix and x.latitude==1 and x.altitude_m==3); assert(not L.normalize({},99).fix) end)
ok("fota blocks active calls", function() local F=require("system.fota"); assert(F.can_update(false,false)); assert(not F.can_update(true,false)); assert(not F.can_update(false,true)) end)
print("Air8000 Lua tests: "..n.." passed")
