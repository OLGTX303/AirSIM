package.path = "./?.lua;./?/init.lua;" .. package.path
local n=0
local function ok(name, fn) local yes,err=pcall(fn); if not yes then error(name..": "..tostring(err)) end; n=n+1; print("PASS "..name) end

ok("call state, audio start and duplicate events", function()
  local C=require("cellular.call")
  local events={}
  local cc={dial=function() return true end,accept=function() return true end,hangUp=function() return true end,lastNum=function() return "+6012" end}
  local c=C.new(cc,function(e,p) events[#events+1]={e=e,p=p} end,function() return 1 end)
  assert(c:dial("c1","+6012"))
  c:on_cc("CONNECTED")
  assert(c.current.state=="CONNECTED")
  c:on_cc("AUDIO_START")
  assert(c.audio_started)
  local audio=0
  for _,v in ipairs(events) do if v.e=="call.audio_start" then audio=audio+1 end end
  assert(audio==1)
  c:on_cc("SPEECH_START")
  local audio2=0
  for _,v in ipairs(events) do if v.e=="call.audio_start" then audio2=audio2+1 end end
  assert(audio2==1)
  c:on_cc("DISCONNECTED")
  assert(c.current==nil)
  c:on_cc("DISCONNECTED")
end)

ok("SMS duplicate suppression", function()
  local S=require("cellular.sms"); local count=0
  local s=S.new({send=function() return true end},function(e) if e=="sms.received" then count=count+1 end end)
  assert(s:on_receive("+1","hi",10)); assert(not s:on_receive("+1","hi",10)); assert(count==1)
end)

ok("nonce replay", function()
  local N=require("security.nonce"); local c={}
  assert(N.new(c,"nonce-1234",100)); assert(not N.new(c,"nonce-1234",101))
end)

ok("media framing and jitter", function()
  local F=require("media.framing"); local J=require("media.jitter_buffer"); local j=J.new(2)
  local h=F.header("c",1,1,"rx",8000,20,2)
  assert(F.accept(h,"ab")); assert(j:push({header=h,payload="ab"})); assert(not j:push({header=h,payload="ab"})); assert(j:pop().payload=="ab")
end)

ok("direct PCM maps remote downlink buffers and clears them", function()
  local old_zbuff,old_audio=_G.zbuff,_G.audio_v2
  local created,record_cb,record_args,input_args,extern_args={},nil,nil,{},{}
  local function newbuff()
    local b={data="",clears=0}
    function b:used() return #self.data end
    function b:toStr(offset,len) return self.data:sub((offset or 0)+1,(offset or 0)+(len or #self.data)) end
    function b:del() self.data=""; self.clears=self.clears+1 end
    created[#created+1]=b
    return b
  end
  _G.zbuff={create=function() return newbuff() end}
  _G.audio_v2={DATA_CODEC_TYPE_RAW=77}
  local cc={
    quality=function() return 1 end,
    on=function(event,cb) if event=="record" then record_cb=cb end end,
    record=function(on,...) if on then record_args={...} end return true end,
    extern_source=function(...) extern_args[#extern_args+1]={...}; return true end,
    input=function(...) local a={...}; input_args[#input_args+1]=a; local data=a[2] or ""; return true,#data,4096 end,
  }
  local PCM=require("media.direct_pcm")
  local got
  local pcm=PCM.new(cc)
  assert(pcm:start("c1",function(is_dl,payload) if is_dl then got=payload end end))
  assert(record_args[1]==created[1] and record_args[2]==created[2])
  assert(record_args[3]==created[3] and record_args[4]==created[4])
  created[1].data="LOCAL"
  created[3].data="REMOTE"
  record_cb(true,0)
  assert(got=="REMOTE")
  assert(created[3].data=="" and created[3].clears==1)
  assert(created[1].data=="LOCAL")
  assert(pcm:start_uplink_source())
  local last=extern_args[#extern_args]
  assert(last[1]==true and last[2]==true and last[3]==77 and last[5]==8000 and last[6]==16 and last[7]==1 and last[8]==true)
  assert(pcm:stats().frame_bytes==320 and pcm:stats().uplink_sample_rate==8000)
  assert(pcm:push_uplink("abcd"))
  local input=input_args[#input_args]
  assert(input[1]==true and input[2]=="abcd" and input[3]==false)
  pcm:stop()
  _G.zbuff,_G.audio_v2=old_zbuff,old_audio
end)

ok("media phase state machine", function()
  local P=require("media.phase")
  local p=P.new()
  assert(p:transition(P.DIALING,"dial"))
  assert(p:transition(P.SIP_EARLY_MEDIA,"ready"))
  assert(p:transition(P.ENDING,"hangup"))
  assert(p:transition(P.IDLE,"ended"))
end)

ok("direct PCM capability requires raw external source", function()
  local C=require("system.capability")
  local cc={record=function()end,input=function()end}
  assert(not C.probe({cc=cc,audio_v2={DATA_CODEC_TYPE_RAW=1}}).direct_pcm)
  cc.extern_source=function()end
  assert(C.probe({cc=cc,audio_v2={DATA_CODEC_TYPE_RAW=1}}).direct_pcm)
  assert(not C.probe({cc=cc,audio_v2={}}).direct_pcm)
end)

ok("media manager selects stock voice modes", function()
  local M=require("media.media_manager")
  assert(M.select("compatible",{carrier_rtp_pcm=true,direct_pcm=true,sip_bridge=true},true)=="sip_bridge")
  assert(M.select("wideband",{carrier_rtp_pcm=true,direct_pcm=true,sip_bridge=true},true)=="direct_pcm")
  assert(M.select("auto",{carrier_rtp_pcm=true,direct_pcm=true,sip_bridge=true},true)=="sip_bridge")
  assert(M.select("direct_pcm",{carrier_rtp_pcm=true,direct_pcm=true})=="direct_pcm")
  assert(M.select("auto",{carrier_rtp_pcm=false,direct_pcm=true})=="direct_pcm")
end)

ok("carrier RTP backend selects native bridge without fake tone", function()
  local C=require("media.carrier_rtp")
  local calls={}
  local cc={
    AUDIO_MODE_BRIDGE_PCM=1,
    init=function(id,mode) calls.init={id,mode}; return true end,
    bridgePcmStats=function() return {selected=true,active=1,media_ready=1} end,
    bridgeAudioStop=function() calls.bridgeStop=true; return true end,
  }
  local voip={
    AUDIO_MODE_BRIDGE=1, PCMU=0,
    setAudioMode=function(mode) calls.mode=mode; return true end,
    pcmIn=function() return 0 end,
    pcmOut=function() return nil end,
    on=function(name,cb) calls["on_"..name]=cb end,
    start=function(opts) calls.start=opts; return true end,
    stop=function() calls.stop=true; return true end,
  }
  local carrier=C.new(cc,voip,{LWIP_STA=7})
  assert(carrier:init())
  assert(calls.mode==1 and calls.init[2]==1)
  assert(carrier:configure({host="192.168.1.10",port=41000,codec="PCMU"}))
  assert(carrier:start("c1"))
  assert(calls.start.remote_ip=="192.168.1.10" and calls.start.remote_port==41000)
  assert(calls.start.codec==0 and calls.start.sample_rate==8000 and calls.start.ptime==20)
  carrier:on_cc("PLAY",1,123)
  assert(carrier:stats().early_media==true)
  carrier:stop(true)
  assert(calls.stop and calls.bridgeStop)
end)

ok("SIP bridge uses official ringback and reports negotiated VoLTE rate", function()
  local fp=assert(io.open("main.lua","r"))
  local src=fp:read("*a")
  fp:close()
  assert(src:find('cc.bridgeTone',1,true))
  assert(src:find('sip_183_media_ready',1,true))
  assert(src:find('cc.quality',1,true))
  assert(src:find('target_cellular_sample_rate=8000',1,true))
  assert(src:find('wideband_volte',1,true))
end)

ok("SIP bridge starts VoIP before CC audio initialization", function()
  package.loaded["media.ccguard"]=nil
  local G=require("media.ccguard")
  local created,args={},nil
  local zb={create=function(size,fill) local b={size=size,fill=fill}; created[#created+1]=b; return b end}
  local cc={record=function(...) args={...}; return true end}
  local ok,err=G.enable(cc,zb)
  assert(ok==true and err==nil)
  assert(args[1]==true and args[2]==created[1] and args[3]==created[2] and args[4]==created[3] and args[5]==created[4])
  assert(created[1].size==6400 and created[3].size==6400)
  assert(G.buffers[1]==created[1])
  assert(G.enabled==true)
  local off
  assert(G.disable({record=function(on) off=on; return true end})==true)
  assert(off==false and G.enabled==false)
  assert(select(2,G.enable({},zb))=="cc_record_unavailable")
  assert(select(2,G.enable({record=function() return false end},zb))=="cc_record_failed")
  local fp=assert(io.open("main.lua","r")); local src=fp:read("*a"); fp:close()
  local init=assert(src:find('pcall(cc.init,0)',1,true))
  local start=assert(src:find('pcall(exsip.start)',init+1,true))
  assert(init<start)
  assert(src:find('cc_downlink_guard","disabled","native_sip_bridge',1,true))
  local a=assert(io.open("media/ccguard.lua","r")):read("*a")
  local b=assert(io.open("media.ccguard.lua","r")):read("*a")
  assert(a==b,"flat LuatTools copy must match")
  assert(src:find('msg.type == "command.audio_guard"',1,true))
  assert(src:find('ccguard.disable(cc)',1,true))
  assert(src:find('action=="stats"',1,true) and src:find('"media.voip_stats"',1,true))
end)

ok("bundle file names fit the LuatOS 24-byte limit", function()
  local pipe=io.popen and io.popen('find . -type f -not -path "./tests/*" -not -path "./tools/*" -not -name "*.md"')
  if not pipe then return end
  local count=0
  for path in pipe:lines() do
    local name=path:match("([^/]+)$")
    assert(#name<=24, "file name too long for luadb: "..name.." ("..#name.." bytes)")
    count=count+1
  end
  pipe:close()
  assert(count>0)
end)

ok("SIP media resume never mixes ringback into a connected call", function()
  local fp=assert(io.open("main.lua","r"))
  local src=fp:read("*a")
  fp:close()
  local ready=assert(src:find('event_type=="media" and action=="ready"',1,true))
  local stop=assert(src:find('elseif event_type==',ready+1,true))
  local block=src:sub(ready,stop)
  assert(block:find('~="CONNECTED"',1,true))
  assert(block:find('sip_media_ready_connected',1,true))
  assert(src:find('cellular_dial',1,true))
  assert(src:find('do not restart it when the SIP RTP session becomes ready',1,true))
  assert(src:find('sip_resume_connected',1,true))
  assert(src:find('never start ringback',1,true))
end)

ok("SIP bridge can refresh and resume after gateway restart", function()
  local fp=assert(io.open("main.lua","r"))
  local src=fp:read("*a")
  fp:close()
  assert(src:find("server_instance_id",1,true))
  assert(src:find("refresh_sip_registration",1,true))
  assert(src:find("x-airsim-resume",1,true))
  assert(src:find("resume_existing_cc",1,true))
  assert(src:find("status.active_call",1,true))
end)

ok("Wi-Fi telemetry reports actual IP-ready connection", function()
  local W=require("system.wifi_status")
  local wlan={
    ready=function() return true end,
    getIP=function() return "192.168.1.48" end,
    getSsid=function() return "LabWiFi" end,
    getInfo=function() return {bssid="001122AABBCC",rssi=-51,gw="192.168.1.1"} end,
    getMac=function() return "AABBCCDDEEFF" end,
  }
  local cache={}
  local snap=W.snapshot(wlan,{wifi={ssid="SavedWiFi"}},cache,"IP_READY",nil,100)
  assert(snap.connected==true and snap.state=="connected")
  assert(snap.ssid=="LabWiFi" and snap.ip=="192.168.1.48")
  assert(snap.gateway=="192.168.1.1" and snap.rssi==-51)
end)

ok("Air8000 exgnss open nil return is success", function()
  local G=require("gnss.gnss_service")
  local opened=false
  local api={
    TIMERORSUC=2,
    setup=function(opts) assert(opts.gnssmode==1); return nil end,
    open=function(mode,opts) opened=true; assert(mode==2 and opts.tag=="airsim"); return nil end,
    is_fix=function() return true end,
    rmc=function(mode) assert(mode==2); return {valid=true,lat=1.25,lng=103.75,speed=1,course=90} end,
    gga=function() return {altitude=12.5,satellites_tracked=8,hdop=0.9,fix_quality=1} end,
    gsv=function() return {total_sats=14} end,
    gsa=function() return {pdop=1.2,vdop=1.0,hdop=0.8,fix_type=3} end,
  }
  local g=G.new(api,"on_request")
  local ok,err=g:start()
  assert(ok==true and err==nil and opened==true and g.state=="searching")
  local sample=g:sample(123)
  assert(sample.fix==true and sample.fix_state=="fixed")
  assert(sample.latitude==1.25 and sample.longitude==103.75)
  assert(sample.altitude_m==12.5 and sample.satellites==8 and sample.satellites_visible==14)
  assert(math.abs(sample.speed_mps-0.514444)<0.00001)
end)

ok("IMEI is retried until the modem reports a real value", function()
  package.loaded["cellular.identity"]=nil
  local I=require("cellular.identity")
  assert(I.imei({imei=function() return "" end})==nil)
  assert(I.imei({imei=function() return nil end})==nil)
  assert(I.imei({imei=function() error("modem not ready") end})==nil)
  assert(I.imei({imei=function() return "unknown" end})==nil)
  assert(I.imei({imei=function() return " 866123456789012 \r\n" end})=="866123456789012")
  local id=I.read({imei=function() return "866123456789012" end},nil,{serial_number="SN1"})
  assert(id.imei=="866123456789012" and id.serial_number=="SN1")
  package.loaded["protocol.device"]=nil
  local device=require("protocol.device")
  local st=device.status({},id)
  assert(st.imei=="866123456789012","status must carry imei for device.register")
  local w=device.status({},id,{model="Air8000W_A17"})
  assert(w.device_type=="air8000w" and w.hardware_model=="Air8000W","W registration identity must not be hard-coded as A")
  local profile_src=assert(io.open("system.mod.lua","r")):read("*a")
  assert(profile_src:find("M.has_es8311=false",1,true),"Air8000 bridge profile must not require ES8311")
  local fp=assert(io.open("main.lua","r")); local src=fp:read("*a"); fp:close()
  assert(src:find('identity.imei(mobile)',1,true) and src:find('"device.identity"',1,true))
  for _,pair in ipairs({{"cellular/identity.lua","cellular.identity.lua"},{"protocol/device.lua","protocol.device.lua"},{"gnss/gnss_service.lua","gnss.gnss_service.lua"}}) do
    local a=assert(io.open(pair[1],"r")):read("*a"); local b=assert(io.open(pair[2],"r")):read("*a")
    assert(a==b,"flat LuatTools copy must match "..pair[1])
  end
end)

ok("GNSS uses bundled exgnss without AGPS unless lbsLoc2 is present", function()
  package.loaded["gnss.gnss_service"]=nil
  local G=require("gnss.gnss_service")
  local setup_opts,open_opts
  local api={TIMERORSUC=2,setup=function(o) setup_opts=o end,open=function(_,o) open_opts=o end}
  local g=G.new(api,"on_request")
  assert(g:start()==true)
  assert(setup_opts.agps_enable==false,"lbsLoc2 is not bundled")
  assert(open_opts.val==120 and G.OPEN_SECONDS==120)
  local fp=assert(io.open("exgnss.lua","r")); local src=fp:read("*a"); fp:close()
  assert(src:find("function exgnss.setup",1,true) and src:find("function exgnss.open",1,true))
  assert(src:find("libgnss.bind",1,true),"exgnss powers and binds the Air8000 GNSS UART")
end)

ok("location normalization", function()
  local L=require("gnss.location"); local x=L.normalize({lat=1,lng=2,alt=3},99)
  assert(x.fix and x.latitude==1 and x.altitude_m==3); assert(not L.normalize({},99).fix)
end)

ok("fota blocks active calls", function()
  local F=require("system.fota"); assert(F.can_update(false,false)); assert(not F.can_update(true,false)); assert(not F.can_update(false,true))
end)

print("Air8000 Lua tests: "..n.." passed")
