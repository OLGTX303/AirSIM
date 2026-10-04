-- LuatTools requires a concrete config.lua entry during merge.
-- Replace the placeholders below before using the device with a Relay.
return {
    device_id = "air8000-lan-e3ae10e4",
    serial_number = nil,
    device_secret = "0000000",
    enrollment_token = "41418083be0e2fa1bc909229b5dd9494b31af0eedda9e48c",
    ble_pairing_code = "000000",
    relay_url = "ws://192.168.1.91:8080/device",
    media_backend = "auto",
    location_policy = "on_request",
    location_period_ms = 60000,
    wifi = { ssid = "REPLACE_WIFI_SSID", password = "REPLACE_WIFI_PASSWORD" },
    limits = { max_message_bytes = 65536, max_sms_body = 4096, nonce_ttl_ms = 300000 },
    sip = { enabled = false, uri = "sip:device@example.invalid", password = "REPLACE" }
}
