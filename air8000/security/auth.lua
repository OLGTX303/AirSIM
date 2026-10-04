local nonce = require("security.nonce")
local M = {}
function M.verify(cache, msg, mac, secret, now, crypto)
    if type(secret) ~= "string" or #secret < 16 or type(mac) ~= "string" then return false, "missing_auth" end
    local ok, err = nonce.new(cache, msg.nonce, now); if not ok then return false, err end
    if not crypto or not crypto.hmac_sha256 or not crypto.constant_time_equal then return false, "crypto_unavailable" end
    local expected = crypto.hmac_sha256(secret, msg.canonical)
    if not crypto.constant_time_equal(expected, mac) then return false, "bad_mac" end
    if math.abs((now or 0) - (msg.timestamp or 0)) > 300000 then return false, "stale" end
    return true
end
return M
