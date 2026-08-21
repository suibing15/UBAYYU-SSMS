// =====================================================================
//  SSMS — Operator Registry integration (Express-compatible)
//
//  This is the SSMS equivalent of SUIBING Bucket's registryCheck.ts,
//  rewritten for a plain Node/Express backend rather than a Next.js
//  app — SSMS has no single app shell to swap out for a lock screen,
//  it has five separate portals, so this instead gates requests via
//  middleware and returns a clear "paused" response from whichever
//  route was actually called.
//
//  SETUP: add these three environment variables to this school's
//  backend deployment:
//    REGISTRY_URL        = the registry Supabase project URL
//    REGISTRY_ANON_KEY   = the registry publishable (anon) key
//    SCHOOL_KEY          = this school's key, e.g. "assalam-v1"
//
//  Fails OPEN by design: if these aren't set, or the registry can't
//  be reached, SSMS keeps working normally rather than locking a
//  school out over a network hiccup or a school not yet linked.
// =====================================================================
const { createClient } = require("@supabase/supabase-js");

const RURL = process.env.REGISTRY_URL || "";
const RKEY = process.env.REGISTRY_ANON_KEY || "";
const SCHOOL_KEY = process.env.SCHOOL_KEY || "";

const registry = RURL && RKEY ? createClient(RURL, RKEY) : null;

// Cached in memory rather than checked on every single request — a
// school being paused doesn't need to take effect within milliseconds,
// and hitting the registry on every request would be wasteful. Starts
// "active" so the very first requests before the first check completes
// aren't blocked.
let cachedStatus = { active: true, name: null, paid_until: null };

async function refreshSchoolStatus() {
  if (!registry || !SCHOOL_KEY) return cachedStatus; // not linked — fail open
  try {
    const { data, error } = await registry.rpc("school_status", { p_key: SCHOOL_KEY });
    if (error || !data || !data.length) {
      console.error(`Registry check-in for "${SCHOOL_KEY}" got no result (failing open — access unaffected):`, error?.message || "no matching school_key found in the registry");
      return cachedStatus;
    }
    const row = data[0];
    const changed = cachedStatus.active !== !!row.active;
    cachedStatus = { active: !!row.active, name: row.name, paid_until: row.paid_until };
    if (changed) {
      console.log(`📡 Registry: "${row.name || SCHOOL_KEY}" is now ${cachedStatus.active ? "ACTIVE ✅" : "PAUSED ⛔"}`);
    }
  } catch (err) {
    console.error("Registry status check failed (failing open):", err.message);
  }
  return cachedStatus;
}

function getCachedStatus() {
  return cachedStatus;
}

// Fire-and-forget heartbeat — reports this school's current student and
// result counts up to the registry, matching what Bucket's schools already do.
async function reportCounts(students, records) {
  if (!registry || !SCHOOL_KEY) return;
  try {
    await registry.rpc("report_counts", {
      p_key: SCHOOL_KEY,
      p_students: students,
      p_records: records,
    });
  } catch (err) {
    console.error("Registry count report failed (non-critical):", err.message);
  }
}

// Express middleware — blocks with a clear, full-screen page when the
// school has been paused, or a JSON response for anything calling the
// API directly rather than loading an actual page. Data is never
// touched; this only pauses access.
function requireActiveSchool(req, res, next) {
  const status = getCachedStatus();
  if (status.active) return next();

  const schoolName = status.name || "This school";
  const message = `${schoolName}'s SSMS access is currently paused. Your records are safe and nothing has been lost. Please contact the administrator to restore access.`;

  // A real API call (the app's own JS fetching data) gets JSON, so
  // client-side error handling still has something sensible to work
  // with. A normal page load — the common case, someone just opening
  // the school's website — gets the full-screen page instead of a
  // raw block of JSON text.
  const wantsJson = req.path.startsWith("/api") || (req.headers.accept || "").includes("application/json");

  if (wantsJson) {
    return res.status(403).json({ error: "ACCESS_PAUSED", message });
  }

  res.status(403).send(renderLockPage(schoolName, message));
}

// The full-screen lock page itself — deliberately self-contained (no
// external fonts, stylesheets, or scripts) so it always renders
// correctly regardless of what else might be unreachable while a
// school is paused.
function renderLockPage(schoolName, message) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Access Paused — SSMS</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #F8F5EC;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding: 24px;
  }
  .card {
    max-width: 460px;
    width: 100%;
    background: #FFFFFF;
    border-radius: 14px;
    box-shadow: 0 10px 40px rgba(11, 59, 116, 0.12);
    overflow: hidden;
    text-align: center;
  }
  .bar { height: 6px; background: linear-gradient(90deg, #C79A3D, #E0B45C, #C79A3D); }
  .content { padding: 44px 36px 40px; }
  .icon {
    width: 64px; height: 64px;
    margin: 0 auto 22px;
    border-radius: 50%;
    background: rgba(11, 59, 116, 0.08);
    display: flex; align-items: center; justify-content: center;
  }
  h1 { font-size: 21px; color: #0B3B74; margin-bottom: 12px; font-weight: 700; }
  p { font-size: 15px; line-height: 1.6; color: #333A45; margin-bottom: 8px; }
  .school { font-size: 13px; color: #8A8375; margin-top: 24px; letter-spacing: 0.04em; text-transform: uppercase; }
  .footer { font-size: 12px; color: #A6A08F; margin-top: 4px; }
</style>
</head>
<body>
  <div class="card">
    <div class="bar"></div>
    <div class="content">
      <div class="icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="5" y="11" width="14" height="9" rx="2" stroke="#0B3B74" stroke-width="1.8"/>
          <path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="#0B3B74" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </div>
      <h1>Access Paused</h1>
      <p>${esc(message)}</p>
      <div class="school">${esc(schoolName)}</div>
      <div class="footer">Suibing School Management Software</div>
    </div>
  </div>
</body>
</html>`;
}

// Starts the periodic check-in — call once, after dataStore is ready.
// Refreshes status and reports counts on the same interval so a paused
// school is caught within a few minutes, not instantly, but soon.
function startRegistryHeartbeat(getCounts, intervalMinutes = 5) {
  if (!registry || !SCHOOL_KEY) {
    console.log("Registry integration not configured — running standalone (this is fine if not yet linked).");
    return;
  }

  console.log(`📡 Registry integration active — checking in as "${SCHOOL_KEY}" every ${intervalMinutes} minute(s)...`);

  const tick = async () => {
    const status = await refreshSchoolStatus();
    try {
      const { students, records } = getCounts();
      await reportCounts(students, records);
      console.log(`📡 Registry check-in OK — status: ${status.active ? "ACTIVE" : "PAUSED"}, reported ${students} student(s), ${records} record(s)`);
    } catch (err) {
      console.error("Registry heartbeat error:", err.message);
    }
  };

  tick(); // run once immediately on startup
  setInterval(tick, intervalMinutes * 60 * 1000);
}

module.exports = {
  refreshSchoolStatus,
  getCachedStatus,
  reportCounts,
  requireActiveSchool,
  startRegistryHeartbeat,
};
