local capability=require("system.capability")
local caps=capability.probe({cc=cc,sms=sms,gnss=libgnss or exgnss,wlan=wlan,websocket=websocket,crypto=crypto,fskv=fskv,fota=fota,sip=exsipclient})
local function line(name, value) print(string.format("%-16s %s",name, value and "PASS" or "UNSUPPORTED")) end
print("[AIRSIM SELFTEST]"); line("Firmware", true); line("SIM", mobile~=nil); line("LTE", mobile~=nil); line("Voice CC",caps.voice); line("SMS",caps.sms); line("GNSS",caps.gnss); line("Wi-Fi",caps.wifi); line("TLS/WSS",caps.websocket); line("Direct PCM",caps.direct_pcm); line("SIP Bridge",caps.sip_bridge); line("FOTA",caps.fota); print("Overall ......... "..(caps.required_ok and "READY" or "NOT READY"))
