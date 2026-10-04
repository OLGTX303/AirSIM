local M = {}
function M.new(api) return { set=function(_,k,v) return api and api.set and api.set(k,v) or true end,
    get=function(_,k) return api and api.get and api.get(k) end,
    delete=function(_,k) return api and api.del and api.del(k) or true end } end
return M
