const { isReportLocked } = require("../utils/reportLockState");

module.exports = function reportGuard(req, res, next) {
  const reportState = isReportLocked();

  if (reportState.locked) {
    return res.status(403).json({
      status: "LICENSE_LOCKED",
      title: "Report Generation Restricted",
      message: reportState.reason,
      action: "Please renew your license to regain access.",
      contact: {
        company: "SUIBING IT SERVICES",
        email: "suibingitservices@gmail.com",
        website: "https://www.suibingitservices.com/schools/licensing"
      }
    });
  }

  next();
};
