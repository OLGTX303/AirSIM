local M = {}
function M.bind(crypto) return { hmac_sha256=crypto.hmac_sha256, constant_time_equal=crypto.constant_time_equal } end
return M
