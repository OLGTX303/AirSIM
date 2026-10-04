# Air8000A architecture

Air8000A is the preferred carrier endpoint. LuatOS owns CC/VoLTE, SMS, GNSS,
Wi-Fi/cellular networking, media selection, watchdog and FOTA. The iPhone and
Watch continue to use the existing Relay/CallKit/PushKit path. Samsung Android,
AVF and Shizuku remain a separately selectable `legacy_android` backend.

The device registers over outbound authenticated WSS. Relay changes should be
additive so existing iOS users remain compatible. Direct PCM is preferred only
when runtime capability probing confirms the API; otherwise the native SIP/CC
bridge is selected before the call starts.
