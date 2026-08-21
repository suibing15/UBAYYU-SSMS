let REPORTS_LOCKED = false;
let REPORT_LOCK_REASON = "Report access restricted.";

function setReportLock(locked, reason) {
  REPORTS_LOCKED = locked;
  if (reason) REPORT_LOCK_REASON = reason;
}

function isReportLocked() {
  return {
    locked: REPORTS_LOCKED,
    reason: REPORT_LOCK_REASON
  };
}

module.exports = {
  setReportLock,
  isReportLocked
};
