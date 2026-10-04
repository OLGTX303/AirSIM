return {
    device_id = "air8000-device-REPLACE",
    -- Optional printed/vendor SN. If omitted, the MCU unique ID becomes the SN.
    serial_number = nil,
    device_secret = "REPLACE_WITH_PER_DEVICE_SECRET",
    enrollment_token = "REPLACE_WITH_LAN_ENROLLMENT_TOKEN",
    ble_pairing_code = "REPLACE_WITH_6_DIGIT_PAIRING_CODE",
    relay_url = "wss://relay.example.invalid/v1/devices/air8000",
    media_backend = "auto", -- auto | direct_pcm | sip_bridge
    location_policy = "on_request", -- off | on_request | periodic
    location_period_ms = 60000,
    wifi = { ssid = "REPLACE_WIFI_SSID", password = "REPLACE_WIFI_PASSWORD" },
    limits = { max_message_bytes = 65536, max_sms_body = 4096, nonce_ttl_ms = 300000 },
    sip = { enabled = false, uri = "sip:device@example.invalid", password = "REPLACE" }
}
