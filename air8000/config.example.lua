return {
    device_id = "air8000-device-REPLACE",
    -- Optional printed/vendor SN. If omitted, the MCU unique ID becomes the SN.
    serial_number = nil,
    device_secret = "REPLACE_WITH_PER_DEVICE_SECRET",
    enrollment_token = "REPLACE_WITH_LAN_ENROLLMENT_TOKEN",
    ble_pairing_code = "REPLACE_WITH_6_DIGIT_PAIRING_CODE",
    relay_url = "wss://relay.example.invalid/v1/devices/air8000",
    voice_mode = "compatible", -- compatible | wideband; select before a call
    media_backend = "sip_bridge", -- legacy alias for voice_mode
    external_audio = false, -- enable only for a board with a verified external ES8311
    voice_sample_rate = 8000, -- 8000 now; raise to 16000 only after a dedicated test
    carrier_rtp = { enabled = false }, -- legacy optional path only
    location_policy = "on_request", -- off | on_request | periodic
    location_period_ms = 60000,
    wifi = { ssid = "REPLACE_WIFI_SSID", password = "REPLACE_WIFI_PASSWORD" },
    -- Air8000 dev-board network LED is GPIO146; GPIO27 is the 4G test LED.
    -- Set a pin to nil when that LED is not fitted on the board.
    status_led = { wifi_gpio = 146, cellular_gpio = 27, active_high = true },
    limits = { max_message_bytes = 65536, max_sms_body = 4096, nonce_ttl_ms = 300000 },
    -- Compatible mode uses the stock exSIP SIP/UDP bridge and PCMU/8 kHz.
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
