local M = {}
M.max_payload = 4096
function M.header(call_id, seq, timestamp, direction, rate, duration, length)
    assert(type(call_id)=="string" and #call_id<=128 and length>=0 and length<=M.max_payload, "invalid frame")
    return { version=1, call_id=call_id, sequence=seq, timestamp=timestamp, direction=direction,
        sample_rate=rate, frame_duration_ms=duration, payload_length=length }
end
function M.accept(h, payload) return type(h)=="table" and type(payload)=="string" and h.payload_length==#payload and #payload<=M.max_payload end
return M
