local M={}
function M.status(mobile, sim) local s={sim_ready=false,operator=nil,registration=nil,signal_dbm=nil,ip_state=nil}; if sim and sim.ready then s.sim_ready=sim.ready() end; if mobile then s.operator=mobile.getOperator and mobile.getOperator(); s.registration=mobile.getState and mobile.getState(); s.signal_dbm=mobile.csq and mobile.csq() end; return s end
return M
