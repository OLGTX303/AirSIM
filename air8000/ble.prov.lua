-- AirSIM BLE Wi-Fi provisioning for Air8000.
-- The service/characteristic UUIDs are intentionally fixed so the mobile app
-- can reject unrelated Bluetooth devices before showing a configuration UI.
local wifi_status=require("system.wifi_status")
local M = {}

M.SERVICE_UUID = "7B9E8000A8F04C4E9A5B4B80C8000001"
M.STATUS_UUID = "7B9E8000A8F04C4E9A5B4B80C8000002"       -- read/notify: identity and Wi-Fi state JSON
M.CONFIG_UUID = "7B9E8000A8F04C4E9A5B4B80C8000003"       -- write: {pairing_code,ssid,password}
M.IDENTITY_UUID = "7B9E8000A8F04C4E9A5B4B80C8000004"     -- read: serial number and IMEI JSON
M.NETWORKS_UUID = "7B9E8000A8F04C4E9A5B4B80C8000005"    -- notify: scanned SSID records

local function hex(value)
    if type(value) == "string" then
        if #value == 32 and value:match("^[%da-fA-F]+$") then return value:upper() end
        return (value:gsub(".", function(char) return string.format("%02X", string.byte(char)) end)):upper()
    end
    if value and value.toHex then return value:toHex():upper() end
    return ""
end

local function safe_status(cfg, identity)
    return json.encode({
        protocol = "airsim.ble.provisioning.v1",
        wifi = { configured = cfg.wifi and cfg.wifi.ssid ~= nil, state = "pending" },
        ble = { state = "ready" }
    })
end

function M.start(cfg, identity, wlan_api, kv_api)
    if not bluetooth or not bluetooth.init or not ble or not sys then return false, "ble_unavailable" end
    if not wlan_api or not wlan_api.connect then return false, "wifi_unavailable" end
    local bt = bluetooth.init()
    if not bt then return false, "bluetooth_init_failed" end
    -- main.lua initializes WLAN before starting BLE.  Re-running wlan.init()
    -- here can reset the STA state on Air8000 and break provisioning just
    -- after the GATT connection succeeds.
    local wifi_initialized = true

    local status_payload = safe_status(cfg, identity)
    local wifi_cache={ssid=cfg.wifi and cfg.wifi.ssid or nil}
    local ble_device
    local gatt
    local adv
    local connected = false
    local ble_state = "ready"
    local pairing_code = tostring(cfg.ble_pairing_code or "")

    local function persist_wifi(ssid, password, bssid, security, enrollment_token)
        cfg.wifi = { ssid = ssid, password = password, bssid = bssid, security = security or "auto" }
        if type(enrollment_token) == "string" and #enrollment_token >= 16 and #enrollment_token <= 256 then cfg.enrollment_token = enrollment_token end
        if kv_api and kv_api.set then kv_api:set("config", cfg) end
    end

    local publish_status

    local function connect_wifi(ssid, password, bssid)
        local binary_bssid = nil
        if type(bssid) == "string" and bssid:match("^[%da-fA-F]+$") and #bssid == 12 then binary_bssid = string.fromHex(bssid) end
        -- LuatOS documents wlan.connect(ssid, password, auto_reconnect, bssid).
        local ok, result
        if binary_bssid then ok, result = pcall(wlan_api.connect, ssid, password, 1, binary_bssid)
        else ok, result = pcall(wlan_api.connect, ssid, password, 1) end
        if log then log.info("airsim.ble", "wifi_connect", ok, result) end
        if not ok then
            publish_status("connect_error", "wifi_connect_failed")
            return false
        end
        return result ~= false
    end

    publish_status=function(state,error_message,event,data)
        local snap=wifi_status.snapshot(wlan_api,cfg,wifi_cache,event,data,os.time()*1000)
        if state then snap.state=state end
        snap.error=error_message
        status_payload=json.encode({
            protocol="airsim.ble.provisioning.v1",
            wifi=snap,
            ble={state=ble_state}
        })
        if connected and ble_device then
            ble_device:write_notify({uuid_service=string.fromHex(M.SERVICE_UUID),uuid_characteristic=string.fromHex(M.STATUS_UUID)},status_payload)
        end
    end

    local function security_name(item)
        return item.security or item.authmode or item.auth_mode or item.akm or "auto"
    end

    local function publish_scan_results()
        local results = wlan_api.scanResult and wlan_api.scanResult() or {}
        local visible = {}
        for _, item in pairs(results) do
            if type(item) == "table" and type(item.ssid) == "string" and #item.ssid > 0 then
                table.insert(visible, {
                    ssid=item.ssid, rssi=item.rssi, bssid=item.bssid and item.bssid.toHex and item.bssid:toHex() or nil,
                    security=security_name(item)
                })
            end
        end
        if log then log.info("airsim.ble", "wifi_scan_results", #visible) end
        if #visible == 0 then
            publish_status("scan_empty")
            return
        end
        for index, item in ipairs(visible) do
            local packet = json.encode({type="wifi_network", index=index, total=#visible, network=item})
            if connected and ble_device then
                ble_device:write_notify({uuid_service=string.fromHex(M.SERVICE_UUID), uuid_characteristic=string.fromHex(M.NETWORKS_UUID)}, packet)
            end
        end
        publish_status("scan_complete")
    end

    local function on_write(param)
        local service_uuid = hex(param.uuid_service)
        local characteristic_uuid = hex(param.uuid_characteristic)
        local raw = ""
        if type(param.data) == "string" then raw = param.data elseif param.data and param.data.toStr then raw = param.data:toStr() end
        if log then log.info("airsim.ble", "write_target", service_uuid, characteristic_uuid, #raw) end
        if service_uuid ~= M.SERVICE_UUID or characteristic_uuid ~= M.CONFIG_UUID then return end
        local request = json.decode(raw)
        if type(request) ~= "table" or request.pairing_code ~= pairing_code then
            if log then log.info("airsim.ble", "write_rejected", type(request) == "table" and request.op or "invalid", type(request) == "table" and request.pairing_code == pairing_code or false) end
            publish_status("rejected", "invalid_pairing_or_wifi")
            return
        end
        if request.op == "scan" then
            if not wifi_initialized then
                publish_status("scan_error", "wifi_not_initialized")
                return
            end
            sys.timerStart(function()
                publish_status("scanning")
                local scan_ok = wlan_api.scan()
                if log then log.info("airsim.ble", "wifi_scan_started", scan_ok) end
            end, 100)
            return
        end
        if type(request.ssid) ~= "string" or #request.ssid == 0 or #request.ssid > 64 or type(request.password) ~= "string" or #request.password > 128 then
            publish_status("rejected", "invalid_wifi")
            return
        end
        persist_wifi(request.ssid, request.password, request.bssid, request.security, request.enrollment_token)
        publish_status("connecting")
        sys.timerStart(connect_wifi, 100, request.ssid, request.password, request.bssid)
    end

    local function callback(device, event, param)
        if event == ble.EVENT_CONN then
            connected = true
            ble_state = "connected"
            if log then log.info("airsim.ble", "connected") end
            publish_status(nil,nil,"BLE_CONNECTED")
            device:write_value({uuid_service=string.fromHex(M.SERVICE_UUID), uuid_characteristic=string.fromHex(M.IDENTITY_UUID)}, json.encode({serial_number=identity.serial_number, imei=identity.imei, device_id=cfg.device_id}))
        elseif event == ble.EVENT_DISCONN then
            connected = false
            ble_state = "disconnected"
            if log then log.info("airsim.ble", "disconnected") end
        elseif event == ble.EVENT_WRITE then
            if log then log.info("airsim.ble", "write", "provisioning_request") end
            on_write(param)
        end
    end

    ble_device = bt:ble(callback)
    if not ble_device then return false, "ble_profile_unavailable" end
    gatt = ble_device:gatt_create({
        string.fromHex(M.SERVICE_UUID),
        {string.fromHex(M.STATUS_UUID), ble.NOTIFY | ble.READ},
        {string.fromHex(M.CONFIG_UUID), ble.WRITE | ble.WRITE_CMD},
        {string.fromHex(M.IDENTITY_UUID), ble.READ}
        ,{string.fromHex(M.NETWORKS_UUID), ble.NOTIFY | ble.READ}
    })
    if not gatt then return false, "gatt_create_failed" end
    local suffix = tostring(identity.serial_number or identity.imei or cfg.device_id or "device")
    suffix = suffix:sub(-6)
    -- Keep the legacy advertising packet comfortably below 31 bytes. Windows
    -- Web Bluetooth can discover this short name with acceptAllDevices and
    -- verify the full service UUID after connecting. Including both a
    -- 128-bit UUID and the name can overflow the legacy packet and make the
    -- device invisible in the Windows picker.
    local local_name = "A8-" .. suffix
    adv = ble_device:adv_create({
        addr_mode=ble.PUBLIC, channel_map=ble.CHNLS_ALL, intv_min=120, intv_max=120,
        adv_data={{ble.FLAGS, string.char(0x06)}, {ble.COMPLETE_LOCAL_NAME, local_name}}
    })
    if not adv then return false, "advertise_create_failed" end
    if log then log.info("airsim.ble", "gatt_ready", M.SERVICE_UUID, local_name) end
    sys.timerStart(function()
        local started = ble_device:adv_start()
        if log then log.info("airsim.ble", "advertising_result", local_name, started) end
        if not started then
            sys.timerStart(function()
                local retry = ble_device:adv_start()
                if log then log.info("airsim.ble", "advertising_retry", local_name, retry) end
            end, 1000)
        end
    end, 1000)
    sys.subscribe("WLAN_STA_INC",function(event,data)
        publish_status(nil,nil,event,data)
    end)
    sys.subscribe("IP_READY",function()
        if wlan_api.ready and wlan_api.ready() then publish_status(nil,nil,"IP_READY") end
    end)
    sys.subscribe("IP_LOSE",function()
        if not (wlan_api.ready and wlan_api.ready()) then publish_status(nil,nil,"IP_LOSE") end
    end)
    sys.subscribe("WLAN_SCAN_DONE",publish_scan_results)
    publish_status(nil,nil,"BLE_READY")
    return true
end

return M
