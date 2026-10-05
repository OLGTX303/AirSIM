return {
    device_id = "air8000-device-REPLACE",
    -- Optional printed/vendor SN. If omitted, the MCU unique ID becomes the SN.
    serial_number = nil,
    device_secret = "REPLACE_WITH_PER_DEVICE_SECRET",
    enrollment_token = "REPLACE_WITH_LAN_ENROLLMENT_TOKEN",
    ble_pairing_code = "REPLACE_WITH_6_DIGIT_PAIRING_CODE",
    relay_url = "wss://relay.example.invalid/v1/devices/air8000",
    media_backend = "auto", -- auto | carrier_rtp | direct_pcm | sip_bridge
    carrier_rtp = { enabled = true }, -- real carrier early media; endpoint is assigned by the gateway\n    location_policy = "on_request", -- off | on_request | periodic
    location_period_ms = 60000,
    wifi = { ssid = "REPLACE_WIFI_SSID", password = "REPLACE_WIFI_PASSWORD" },
    limits = { max_message_bytes = 65536, max_sms_body = 4096, nonce_ttl_ms = 300000 },
    -- Enable only after the VPS has a SIP/UDP endpoint for this device.
    sip = {
        enabled = false,
        sip_server_addr = "192.168.1.91",
        sip_server_port = 5060,
        sip_domain = "airsim.local",
        sip_username = "REPLACE_WITH_DEVICE_ID",
        sip_password = "REPLACE_WITH_SIP_PASSWORD",
        sip_transport = "udp",
        rtp_port = 40000,
        codecs = { "PCMU" },
        ptime = 20,
        cc_sip_bridge = true,
        early_media = true,
        early_media_response = 183,
        auto_answer = false,
    }
}
