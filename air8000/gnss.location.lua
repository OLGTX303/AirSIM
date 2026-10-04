local M = {}
function M.normalize(raw, now)
    if type(raw) ~= "table" or type(raw.lat) ~= "number" or type(raw.lng or raw.lon) ~= "number" then return {fix=false,fix_state="lost",timestamp=now or 0,fix_age_ms=nil} end
    return {fix=true,fix_state="fixed",latitude=raw.lat,longitude=raw.lng or raw.lon,altitude_m=raw.alt,speed_mps=raw.speed,heading_deg=raw.course,satellites=raw.satellites,fix_age_ms=raw.fix_age_ms or 0,timestamp=now or 0}
end
return M
