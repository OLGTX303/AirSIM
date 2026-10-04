local M={}
function M.can_update(call_active,sms_active) return not call_active and not sms_active end
function M.check(api) return api and api.check and api.check() or false,"unsupported" end
return M
