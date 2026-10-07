-- LuatTools requires a concrete config.lua entry during merge.
-- Replace the placeholders below before using the device with a Relay.
return {
    device_id = "air8000-lan-e3ae10e4",
    serial_number = nil,
    device_secret = "REPLACE_WITH_PER_DEVICE_SECRET",
    enrollment_token = "REPLACE_WITH_LAN_ENROLLMENT_TOKEN",
    ble_enabled = true,
    ble_pairing_code = "REPLACE_WITH_6_DIGIT_PAIRING_CODE",
    relay_url = "ws://192.168.1.91:8081/device",
    voice_mode = "compatible", -- compatible (SIP/PCMU/8 kHz) | wideband (direct PCM)
    media_backend = "sip_bridge", -- legacy alias; voice_mode is authoritative
    voice_sample_rate = 8000, -- keep the stock direct PCM path narrowband for now
    carrier_rtp = { enabled = false }, -- legacy optional path, never selected by default
    location_policy = "on_request",
    location_period_ms = 60000,
    wifi = { ssid = "REPLACE_WIFI_SSID", password = "REPLACE_WIFI_PASSWORD" },
    limits = { max_message_bytes = 65536, max_sms_body = 4096, nonce_ttl_ms = 300000 },
    sip = { enabled = true, sip_server_addr = "192.168.1.91", sip_server_port = 5060,
        sip_domain = "airsim.local", sip_username = "air8000-lan-e3ae10e4",
        sip_password = "REPLACE", sip_transport = "udp", rtp_port = 40000,
        codecs = { "PCMU" }, ptime = 20, cc_sip_bridge = true,
        early_media = true, early_media_response = 183, auto_answer = false }
}
