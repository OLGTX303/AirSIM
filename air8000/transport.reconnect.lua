local M = {}

-- A lost LAN/VPS connection must not create a reconnect storm.  Start at
-- five seconds, double each failure, and cap retries at five minutes.  The
-- small jitter prevents several devices rebooted together from reconnecting
-- at exactly the same instant.
local INITIAL_DELAY_MS = 5000
local MAX_DELAY_MS = 300000
local JITTER_PERCENT = 20

function M.new()
    return setmetatable({ attempts = 0, last_delay = 0 }, { __index = M })
end

function M:next()
    self.attempts = self.attempts + 1
    local exponent = math.min(self.attempts - 1, 16)
    local base = math.min(MAX_DELAY_MS, INITIAL_DELAY_MS * (2 ^ exponent))
    local jitter = math.random(0, math.floor(base * JITTER_PERCENT / 100))
    self.last_delay = base + jitter
    return self.last_delay
end

function M:reset()
    self.attempts = 0
    self.last_delay = 0
end

return M
