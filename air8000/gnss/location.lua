local M={}

function M.normalize(raw,now)
    if type(raw)~="table" or raw.valid==false or type(raw.lat)~="number" or type(raw.lng or raw.lon)~="number" then
        return {
            fix=false,
            fix_state="lost",
            timestamp=now or 0,
            fix_age_ms=nil,
            satellites=type(raw)=="table" and raw.satellites or nil,
            satellites_visible=type(raw)=="table" and raw.satellites_visible or nil,
        }
    end

    local speed_knots=tonumber(raw.speed)
    return {
        fix=true,
        fix_state="fixed",
        latitude=raw.lat,
        longitude=raw.lng or raw.lon,
        altitude_m=raw.alt or raw.altitude,
        speed_mps=speed_knots and speed_knots*0.514444 or nil,
        speed_knots=speed_knots,
        heading_deg=raw.course,
        satellites=raw.satellites,
        satellites_visible=raw.satellites_visible,
        hdop=raw.hdop,
        vdop=raw.vdop,
        pdop=raw.pdop,
        fix_type=raw.fix_type,
        fix_quality=raw.fix_quality,
        fix_age_ms=raw.fix_age_ms or 0,
        timestamp=now or 0,
    }
end

return M
