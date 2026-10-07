-- Keeps CC->SIP (remote party) audio continuous on Air8000 base firmware 113
-- (LuatOS V2052, built from LuatOS 7587d4f110).
--
-- In that firmware the CC audio callback GET_NEW_DATA, when CC call recording
-- is off, drains at most two 20 ms frames from play_save_fifo into RTP and
-- then calls luat_fifo_delete_all(play_save_fifo). Any further downlink audio
-- is discarded, and the whole block is lost whenever the 20 ms drain timer
-- holds the drain lock (it is taken with a zero timeout). The result is
-- remote-party speech that "jumps".
--
-- With recording enabled, bridge mode leaves play_save_fifo to the drain
-- timer alone, which reads up to two frames per 20 ms tick and never deletes
-- audio. The recording buffers only receive the SIP->CC (record) side; no
-- cc.on("record") callback is registered, so no Lua work runs per block.
local M = {}

-- 200 ms at 16 kHz per buffer keeps the record-full message rate near 5/s.
M.UP_BUFFER_BYTES = 6400
-- Keep the CC downlink capture buffer large enough for firmware builds that
-- fill record buffers in bursts. The SIP bridge still emits RTP at 20 ms;
-- this buffer is only the capture staging area and must not dictate pacing.
M.DOWN_BUFFER_BYTES = 6400

function M.enable(cc, zbuff)
    if not cc or type(cc.record) ~= "function" then return false, "cc_record_unavailable" end
    if not zbuff or type(zbuff.create) ~= "function" then return false, "zbuff_unavailable" end
    local buffers = {
        zbuff.create(M.UP_BUFFER_BYTES, 0), zbuff.create(M.UP_BUFFER_BYTES, 0),
        zbuff.create(M.DOWN_BUFFER_BYTES, 0), zbuff.create(M.DOWN_BUFFER_BYTES, 0),
    }
    for i = 1, 4 do
        if not buffers[i] then return false, "zbuff_alloc_failed" end
    end
    local ok, result = pcall(cc.record, true, buffers[1], buffers[2], buffers[3], buffers[4])
    if not ok or result == false then return false, ok and "cc_record_failed" or tostring(result) end
    -- The firmware stores raw pointers to these buffers: keep them alive.
    M.buffers = buffers
    M.enabled = true
    return true
end

-- Restores the firmware default (drain + delete per CC block) for A/B
-- listening tests. Buffers stay referenced until enable() replaces them.
function M.disable(cc)
    if not cc or type(cc.record) ~= "function" then return false, "cc_record_unavailable" end
    local ok, result = pcall(cc.record, false)
    if not ok or result == false then return false, ok and "cc_record_failed" or tostring(result) end
    M.enabled = false
    return true
end

return M
