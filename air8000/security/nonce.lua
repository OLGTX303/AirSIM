local M = {}
function M.new(cache, value, now, ttl)
    if type(value) ~= "string" or #value < 8 or #value > 128 then return false, "invalid_nonce" end
    now = now or os.time()*1000; ttl = ttl or 300000
    local old = cache[value]
    if old and now - old <= ttl then return false, "replay" end
    cache[value] = now
    for k,t in pairs(cache) do if now - t > ttl then cache[k] = nil end end
    return true
end
return M
