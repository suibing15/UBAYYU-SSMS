// server.js
global.SYSTEM_LOCKED = false;
global.SYSTEM_LOCK_REASON = "System locked by administrator.";
global.ADMIN_DEVICES = new Set();

require("dotenv").config();
const bcrypt = require("bcryptjs");
const express = require("express");
const session = require("express-session");
const cors = require("cors");
const helmet = require("helmet");
const multer = require("multer");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { fitSingleLine } = require("./utils/pdfTextFit");

/* ======================================================
   HELPERS
====================================================== */
function getClassSubjectsResolved(data, classId) {
  const cls = (data.classes || []).find(c => c.id === classId);
  if (!cls) return [];

  // Subjects know their own class via subject.classId — derive the
  // list from there. (A class no longer carries its own "subjects"
  // array; that duplicated field was dropped when the data moved to
  // the database, since it's fully derivable from this side.)
  return (data.subjects || [])
    .filter(s => s.classId === classId)
    .map(s => ({ id: s.id, name: s.name }));
 }
function parseCSV(content) {
  const lines = content
    .split(/\r?\n/)
    .filter(l => l.trim().length);

  if (lines.length < 2) return [];

  // Detect delimiter
  const delimiter = lines[0].includes('\t') ? '\t' : ',';

  const headers = splitCSVLine(lines[0], delimiter).map(h => h.trim());

  return lines.slice(1).map(line => {
    const values = splitCSVLine(line, delimiter);
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = (values[i] || '').trim();
    });
    return obj;
  });
}

// Reads an uploaded bulk-question file, whichever real format it's in.
// CSV/TSV/TXT get parsed as delimited text (parseCSV, above). Genuine
// Excel binary files (.xlsx/.xls) go through the xlsx (SheetJS) library
// instead, since they're a zipped binary format, not plain text.
// Either way, the result is the same shape: an array of plain objects
// keyed by whatever the file's own header row said.
function parseBulkQuestionFile(buffer, originalname) {
  const lower = originalname.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const XLSX = require('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { defval: '' });
  }
  return parseCSV(buffer.toString('utf8'));
}

// Turns a header string into a bare, comparable form: lowercase, no
// spaces or punctuation. "Question Text", "question_text", and
// "QuestionText" all normalize to the same thing: "questiontext".
function normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Every reasonable spelling of each field we actually need, so a real
// person's own wording in their own spreadsheet still works, instead
// of silently producing "undefined" for not matching one exact string.
const BULK_QUESTION_HEADER_ALIASES = {
  type: ['type', 'assessmenttype', 'testtype', 'examtype'],
  qid: ['questionid', 'qid', 'id', 'code'],
  text: ['questiontext', 'text', 'question'],
  options: ['options', 'option', 'choices', 'answers'],
  answer: ['answer', 'correct', 'correctanswer', 'correctoption'],
  marks: ['marks', 'mark', 'score', 'points', 'point'],
  image: ['image', 'picture', 'photo', 'imagefile', 'diagram']
};

// Same idea as questions above, for bulk-adding students.
const BULK_STUDENT_HEADER_ALIASES = {
  id: ['studentid', 'admissionno', 'admissionnumber', 'id', 'regno', 'registrationnumber'],
  name: ['fullname', 'studentname', 'name'],
  classId: ['class', 'classid', 'classname'],
  password: ['password', 'pin'],
  image: ['image', 'picture', 'photo', 'imagefile', 'passport']
};

function mapBulkStudentRow(rawRow) {
  const normalized = {};
  for (const [key, value] of Object.entries(rawRow)) {
    normalized[normalizeHeader(key)] = value;
  }
  const out = {};
  for (const [field, aliases] of Object.entries(BULK_STUDENT_HEADER_ALIASES)) {
    for (const alias of aliases) {
      if (normalized[alias] !== undefined && normalized[alias] !== '') {
        out[field] = normalized[alias];
        break;
      }
    }
  }
  return out;
}

// Maps one raw row (however its own headers were spelled) onto our
// internal field names: { type, qid, text, options, answer, marks }.
function mapBulkQuestionRow(rawRow) {
  const normalized = {};
  for (const [key, value] of Object.entries(rawRow)) {
    normalized[normalizeHeader(key)] = value;
  }
  const out = {};
  for (const [field, aliases] of Object.entries(BULK_QUESTION_HEADER_ALIASES)) {
    for (const alias of aliases) {
      if (normalized[alias] !== undefined && normalized[alias] !== '') {
        out[field] = normalized[alias];
        break;
      }
    }
  }
  return out;
}

// ✅ Handles quoted commas correctly
function splitCSVLine(line, delimiter) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}
// A generous upper bound for any single subject's combined score
// (test1+test2+test3+exam) — used only to exclude old, corrupted
// historical rows from average calculations, so one bad number can't
// produce something like an average in the trillions. Not used for
// validating new entries any more — see SCORE_CAPS below for that,
// which reflects the school's actual grading scale.
const REASONABLE_MAX_SCORE = 1000;

// The school's real grading scale — each Continuous Assessment test
// is out of 10, the exam is out of 70 (10+10+10+70 = 100). Enforced
// here so a mistyped score (a teacher typing "100" instead of "10",
// or any other slip) is rejected server-side, in both systems,
// rather than silently accepted and only caught later by a human
// reading the report sheet.
const SCORE_CAPS = { test1: 10, test2: 10, test3: 10, exam: 70 };

// Validates one incoming score value against its field's real cap
// before it's ever accepted — a garbage, mistyped, or out-of-range
// value falls back to whatever was already there, rather than getting
// saved as-is. This is what actually stops a bad number from being
// written in the first place, rather than just working around one
// after the fact.
function sanitizeIncomingScore(field, raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const num = Number(raw);
  const cap = SCORE_CAPS[field] ?? REASONABLE_MAX_SCORE;
  if (Number.isNaN(num) || num < 0 || num > cap) return fallback;
  return num;
}

// A single question's own mark value — much smaller than a whole
// exam's total, so a separate, tighter bound. Guards a bulk CSV/Excel
// upload (or a stray keystroke on the single-question form) from
// slipping a wildly out-of-range number into what should be a small
// per-question weight, which would otherwise inflate the final score
// via completely normal arithmetic further down the line.
const REASONABLE_MAX_MARKS = 100;
function sanitizeQuestionMarks(raw) {
  const num = Number(raw);
  if (Number.isNaN(num) || num <= 0 || num > REASONABLE_MAX_MARKS) return 1;
  return num;
}

function isSchoolDay(date = new Date()) {
  const day = date.getDay(); // 0 = Sunday, 6 = Saturday
  return day >= 1 && day <= 5;
}
function requireTeacher(req, res, next) {
  if (!req.session.teacher)
    return res.status(401).json({ error: "Teacher not logged in" });

  const data = readData();
  const teacher = (data.teachers || []).find(
    t => t.id === req.session.teacher.id
  );

  if (!teacher || teacher.blocked || teacher.active !== true) {
    delete req.session.teacher;
    return res.status(403).json({ error: "Teacher access revoked" });
  }

  next();
}

function calculateWeeklyPercentage(attendance, studentId) {
  let total = 0;
  let present = 0;

  Object.values(attendance || {}).forEach(day => {
    if (day.students && day.students[studentId]) {
      total++;
      if (day.students[studentId] === "present") present++;
    }
  });

  return total ? Math.round((present / total) * 100) : 0;
}

/* ======================================================
   DIRECTORIES (SINGLE SOURCE OF TRUTH)
====================================================== */
// Question images are served at /uploads/<filename> (see the static
// route below), so they must physically live in the matching
// top-level "uploads" folder — not /tmp, which is both wiped on every
// restart when hosted AND doesn't match the served URL path at all,
// meaning uploaded question images could never have actually shown.
const QUESTION_IMAGE_DIR = path.join(__dirname, 'uploads');

// Ensure folder exists
[QUESTION_IMAGE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

/* ======================================================
   MULTER CONFIGS (NO DUPLICATES)
====================================================== */

// Bulk question upload — CSV, TSV, TXT, or genuine Excel (.xlsx/.xls).
// Uses memory storage: the file is read once, parsed, then discarded,
// so there's no need to write it to disk (and no /tmp dependency to
// go wrong on a hosted environment).
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'csv') {
      const lower = file.originalname.toLowerCase();
      const allowed = ['.csv', '.tsv', '.txt', '.xlsx', '.xls'];
      if (allowed.some(ext => lower.endsWith(ext))) return cb(null, true);
      return cb(new Error('Only CSV, TSV, TXT, or Excel (.xlsx/.xls) files are allowed for the question sheet'));
    }
    if (file.fieldname === 'images') {
      if (file.mimetype.startsWith('image/')) return cb(null, true);
      return cb(new Error('Only image files are allowed in the images batch'));
    }
    cb(new Error('Unexpected field: ' + file.fieldname));
  }
}).fields([
  { name: 'csv', maxCount: 1 },
  { name: 'images', maxCount: 100 } // batch of pictures, matched to rows by filename
]);

// Same shape as csvUpload above, for bulk-adding students. Kept as a
// separate instance (rather than reusing csvUpload) since the field
// name here is "photos", matching what a bulk-student form naturally
// calls it, distinct from the question sheet's "images" field.
const studentBulkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'csv') {
      const lower = file.originalname.toLowerCase();
      const allowed = ['.csv', '.tsv', '.txt', '.xlsx', '.xls'];
      if (allowed.some(ext => lower.endsWith(ext))) return cb(null, true);
      return cb(new Error('Only CSV, TSV, TXT, or Excel (.xlsx/.xls) files are allowed for the student sheet'));
    }
    if (file.fieldname === 'photos') {
      if (file.mimetype.startsWith('image/')) return cb(null, true);
      return cb(new Error('Only image files are allowed in the photos batch'));
    }
    cb(new Error('Unexpected field: ' + file.fieldname));
  }
}).fields([
  { name: 'csv', maxCount: 1 },
  { name: 'photos', maxCount: 200 }
]);

// Question image upload — memory only, uploaded to Supabase Storage
// by the route below.
const questionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files allowed'));
    }
  }
}).single('image');

// Branding uploads (logo, principal signature, form master signature)
// must land in public/uploads, since every PDF generator resolves
// meta.logo / meta.signaturePrincipal relative to that folder. Using
// questionUpload here (which saves to /tmp instead) was the bug that
// made every branding upload silently point at a file that didn't exist.
const BRANDING_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(BRANDING_UPLOAD_DIR)) fs.mkdirSync(BRANDING_UPLOAD_DIR, { recursive: true });

const brandingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files allowed'));
    }
  }
}).single('image');


/* ======================================================
   IMPORTS
====================================================== */
const { generateQuestionPDF } = require("./utils/questionPdfGenerator");
const reportGuard = require("./middleware/reportGuard");
const { readData, writeData, updateData } = require("./utils/dataStore");
const { uploadBuffer, uploadLocalFileAndCleanup, tempPdfPath, deleteFromStorage, storagePathFromUrl, resolveImageForGeneration, withResolvedImages, withResolvedImagesForMany, withResolvedFieldForMany } = require("./utils/storage");
const { requireActiveSchool, startRegistryHeartbeat } = require("./utils/registryCheck");
const { generateExamPDF, generateConsolidatedResultPDF } = require("./utils/pdfGenerator");
const { generateReportPDF } = require("./utils/reportGenerator");
const { generateClassReportPDF } = require("./utils/classReportGenerator");
const { generateIDCard } = require("./utils/idCardGenerator");
const {
  generateClassAttendancePDF,
  generateTeacherAttendancePDF
} = require("./utils/attendancePdf");

/* ======================================================
   ADMIN ACCESS GUARD
====================================================== */
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) {
    global.ADMIN_DEVICES.add(req.sessionID);
    return next();
  }

  if (global.ADMIN_DEVICES.has(req.sessionID)) {
    return next();
  }

  return res.status(404).send("Not found");
}

/* ======================================================
   APP INIT
====================================================== */
const app = express();
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  credentials: true
}));

// Render (and most hosting platforms) sit behind a reverse proxy that
// terminates HTTPS and forwards plain HTTP internally — without this,
// Express has no way to know the original connection was actually
// secure, and would refuse to set the "secure: true" session cookie
// configured below, silently breaking cross-origin login in
// production even though the site is genuinely running on HTTPS.
app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false
}));

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: "school.sid",
  secret: process.env.SESSION_SECRET || "attendance_secret_key",
  resave: false,
  saveUninitialized: false,
  cookie: {
    // "lax" cookies are never sent on a cross-origin fetch/XHR call —
    // only on a direct top-level link click. Since the real frontend
    // and this backend live on two different domains once actually
    // deployed (Render + wherever the Next.js frontend is hosted),
    // every login-dependent request would silently arrive with no
    // session cookie at all, looking exactly like "the frontend can't
    // reach the backend" even though the connection itself is fine.
    // "none" fixes this, but browsers require "secure: true" the
    // moment sameSite is "none" — which needs real HTTPS, so this
    // only switches on in production (Render). Local development
    // (plain http://localhost) keeps the old, working lax/insecure
    // settings, since secure cookies are never sent over plain HTTP.
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax"
  }
}));

// Registry gate — checks the school's cached status before anything
// else is served, a page load or an API call alike. A school that's
// never been linked to the registry (no REGISTRY_URL/REGISTRY_ANON_KEY/
// SCHOOL_KEY set) passes straight through unaffected; this only
// actually gates anything once a school has genuinely been connected
// to the operator registry. Applied globally now, not just to /api —
// a paused school should see the clean full-screen lock page the
// moment they open any page at all, not just get a broken-looking
// error the first time the page tries to fetch data.
app.use(requireActiveSchool);
const crypto = require("crypto");

function fingerprint(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

// 🔒 protected files
const CORE_FILES = [
  __filename,                     // server.js
  require.resolve("./utils/pdfGenerator"), 
];

// 🔐 generate fingerprints once
const SIGNATURES = CORE_FILES.map(fingerprint);

// 🕵️ silent integrity check
setInterval(() => {
  try {
    CORE_FILES.forEach((f, i) => {
      if (fingerprint(f) !== SIGNATURES[i]) {
        console.error("System integrity compromised.");
        process.exit(1); // silent kill
      }
    });
  } catch {
    process.exit(1);
  }
}, 60_000); // every 60 seconds
// -------------------- TEACHER LOGIN (ATTENDANCE) --------------------
app.post('/api/attendance/teacher/login', async (req, res) => {
  const { teacherId, password } = req.body;

  if (!teacherId || !password) {
    return res.status(400).json({ error: 'Missing credentials' });
  }

  const data = readData();
  const candidate = (data.teachers || []).find(
    t => t.id === teacherId && t.active === true && t.blocked !== true
  );
  const match = candidate && (await bcrypt.compare(password, candidate.password));
  const teacher = match ? candidate : null;

  if (!teacher) {
    return res.status(401).json({ error: 'Invalid or blocked teacher' });
  }

  req.session.teacher = {
    id: teacher.id,
    name: teacher.name
  };

  res.json({
    success: true,
    teacher: {
      id: teacher.id,
      name: teacher.name
    }
  });
});
// -------------------- ATTENDANCE: GET CLASSES --------------------
app.get('/api/attendance/classes', (req, res) => {
  try {
    const data = readData();

    const classes = (data.classes || []).map(c => ({
      id: c.id,
      name: c.name
    }));

    res.json({ classes });
  } catch (err) {
    console.error('Attendance classes error:', err);
    res.status(500).json({ error: 'Failed to load classes' });
  }
});
// -------------------- MARK CLASS ATTENDANCE --------------------
app.post("/api/attendance/mark", requireTeacher, async (req, res) => {
  const { classId, classPassword, students } = req.body;

  if (!classId || !classPassword || !students) {
    return res.status(400).json({ error: "Missing attendance data" });
  }

  if (!isSchoolDay()) {
    return res.status(403).json({ error: "Attendance allowed Mon–Fri only" });
  }

  try {
    const snapshot = readData();

    const cls = (snapshot.classes || []).find(c => c.id === classId);
    if (!cls) {
      return res.status(404).json({ error: "Class not found" });
    }

    if (cls.password !== classPassword) {
      return res.status(401).json({ error: "Invalid class password" });
    }

    const today = new Date().toISOString().slice(0, 10);
    const existingToday = snapshot.attendance?.[classId]?.[today];

    if (existingToday && existingToday.teacherId !== req.session.teacher.id) {
      return res.status(403).json({
        error: "Attendance already submitted by another teacher today"
      });
    }

    // Atomic update, same mechanism the score-entry grid uses — safe
    // even if another request touches shared data at the same moment.
    await updateData((data) => {
      data.attendance ||= {};
      data.attendance[classId] ||= {};

      const validStudents = {};
      (data.students || [])
        .filter(s => s.classId === classId)
        .forEach(s => {
          validStudents[s.id] =
            students[s.id] === "present" ? "present" : "absent";
        });

      data.attendance[classId][today] = {
        teacherId: req.session.teacher.id,
        timestamp: new Date().toISOString(),
        students: validStudents
      };
    }, ['attendance']); // only the attendance table needs re-saving here

    // 🔹 clear success signal for UI animation
    res.json({
      success: true,
      status: "sent",
      message: "Attendance submitted successfully"
    });

  } catch (err) {
    console.error("Attendance error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});
// -------------------- GET STUDENTS BY CLASS --------------------
app.get('/api/attendance/class/:classId/students', requireTeacher, (req, res) => {
  try {
    const { classId } = req.params;
    const data = readData();

    const students = (data.students || [])
      .filter(s => s.classId === classId)
      .map(s => ({
        id: s.id,
        name: s.name
      }));

    res.json({ students });

  } catch (err) {
    console.error('Load students error:', err);
    res.status(500).json({ error: 'Failed to load students' });
  }
});

// -------------------- TODAY'S ATTENDANCE (for pre-filling on re-open) --------------------
// New: lets the attendance-marking screen show what's already been
// submitted today, if anything, instead of always starting blank —
// useful for a teacher fixing one mistake without re-marking everyone.
app.get('/api/attendance/class/:classId/today', requireTeacher, (req, res) => {
  try {
    const { classId } = req.params;
    const data = readData();
    const today = new Date().toISOString().slice(0, 10);
    const existing = data.attendance?.[classId]?.[today] || null;
    res.json({ existing });
  } catch (err) {
    console.error('Load today attendance error:', err);
    res.status(500).json({ error: 'Failed to load today\'s attendance' });
  }
});
// -------------------- VIEW CLASS ATTENDANCE --------------------
app.get('/api/admin/attendance/:classId', (req, res) => {
  if (!req.session.admin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const data = readData();
  const records = (data.attendance || {})[req.params.classId] || {};

  res.json({ attendance: records });
});


// -------------------- DELETE CLASS ATTENDANCE (PERMANENT) --------------------
app.delete('/api/admin/attendance/:classId', async (req, res) => {
  if (!req.session.admin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const classId = req.params.classId;
  const data = readData();

  if (!data.attendance || !data.attendance[classId]) {
    return res.status(404).json({ error: 'No attendance found for this class' });
  }

  // 🔥 PERMANENT DELETE
  delete data.attendance[classId];

  await writeData(data, ['attendance']);

  console.log(`🗑️ Attendance deleted for class ${classId}`);

  res.json({
    success: true,
    message: `Attendance for class ${classId} deleted permanently`
  });
});


// -------------------- ATTENDANCE: GET STUDENTS BY CLASS --------------------
app.get('/api/attendance/class/:id/students', (req, res) => {
  try {
    const classId = req.params.id;
    const data = readData();

    const students = (data.students || []).filter(
      s => s.classId === classId
    );

    res.json({ students });
  } catch (err) {
    console.error('Attendance students error:', err);
    res.status(500).json({ error: 'Failed to load students' });
  }
});


/* ======================================================
   STATIC FILES
====================================================== */
/* ======================================================
   FREEZE ENFORCEMENT — blocks every OTHER portal (teacher,
   exam, parent, attendance) while frozen. Admin routes are
   allowlisted so freezing never locks the admin out.
====================================================== */
const FREEZE_ALLOWLIST = [
  "/manage",
  "/api/admin",
  "/api/system",
  // The admin Settings page fetches /api/meta alongside /api/system/status
  // in a single Promise.all — without this, freezing made /api/meta start
  // returning 503, which made that whole Promise.all reject and silently
  // discard the systemStatus() result too. That left the frontend's
  // "locked" state stuck at false, so the unlock password field never
  // appeared even though the freeze had genuinely worked. School branding
  // is informational, not one of the portals freezing is meant to pause,
  // so it stays readable regardless of lock state.
  "/api/meta",
  "/broadcast.js",
  "/public/sounds",
  "/index.html",
  "/lock.html"
];
app.use((req, res, next) => {
  if (!global.SYSTEM_LOCKED) return next();
  if (req.path === "/" || FREEZE_ALLOWLIST.some(p => req.path.startsWith(p))) {
    return next();
  }
  if (req.path.startsWith("/api/")) {
    return res.status(503).json({ error: "System is temporarily frozen by the administrator." });
  }
  return res.sendFile(path.join(__dirname, "public", "lock.html"));
});

app.use("/reports", express.static(path.join(__dirname, "reports")));
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/files", express.static(path.join(__dirname, "files")));
app.use("/data", express.static(path.join(__dirname, "data")));
app.use('/question-pdfs', express.static(path.join(__dirname, 'public/question-pdfs')));
// MAIN STATIC ROOT
app.use(express.static(path.resolve(__dirname, "public")));
app.use(
  "/reports",
  express.static(path.resolve(__dirname, "public/reports"))
);
/* ======================================================
   DEBUG LOGGER
====================================================== */
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

// helper: default initial structure (same as your dataStore initial)
function defaultData() {
  return {
    meta: {
      schoolName: "ASSALAM INTERNATIONAL ACADEMY GARKO",
      term: "Second Term",
      logo: "/public/logo.png", // hardcoded fallback logo path (public)
      signaturePrincipal: "/public/sign_principal.png",
      signatureFormMaster: "/public/sign_formmaster.png",
      portalToggles: { teacherPortal: true, examPortal: true, reportPortal: true },
      portalPasswords: { teacherPortal: "portalteach2025", examPortal: "portalexam2025", reportPortal: "portalreport2025" },
      testToggles: { test1: true, test2: true, test3: true, exam: true },
      // optional defaults for timeLimits if you want global fallback
      defaultTimeLimits: { test1: 30, test2: 30, test3: 30, exam: 60 }
    },
    admins: [{ username: "admin", password: "Admin@123" }],
    teachers: [{ username: "teacher1", password: "Teach@123", name: "Mrs Aisha", sections: ["Nursery","Primary"] }],
    classes: [],
    students: [],
    parents: [],
    subjects: [],
    results: [],
    pdfs: []
  };
}

// Thin, honest wrapper around the real readData() — used only by a
// couple of older call sites in this file for consistency. No longer
// falls back to reading or recreating the old data.json file: with
// two real schools now running on this codebase, silently serving an
// empty default dataset on a database hiccup was worse than just
// surfacing the real error, and a shared local data.json file is
// exactly the kind of thing that could accidentally carry one
// school's frozen historical data into a different school's
// deployment if ever copied along with the code.
function ReadData() {
  return readData();
}

// serve index
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// ===== HIDDEN ADMIN FILES =====
app.get('/manage', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'management', 'admin.html'));
});

app.get('/manage/admin.js', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'management', 'admin.js'));
});

app.get('/manage/admin-ui.js', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'management', 'admin-ui.js'));
});
// ===== ADMIN UNLOCK =====
app.post('/api/manage-unlock', (req, res) => {
  const { key } = req.body;

  if (key === 'ASSLM') {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }

  return res.status(404).json({ error: 'Not found' });
});
app.post('/api/manage-lock', requireAdmin, (req, res) => {
  global.SYSTEM_LOCKED = true;
  global.ADMIN_DEVICES.clear();
  res.json({ success: true, message: 'Admin locked' });
});
app.get('/manage-unlock', (req, res) => {
  res.sendFile(path.join(__dirname, 'management', 'unlock.html'));
});

// ---------------- META ----------------
app.get('/api/meta', (req, res) => {
  try {
    const data = ReadData();
    res.json({ meta: data.meta });
  } catch (err) {
    console.error('/api/meta error:', err);
    res.status(500).json({ error: 'Unable to read meta' });
  }
});
// ✅ Make bulk ID folder public so browser can access PDFs
app.use("/idcards/bulk", express.static(path.join(__dirname, "public/idcards/bulk")));
// ================= SYSTEM CONTROL =================
// The old licenseGuard + Mega Server heartbeat system has been
// removed entirely — it read the old data.json file directly (this
// was the actual cause of the ENOENT crash once that file moved),
// and its job — checking whether this school's access should be
// restricted — is now done properly by the registry integration
// (requireActiveSchool, near the top of this file), which checks a
// real, live console instead of an unreachable "Mega Server."
app.post("/offline-sync", async (req, res) => {
    try {
        const offlinePayload = req.body;

        if (!Array.isArray(offlinePayload)) {
            return res.status(400).json({ error: "Invalid payload" });
        }

        await updateData((data) => {
            if (!data.offlineQueue) data.offlineQueue = [];
            offlinePayload.forEach(item => {
                data.offlineQueue.push({
                    ...item,
                    syncedAt: new Date().toISOString()
                });
            });
        }, ['settings']);

        res.json({ status: "OK", received: offlinePayload.length });

    } catch (err) {
        res.status(500).json({ error: "Sync failed" });
    }
});

// ---------------- ADMIN ----------------
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const data = ReadData();
  const admin = (data.admins || []).find(a => a.username === username);
  const match = admin && (await bcrypt.compare(password, admin.password));
  if (!match) return res.status(401).json({ error: 'Invalid admin credentials' });
  req.session.admin = admin.username;
  res.json({ success: true });
});

// portal toggle
app.post('/api/admin/toggle', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  const { key, value } = req.body;
  try {
    const data = ReadData();
    if (!data.meta) data.meta = {};
    if (!data.meta.portalToggles) data.meta.portalToggles = {};
    data.meta.portalToggles[key] = !!value;
    writeData(data, ['settings']).then(() => res.json({ success: true })).catch(err => {
      console.error('toggle writeData error:', err);
      res.status(500).json({ error: 'Failed to persist toggle' });
    });
  } catch (err) {
    console.error('/api/admin/toggle error:', err);
    res.status(500).json({ error: 'Failed to toggle' });
  }
});

// get test toggles
app.get('/api/admin/testToggles', (req, res) => {
  if (!req.session.admin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const data = ReadData();

    if (!data.meta) data.meta = {};
    if (!data.meta.testToggles) {
      data.meta.testToggles = {
        test1: true,
        test2: true,
        test3: true,
        exam: true
      };
    }

    res.json({ testToggles: data.meta.testToggles });
  } catch (err) {
    console.error('GET testToggles error:', err);
    res.status(500).json({ error: 'Failed to load test toggles' });
  }
});

// set test toggle
app.post('/api/admin/testToggles', async (req, res) => {
  if (!req.session.admin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { key, value } = req.body;
  if (!key) {
    return res.status(400).json({ error: 'Missing key' });
  }

  try {
    const data = ReadData();

    if (!data.meta) data.meta = {};
    if (!data.meta.testToggles) {
      data.meta.testToggles = {
        test1: true,
        test2: true,
        test3: true,
        exam: true
      };
    }

    data.meta.testToggles[key] = Boolean(value);

    await writeData(data, ['settings']);
    res.json({ success: true, testToggles: data.meta.testToggles });
  } catch (err) {
    console.error('POST testToggles error:', err);
    res.status(500).json({ error: 'Failed to update test toggles' });
  }
});


// get pdfs
app.get('/api/admin/pdfs', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  const data = ReadData();
  res.json({ pdfs: data.pdfs || [] });
});

// ----------------------------- UPLOAD LOGO / SIGNATURE -----------------------------
app.post('/api/admin/upload', brandingUpload, async (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: 'Unauthorized' });

  if (!req.file)
    return res.status(400).json({ error: 'No image uploaded' });

  try {
    // Prefer the type sent as a URL query parameter (reliable — a text
    // form field can lag behind the file itself arriving). Still checks
    // req.body.type too for any older callers, then falls back to
    // guessing from the filename as a last resort.
    const explicitType = (req.query.type || req.body.type || "").toLowerCase();
    const lower = req.file.originalname.toLowerCase();

    let type = "logo";
    if (explicitType === "principal" || (!explicitType && lower.includes('principal'))) type = "principal";
    else if (explicitType === "formmaster" || (!explicitType && lower.includes('form'))) type = "formmaster";

    const ext = path.extname(req.file.originalname) || '.png';
    // Uploaded to Supabase Storage now, not local disk — this is what
    // actually survives a redeploy or a restart on a host with no
    // persistent disk, which local disk never did.
    const publicUrl = await uploadBuffer(`branding/${type}${ext}`, req.file.buffer, req.file.mimetype);

    const data = readData();
    data.meta ||= {};
    if (type === "principal") data.meta.signaturePrincipal = publicUrl;
    else if (type === "formmaster") data.meta.signatureFormMaster = publicUrl;
    else data.meta.logo = publicUrl;

    await writeData(data, ['settings']);
    res.json({ success: true, path: publicUrl });

  } catch (err) {
    console.error('/api/admin/upload error:', err);
    res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});


// ----------------------------- ADD SUBJECT (class-wise only) -----------------------------
app.post('/api/admin/subject', (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: 'Unauthorized' });

  const { id, name, classId } = req.body;
  if (!id || !name || !classId)
    return res.status(400).json({ error: 'Missing fields' });

  const data = readData();
  data.subjects ||= [];
  data.classes ||= [];

  if (data.subjects.some(s => s.id === id && s.classId === classId))
    return res.status(400).json({ error: 'Subject already exists' });

  data.subjects.push({
    id,
    name,
    classId,
    questions: { test1: [], test2: [], test3: [], exam: [] },
    timeLimits: { test1: 30, test2: 30, test3: 30, exam: 60 }
  });

  writeData(data, ['subjects'])
    .then(() =>
      res.json({
        success: true,
        message: "Operation completed successfully."
      })
    )
    .catch(() => res.status(500).json({ error: 'Write failed' }));
});



// ----------------------------- GET SUBJECTS BY CLASS -----------------------------
app.get('/api/admin/subjects', (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: 'Unauthorized' });

  try {
    const classId = req.query.classId;
    const data = readData();
    let subjects = data.subjects || [];

    if (classId) {
      subjects = subjects.filter(s => s.classId === classId);
    }

    // ✅ CRITICAL FIX: normalize timeLimits for ALL subjects
    subjects = subjects.map(s => {
      if (!s.timeLimits) {
        s.timeLimits = {
          test1: 30,
          test2: 30,
          test3: 30,
          exam: 60
        };
      }
      return s;
    });

    res.json({ subjects });
  } catch (err) {
    console.error('/api/admin/subjects GET error:', err);
    res.status(500).json({ error: 'Failed to fetch subjects' });
  }
});

// ----------------------------- DELETE SUBJECT -----------------------------
app.delete(['/api/admin/subject/:id/:classId', '/api/admin/subject/:id'], (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const id = req.params.id;
    const classId = req.params.classId || req.query.classId;
    if (!id || !classId)
      return res.status(400).json({ error: 'Missing subject ID or class ID' });

    const data = readData();

    data.subjects = (data.subjects || []).filter(
      s => !(s.id === id && s.classId === classId)
    );

    writeData(data, ['subjects', 'questions'])
      .then(() =>
        res.json({
          success: true,
          message: "Operation completed successfully."
        })
      )
      .catch(err => {
        console.error('delete subject writeData error:', err);
        res.status(500).json({ error: 'Failed to delete subject' });
      });

  } catch (err) {
    console.error('/api/admin/subject delete error:', err);
    res.status(500).json({ error: 'Failed to delete subject' });
  }
});


// ----------------------------- ADD QUESTION -----------------------------
app.post("/api/admin/question", (req, res) => {
  questionUpload(req, res, async err => {
    if (err) {
      console.error("Image upload error:", err);
      return res.status(500).json({ error: "Image upload failed" });
    }

    if (!req.session.admin)
      return res.status(401).json({ error: "Unauthorized" });

    const { subjectId, classId, qid, text, options, answer, marks } = req.body;
    const type = String(req.body.type || "").toLowerCase();

    if (!subjectId || !classId || !type || !qid || !text)
      return res.status(400).json({ error: "Missing required fields" });

    try {
      const data = readData();
      const subj = data.subjects.find(
        s => s.id === subjectId && s.classId === classId
      );

      if (!subj)
        return res.status(404).json({ error: "Subject not found" });

      subj.questions[type] ||= [];

      let parsedOptions = [];
      try {
        parsedOptions = Array.isArray(options)
          ? options
          : JSON.parse(options);
      } catch {
         parsedOptions = String(options || '')
          .split(',')
          .map(o => o.trim())
          .filter(Boolean);
      }

      let imageUrl = null;
      if (req.file) {
        const ext = path.extname(req.file.originalname) || '.png';
        const safeQid = String(qid).replace(/[^a-zA-Z0-9_-]/g, '_');
        // Uploaded to Supabase Storage — survives a redeploy or
        // restart, which local disk never did.
        imageUrl = await uploadBuffer(`questions/${safeQid}${ext}`, req.file.buffer, req.file.mimetype);
      }

      subj.questions[type].push({
        qid,
        text,
        options: parsedOptions,
        answer: answer || "",
        marks: sanitizeQuestionMarks(marks),
        image: imageUrl
      });

      await writeData(data, ['questions']);
      res.json({ success: true, message: "Question added successfully" });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Internal error" });
    }
  });
});


// -------------------- GENERATE QUESTION PDF --------------------
app.get("/api/admin/questions/pdf", async (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const { classId, subjectId, type } = req.query;
  const normalizedType = String(type || "").toLowerCase();

  try {
    const data = readData();
    const subj = data.subjects.find(
      s => s.id === subjectId && s.classId === classId
    );

    if (!subj)
      return res.status(404).json({ error: "Subject not found" });

    const questions = subj.questions[normalizedType] || [];
    if (!questions.length)
      return res.status(400).json({ error: "No questions available" });

    const fileName = `${classId}_${subjectId}_${normalizedType}.pdf`;
    const localPath = tempPdfPath(fileName);

    // The school's logo and each question's own image are Supabase
    // URLs now — resolved to local temp files first, generateQuestionPDF
    // itself is completely unchanged.
    const logoResolved = await withResolvedImages(data.meta || {});
    const questionsResolved = await withResolvedFieldForMany(questions, "image");

    await generateQuestionPDF(
      {
        ...logoResolved.meta, // real school branding: schoolName, address, motto, phone, logo, etc.
        className: classId,
        subjectName: subj.name,
        type: normalizedType,
        term: data.meta?.term
      },
      questionsResolved.items,
      localPath
    );
    logoResolved.cleanup();
    questionsResolved.cleanup();

    const relPath = await uploadLocalFileAndCleanup(localPath, `question-papers/${classId}_${subjectId}_${normalizedType}.pdf`);
    res.json({ success: true, file: relPath });
  } catch (err) {
    console.error("Question PDF error:", err);
    res.status(500).json({ error: "Failed to generate PDF" });
  }
});


// -------------------- FORWARD QUESTIONS --------------------
app.post("/api/admin/questions/forward", (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const { fromClass, toClass, subjectId } = req.body;

  try {
    const data = readData();

    const source = data.subjects.find(
      s => s.id === subjectId && s.classId === fromClass
    );
    if (!source)
      return res.status(404).json({ error: "Source subject not found" });

    let target = data.subjects.find(
      s => s.id === subjectId && s.classId === toClass
    );

   if (!target) {
  target = {
    id: subjectId,
    name: source.name,
    classId: toClass,
    questions: { test1: [], test2: [], test3: [], exam: [] },

    // ✅ FIX: preserve timing
    timeLimits: source.timeLimits || {
      test1: 30,
      test2: 30,
      test3: 30,
      exam: 60
    }
  };
  data.subjects.push(target);
}


    ["test1", "test2", "test3", "exam"].forEach(t => {
      target.questions[t] = JSON.parse(
        JSON.stringify(source.questions[t] || [])
      );
    });

    writeData(data, ['subjects', 'questions']).then(() => res.json({ success: true }));
  } catch (err) {
    console.error("Forward error:", err);
    res.status(500).json({ error: "Failed to forward questions" });
  }
});


// -------------------- BULK CSV UPLOAD --------------------
app.post('/api/admin/questions/bulk-upload', csvUpload, async (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: 'Unauthorized' });

  const { subjectId, classId } = req.body;
  const sheetFile = req.files?.csv?.[0];
  if (!sheetFile)
    return res.status(400).json({ error: 'Question sheet file required' });

  try {
    const rows = parseBulkQuestionFile(sheetFile.buffer, sheetFile.originalname);
    if (!rows.length)
      return res.status(400).json({ error: 'File appears to be empty' });

    const data = readData();
    const subj = data.subjects.find(
      s => s.id === subjectId && s.classId === classId
    );

    if (!subj)
      return res.status(404).json({ error: 'Subject not found' });

    // Batch of images (optional), matched to rows by filename below.
    // Saved under their own original name so the "image" column in
    // the sheet just needs to say e.g. "q5_diagram.png" and it matches.
    const imageFiles = req.files?.images || [];
    const imagesByName = {};
    imageFiles.forEach(f => { imagesByName[f.originalname.toLowerCase()] = f; });
    const unmatchedImageNames = new Set(Object.keys(imagesByName));

    let added = 0;
    let skipped = 0;
    let imagesAttached = 0;

    // Was `.forEach`, which silently ignores `await` inside its
    // callback — every image upload would have fired without ever
    // actually being waited for, meaning the write below could run
    // before any of them finished. A real for-of loop actually
    // pauses for each upload, in order.
    for (const rawRow of rows) {
      const r = mapBulkQuestionRow(rawRow);
      const type = String(r.type || '').toLowerCase().trim();

      if (!subj.questions[type]) { skipped++; continue; }

      const options = String(r.options || '')
        .split(',')
        .map(o => o.trim())
        .filter(Boolean);

      // Match this row's "image" column value against the uploaded
      // batch of images, by filename (case-insensitive, ignores any
      // path the person's spreadsheet might have included).
      let imagePath = null;
      const wantedImage = String(r.image || '').trim();
      if (wantedImage) {
        const wantedName = wantedImage.split(/[\\/]/).pop().toLowerCase();
        const match = imagesByName[wantedName];
        if (match) {
          const ext = path.extname(match.originalname) || '.png';
          const safeQid = String(r.qid || `Q${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_');
          // Uploaded to Supabase Storage — survives a redeploy or
          // restart, which local disk never did.
          imagePath = await uploadBuffer(`questions/${safeQid}${ext}`, match.buffer, match.mimetype);
          unmatchedImageNames.delete(wantedName);
          imagesAttached++;
        }
      }

      subj.questions[type].push({
        qid: r.qid || `Q${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        text: r.text || '',
        options,
        answer: String(r.answer || '').trim(),
        marks: sanitizeQuestionMarks(r.marks),
        image: imagePath
      });
      added++;
    }

    if (!added) {
      return res.status(400).json({
        error: `No rows matched a valid type (test1/test2/test3/exam). ${skipped} row(s) skipped — check the "type" column.`
      });
    }

    await writeData(data, ['questions']);
    res.json({
      success: true,
      added,
      skipped,
      imagesAttached,
      unmatchedImages: Array.from(unmatchedImageNames) // uploaded but no row referenced them — worth telling the admin
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk upload failed: ' + err.message });
  }
})

// ----------------------------- DELETE QUESTION -----------------------------
// ----------------------------- EDIT QUESTION -----------------------------
// Fixes a mistake in an existing question's text, options, answer, or
// marks — without deleting and re-adding it, and without disturbing
// its position or any other question. Searches every test type the
// same way the delete route above already does, since the URL alone
// doesn't say which type array the question actually lives in.
app.put('/api/admin/question/:subjectId/:qid/:classId', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { subjectId, qid, classId } = req.params;
    const { text, options, answer, marks } = req.body;
    const data = readData();
    const subj = (data.subjects || []).find(s => s.id === subjectId && s.classId === classId);
    if (!subj) return res.status(404).json({ error: 'Subject not found' });

    let question = null;
    for (const t of ['test1', 'test2', 'test3', 'exam']) {
      const found = (subj.questions[t] || []).find(q => q.qid === qid);
      if (found) { question = found; break; }
    }

    if (!question) return res.status(404).json({ error: 'Question not found' });

    if (typeof text === 'string' && text.trim()) question.text = text.trim();
    if (typeof answer === 'string') question.answer = answer.trim();
    if (marks !== undefined && marks !== '') question.marks = Number(marks) || question.marks;
    if (options !== undefined) {
      question.options = Array.isArray(options)
        ? options
        : String(options || '').split(',').map(o => o.trim()).filter(Boolean);
    }

    writeData(data, ['questions'])
      .then(() => res.json({ success: true, question }))
      .catch(() => res.status(500).json({ error: 'Failed to save changes' }));
  } catch (err) {
    console.error('/api/admin/question PUT error:', err);
    res.status(500).json({ error: 'Failed to save changes' });
  }
});

app.delete('/api/admin/question/:subjectId/:qid/:classId', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { subjectId, qid, classId } = req.params;
    const data = readData();
    const subj = (data.subjects || []).find(s => s.id === subjectId && s.classId === classId);
    if (!subj) return res.status(404).json({ error: 'Subject not found' });

    let found = false;
    for (const t of ['test1', 'test2', 'test3', 'exam']) {
      const before = subj.questions[t].length;
      subj.questions[t] = subj.questions[t].filter(q => q.qid !== qid);
      if (before !== subj.questions[t].length) found = true;
    }

    if (!found) return res.status(404).json({ error: 'Question not found' });

    writeData(data, ['questions'])
      .then(() => res.json({ success: true }))
      .catch(err => res.status(500).json({ error: 'Failed to delete question' }));
  } catch (err) {
    console.error('/api/admin/question DELETE error:', err);
    res.status(500).json({ error: 'Failed to delete question' });
  }
});

// ----------------------------- UPDATE TIMINGS -----------------------------
app.post('/api/admin/subject/timings', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { subjectId, classId, timings } = req.body;
    if (!subjectId || !classId || !timings)
      return res.status(400).json({ error: 'Missing subjectId/classId/timings' });

    const data = readData();
    const subj = (data.subjects || []).find(s => s.id === subjectId && s.classId === classId);
    if (!subj) return res.status(404).json({ error: 'Subject not found' });

    subj.timeLimits = {
      test1: Number(timings.test1) || 30,
      test2: Number(timings.test2) || 30,
      test3: Number(timings.test3) || 30,
      exam: Number(timings.exam) || 60
    };

    writeData(data, ['subjects'])
      .then(() => res.json({ success: true, timeLimits: subj.timeLimits }))
      .catch(err => {
        console.error('timings writeData error:', err);
        res.status(500).json({ error: 'Failed to update timings' });
      });
  } catch (err) {
    console.error('/api/admin/subject/timings error:', err);
    res.status(500).json({ error: 'Failed to update timings' });
  }
});

// ---------------- ADMIN: CLASSES ----------------

// Get classes
app.get('/api/admin/classes', (req, res) => {
  if (!req.session?.admin) return res.status(401).json({ error: 'Unauthorized' });
  const data = readData();
  res.json({ classes: data.classes || [] });
});

// Add class
app.post('/api/admin/class', (req, res) => {
  if (!req.session?.admin) return res.status(401).json({ error: 'Unauthorized' });

  const { id, name, password } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'Missing class id or name' });

  try {
    const data = readData();
    if (!data.classes) data.classes = [];

    if (data.classes.find(c => c.id === id)) {
      return res.status(400).json({ error: 'Class id already exists' });
    }

    data.classes.push({ id, name, password: password || '' });

    writeData(data, ['classes'])
      .then(() => res.json({ success: true }))
      .catch(() => res.status(500).json({ error: 'Failed to save class' }));

  } catch {
    res.status(500).json({ error: 'Failed to add class' });
  }
});

// Delete class
app.delete("/api/admin/class/:id", (req, res) => {
  if (!req.session?.admin)
    return res.status(401).json({ error: "Unauthorized" });

  try {
    const id = req.params.id;
    const data = readData();

    data.classes = (data.classes || []).filter(c => c.id !== id);
    data.students = (data.students || []).filter(s => s.classId !== id);

    writeData(data, ['classes', 'students'])
      .then(() =>
        res.json({
          success: true,
          message: "Class deleted successfully"
        })
      )
      .catch(() =>
        res.status(500).json({ error: "Failed to delete class" })
      );
  } catch {
    res.status(500).json({ error: "Failed to delete class" });
  }
});



// ---------------- STUDENT CRUD ----------------

// ✅ Configure multer for photo uploads — memory only now, uploaded
// to Supabase Storage by each route below rather than written to
// local disk (which never survives a redeploy or restart without a
// persistent disk attached).
let uploadInstance;
try {
  uploadInstance = global.upload || multer({ storage: multer.memoryStorage() });
} catch (err) {
  uploadInstance = multer({ storage: multer.memoryStorage() });
}
global.upload = uploadInstance;

// ✅ Define upload middleware
const studentUpload = uploadInstance.single("photo");
const teacherUpload = uploadInstance.single("photo");

// ---------------- ROUTES ----------------

// Get all students in a class
app.get("/api/admin/class/:id/students", (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const classId = req.params.id;
  const data = readData();
  const students = (data.students || []).filter((s) => s.classId === classId);
  res.json({ students });
});

// Add a new student
app.post("/api/admin/student", studentUpload, async (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const { id, name, classId, password } = req.body;
  if (!id || !name || !classId)
    return res
      .status(400)
      .json({ error: "Missing student id/name/classId" });

  try {
    const data = readData();
    if (!data.students) data.students = [];

    if (data.students.find(s => s.id === id))
      return res.status(400).json({ error: "Student id already exists" });

    if (!data.classes.find(c => c.id === classId))
      return res.status(400).json({ error: "Class does not exist" });

    let photoPath = null;
    if (req.file) {
      const ext = path.extname(req.file.originalname) || ".jpg";
      photoPath = await uploadBuffer(`students/${id}${ext}`, req.file.buffer, req.file.mimetype);
    }

    const plainPassword = password || id; // shown once, in this response only
    const hashedPassword = await bcrypt.hash(String(plainPassword), 10);

    data.students.push({
      id,
      name,
      classId,
      password: hashedPassword,
      photo: photoPath
    });

    writeData(data, ['students'])
      .then(() =>
        res.json({
          success: true,
          message: "Student added successfully",
          generatedPassword: plainPassword // for printing an ID card right now — never stored anywhere else
        })
      )
      .catch(err => {
        console.error("add student writeData error:", err);
        res.status(500).json({ error: "Failed to persist student" });
      });
  } catch (err) {
    console.error("/api/admin/student POST error:", err);
    res.status(500).json({ error: "Failed to add student" });
  }
});


// ----------------------------- BULK ADD STUDENTS (CSV/Excel + optional photos) -----------------------------
app.post("/api/admin/students/bulk-upload", studentBulkUpload, async (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const sheetFile = req.files?.csv?.[0];
  if (!sheetFile)
    return res.status(400).json({ error: "Student sheet file required" });

  try {
    // Reuses the exact same generic file-format parser the bulk
    // question upload already uses — it never had anything
    // question-specific in it, it just turns a CSV/TSV/XLSX/XLS file
    // into an array of plain row objects.
    const rows = parseBulkQuestionFile(sheetFile.buffer, sheetFile.originalname);
    if (!rows.length)
      return res.status(400).json({ error: "File appears to be empty" });

    const data = readData();
    if (!data.students) data.students = [];

    // Batch of photos (optional), matched to rows by filename — same
    // pattern as the question bulk-upload's picture matching.
    const photoFiles = req.files?.photos || [];
    const photosByName = {};
    photoFiles.forEach(f => { photosByName[f.originalname.toLowerCase()] = f; });
    const unmatchedPhotoNames = new Set(Object.keys(photosByName));

    let added = 0;
    let skipped = 0;
    let imagesAttached = 0;
    const credentials = []; // shown once in the response, never stored in plain text
    const skipReasons = [];

    for (const rawRow of rows) {
      const r = mapBulkStudentRow(rawRow);
      const id = String(r.id || "").trim();
      const name = String(r.name || "").trim();
      const classId = String(r.classId || "").trim().toUpperCase();

      if (!id || !name || !classId) {
        skipped++;
        skipReasons.push(`Missing id/name/class in one row`);
        continue;
      }
      if (data.students.find(s => s.id === id)) {
        skipped++;
        skipReasons.push(`${id}: a student with this ID already exists`);
        continue;
      }
      if (!(data.classes || []).find(c => c.id === classId)) {
        skipped++;
        skipReasons.push(`${id}: class "${classId}" does not exist`);
        continue;
      }

      // Match this row's "image" column value against the uploaded
      // batch of photos, by filename (case-insensitive).
      let photoPath = null;
      const wantedImage = String(r.image || "").trim();
      if (wantedImage) {
        const wantedName = wantedImage.split(/[\\/]/).pop().toLowerCase();
        const match = photosByName[wantedName];
        if (match) {
          const ext = path.extname(match.originalname) || ".jpg";
          const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
          photoPath = await uploadBuffer(`students/${safeId}${ext}`, match.buffer, match.mimetype);
          unmatchedPhotoNames.delete(wantedName);
          imagesAttached++;
        }
      }

      const plainPassword = String(r.password || "").trim() || id;
      const hashedPassword = await bcrypt.hash(plainPassword, 10);

      data.students.push({
        id,
        name,
        classId,
        password: hashedPassword,
        photo: photoPath
      });
      credentials.push({ id, name, password: plainPassword });
      added++;
    }

    if (!added) {
      return res.status(400).json({
        error: `No students were added. ${skipped} row(s) skipped.`,
        skipReasons
      });
    }

    writeData(data, ['students']).then(() => res.json({
      success: true,
      added,
      skipped,
      imagesAttached,
      unmatchedImages: Array.from(unmatchedPhotoNames),
      credentials,
      skipReasons
    }));
  } catch (err) {
    console.error("Bulk student upload error:", err);
    res.status(500).json({ error: "Bulk student upload failed: " + err.message });
  }
});

// Edit student
app.put("/api/admin/student/:id", studentUpload, async (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  try {
    const studentId = req.params.id;
    const { name, classId, password } = req.body;
    const data = readData();
    const st = (data.students || []).find(s => s.id === studentId);
    if (!st) return res.status(404).json({ error: "Student not found" });

    if (typeof name !== "undefined") st.name = name;
    if (typeof classId !== "undefined") {
      if (!data.classes.find(c => c.id === classId))
        return res.status(400).json({ error: "Class does not exist" });
      st.classId = classId;
    }

    let generatedPassword;
    if (typeof password !== "undefined" && password !== "") {
      generatedPassword = password; // shown once, in this response only
      st.password = await bcrypt.hash(String(password), 10);
    }

    if (req.file) {
      const ext = path.extname(req.file.originalname) || ".jpg";
      st.photo = await uploadBuffer(`students/${st.id}${ext}`, req.file.buffer, req.file.mimetype);
    }

    writeData(data, ['students'])
      .then(() =>
        res.json({
          success: true,
          message: "Student updated successfully",
          generatedPassword // undefined if the password wasn't changed this time
        })
      )
      .catch(err => {
        console.error("edit student writeData error:", err);
        res.status(500).json({ error: "Failed to persist student edit" });
      });
  } catch (err) {
    console.error("/api/admin/student PUT error:", err);
    res.status(500).json({ error: "Failed to edit student" });
  }
});


// Delete student
// Delete ALL students at once (school-wide)
app.delete("/api/admin/students/all", async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: "Unauthorized" });

  try {
    const data = readData();
    const deleted = (data.students || []).length;
    data.students = [];
    // Their results no longer belong to any real student, so clear those too
    data.results = [];
    await writeData(data, ['students']);
    res.json({ success: true, deleted });
  } catch (err) {
    console.error("/api/admin/students/all DELETE error:", err);
    res.status(500).json({ error: "Failed to delete all students" });
  }
});

app.delete("/api/admin/student/:id", (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  try {
    const studentId = req.params.id;
    const data = readData();

    data.students = (data.students || []).filter(s => s.id !== studentId);
    data.results = (data.results || []).filter(r => r.studentId !== studentId);
    data.pdfs = (data.pdfs || []).filter(p => p.studentId !== studentId);

    writeData(data, ['students'])
      .then(() =>
        res.json({
          success: true,
          message: "Student deleted successfully"
        })
      )
      .catch(err => {
        console.error("delete student writeData error:", err);
        res.status(500).json({ error: "Failed to persist student deletion" });
      });
  } catch (err) {
    console.error("/api/admin/student DELETE error:", err);
    res.status(500).json({ error: "Failed to delete student" });
  }
});
// ======================================================
// GET STUDENTS BY CLASS (ADMIN ONLY)
// ======================================================
app.get("/api/admin/students/class/:classId", (req, res) => {
  if (!req.session?.admin) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const classId = req.params.classId.trim().toUpperCase();

  try {
    const data = readData();
    const students = data.students || [];

    const classStudents = students.filter(
      s => String(s.classId || "").toUpperCase() === classId
    );

    return res.json({ students: classStudents });

  } catch (err) {
    console.error("Fetch students by class error:", err);
    res.status(500).json({ error: "Server error" });
  }
});
// -------------------- BULK PROMOTE STUDENTS --------------------
app.post("/api/admin/students/promote", (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const { fromClass, toClass } = req.body;

  if (!fromClass || !toClass)
    return res.status(400).json({ error: "Missing fromClass or toClass" });

  try {
    const data = readData();

    // Validate target class
    const targetClass = (data.classes || []).find(c => c.id === toClass);
    if (!targetClass)
      return res.status(404).json({ error: "Target class does not exist" });

    const students = (data.students || []).filter(
      s => s.classId === fromClass
    );

    if (!students.length)
      return res.status(404).json({ error: "No students in source class" });

    // Promote students
    students.forEach(st => {
      st.classId = toClass;
    });

    const promotedIds = students.map(s => s.id);

    // ❌ Remove all academic traces
    data.results = (data.results || []).filter(
      r => !promotedIds.includes(r.studentId)
    );

    data.pdfs = (data.pdfs || []).filter(
      p => !promotedIds.includes(p.studentId)
    );

    writeData(data, ['students'])
      .then(() =>
        res.json({
          success: true,
          count: students.length,
          message: "Students promoted successfully"
        })
      )
      .catch(err => {
        console.error("bulk promote writeData error:", err);
        res.status(500).json({ error: "Failed to promote students" });
      });

  } catch (err) {
    console.error("Bulk promotion error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
 // -------------------- ADD TEACHER --------------------
app.post("/api/admin/teacher", teacherUpload, async (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const { id, name, password } = req.body;
  if (!id || !name || !password)
    return res.status(400).json({ error: "Missing id/name/password" });

  try {
    const data = readData();
    data.teachers ||= [];

    if (data.teachers.find(t => t.id === id))
      return res.status(400).json({ error: "Teacher already exists" });

    let photoPath = null;
    if (req.file) {
      const ext = path.extname(req.file.originalname) || ".jpg";
      photoPath = await uploadBuffer(`teachers/${id}${ext}`, req.file.buffer, req.file.mimetype);
    }

    const hashedPassword = await bcrypt.hash(String(password), 10);

    data.teachers.push({
      id,
      name,
      password: hashedPassword,
      photo: photoPath,
      active: true,
      blocked: false,
      createdAt: new Date().toISOString().slice(0, 10)
    });

    writeData(data, ['teachers'])
      .then(() =>
        res.json({
          success: true,
          message: "Teacher registered successfully",
          generatedPassword: password // shown once, in this response only
        })
      )
      .catch(() =>
        res.status(500).json({ error: "Failed to save teacher" })
      );

  } catch (err) {
    console.error("Add teacher error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// -------------------- LIST TEACHERS --------------------
app.get("/api/admin/teachers", (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const data = readData();
  res.json({ teachers: data.teachers || [] });
});

// -------------------- TOGGLE TEACHER ACCESS --------------------
app.put("/api/admin/teacher/:id/toggle", (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const teacherId = decodeURIComponent(req.params.id);

  const data = readData();
  const teacher = (data.teachers || []).find(
    t => t.id === teacherId
  );

  if (!teacher)
    return res.status(404).json({ error: "Teacher not found" });

  teacher.blocked = !teacher.blocked;

  writeData(data, ['teachers'])
    .then(() => res.json({ success: true, blocked: teacher.blocked }))
    .catch(() => res.status(500).json({ error: "Failed to update teacher" }));
});

// -------------------- DELETE TEACHER --------------------
// Delete ALL teachers at once (school-wide)
app.delete("/api/admin/teachers/all", async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: "Unauthorized" });

  try {
    const data = readData();
    const deleted = (data.teachers || []).length;
    data.teachers = [];
    await writeData(data, ['teachers']);
    res.json({ success: true, deleted });
  } catch (err) {
    console.error("/api/admin/teachers/all DELETE error:", err);
    res.status(500).json({ error: "Failed to delete all teachers" });
  }
});

app.delete("/api/admin/teacher/:id", (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const teacherId = decodeURIComponent(req.params.id);

  const data = readData();
  data.teachers = (data.teachers || []).filter(
    t => t.id !== teacherId
  );

  writeData(data, ['teachers'])
    .then(() => res.json({ success: true }))
    .catch(() => res.status(500).json({ error: "Failed to delete teacher" }));
});

app.post("/api/teacher/logout", (req, res) => {
  delete req.session.teacher;
  res.json({ success: true });
});

app.post("/api/admin/logout", (req, res) => {
  delete req.session.admin;
  res.json({ success: true });
});

/* ========= CLASS PDF ========= */
app.get("/api/admin/attendance/class/:id/pdf", async (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const { from, to } = req.query;
  const data = readData();

  const cls = data.classes.find(c => c.id === req.params.id);
  if (!cls) return res.status(404).json({ error: "Class not found" });

  const students = data.students.filter(s => s.classId === cls.id);
  const attendance = data.attendance?.[cls.id] || {};

  // Resolve each day's teacherId into a real name, so the PDF can show
  // who actually signed the class in on each day, not just a bare ID.
  const teacherById = {};
  (data.teachers || []).forEach(t => { teacherById[t.id] = t.name; });
  Object.values(attendance).forEach(day => {
    day.teacherName = teacherById[day.teacherId] || day.teacherId || "Unknown";
  });

  const file = `ATTENDANCE_${cls.id}.pdf`;
  const localPath = tempPdfPath(file);

  // data.meta.logo is a Supabase Storage URL now — resolved to a
  // local temp file first, generateClassAttendancePDF itself is
  // completely unchanged.
  const logoResolved = await withResolvedImages(data.meta);

  try {
    await generateClassAttendancePDF({
      meta: logoResolved.meta,
      cls,
      students,
      attendance,
      fromDate: from,
      toDate: to,
      outPath: localPath
    });
  } finally {
    logoResolved.cleanup();
  }

  const relPath = await uploadLocalFileAndCleanup(localPath, `attendance/${cls.id}/${file}`);
  res.json({ file: relPath });
});

/* ========= TEACHER PDF ========= */
app.get("/api/admin/attendance/teachers/pdf", async (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  try {
    const { from, to } = req.query;
    const data = readData();

    const file = "TEACHER_ATTENDANCE.pdf";
    const localPath = tempPdfPath(file);

    // data.meta.logo is a Supabase Storage URL now — resolved to a
    // local temp file first, generateTeacherAttendancePDF itself is
    // completely unchanged.
    const logoResolved = await withResolvedImages(data.meta);

    // Uses each teacher's own login-based attendance record, not the
    // class-attendance object — those track different things (who
    // signed a class in, versus whether the teacher themselves was
    // present that day).
    try {
      await generateTeacherAttendancePDF({
        meta: logoResolved.meta,
        teachers: data.teachers || [],
        teacherAttendance: data.teacherAttendance || {},
        fromDate: from,
        toDate: to,
        outPath: localPath
      });
    } finally {
      logoResolved.cleanup();
    }

    const relPath = await uploadLocalFileAndCleanup(localPath, `attendance/${file}`);
    res.json({ file: relPath });
  } catch (err) {
    console.error("Teacher attendance PDF error:", err);
    res.status(500).json({ error: "Failed to generate teacher attendance PDF" });
  }
});

// JSON view of every teacher's own attendance record, for the
// on-screen weekly table (the PDF route above is for the download).
app.get("/api/admin/attendance/teachers", (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const data = readData();
  res.json({ attendance: data.teacherAttendance || {} });
});

// ---------------- PORTAL AUTH ----------------
app.post('/api/portal/teacher/auth', (req, res) => {
  const { portalPassword } = req.body;
  const data = readData();
  if (data.meta?.portalToggles?.teacherPortal === false) {
    return res.status(403).json({ error: 'Teacher portal is disabled by admin' });
  }
  if (portalPassword === data.meta.portalPasswords.teacherPortal) {
    req.session.portalTeacher = true;
    res.json({ success: true });
  } else res.status(401).json({ error: 'Invalid password' });
});

app.post('/api/portal/exam/auth', (req, res) => {
  const { portalPassword } = req.body;
  const data = readData();
  if (data.meta?.portalToggles?.examPortal === false) {
    return res.status(403).json({ error: 'Exam portal is disabled by admin' });
  }
  if (portalPassword === data.meta.portalPasswords.examPortal) {
    req.session.portalExam = true;
    res.json({ success: true });
  } else res.status(401).json({ error: 'Invalid password' });
});

app.post('/api/portal/report/auth', (req, res) => {
  const { portalPassword } = req.body;
  const data = readData();
  if (data.meta?.portalToggles?.reportPortal === false) {
    return res.status(403).json({ error: 'Report portal is disabled by admin' });
  }
  if (portalPassword === data.meta.portalPasswords.reportPortal) {
    req.session.portalReport = true;
    res.json({ success: true });
  } else res.status(401).json({ error: 'Invalid password' });
});

// ---------------- CLASSES & STUDENTS (public) ----------------
app.get('/api/classes', (req, res) => {
  const data = readData();
  res.json({ classes: data.classes || [] });
});

// ✅ Admin classes endpoint (for dropdowns, ID card pages etc)
app.get('/api/admin/classes', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Admin login required' });

  const data = readData();
  res.json({ classes: data.classes || [] });
});

// Helper: normalize class IDs (remove spaces + lowercase)
function normalize(str) {
  return String(str).toLowerCase().replace(/\s+/g, '');
}

// ✅ Teacher class auth using session only
app.post('/api/teacher/class/auth', (req, res) => {
  if (!req.session.portalTeacher)
    return res.status(401).json({ error: 'Teacher login required' });

  const { classId, classPassword } = req.body;
  const data = readData();

  // FIXED: match class IDs with or without spaces
  const cls = data.classes.find(c => normalize(c.id) === normalize(classId));

  if (!cls) 
    return res.status(404).json({ error: 'Class not found' });

  if (cls.password !== classPassword)
    return res.status(401).json({ error: 'Wrong class password' });

  // Save the REAL class ID in the session
  req.session.teacherClass = cls.id;

  res.json({ success: true });
});


// ✅ Get students in a class (public endpoint for exam portal)
app.get('/api/class/:classId/students', (req, res) => {
  const classId = req.params.classId;
  const data = readData();
  const students = (data.students || [])
    .filter(s => s.classId === classId)
    .map(({ password, ...safe }) => safe); // never send password hashes to the browser

  res.json({ students });
});

// ---------------- EXAM PORTAL: VERIFY A STUDENT'S OWN PASSWORD ----------------
// The actual check has to happen here, server-side, since student.password
// is a bcrypt hash — comparing it with plain "===" in the browser (which is
// what the old client-side code did) can never work against a hash, and
// sending the hash itself to the browser at all isn't good practice either.
app.post('/api/exam/student/verify', async (req, res) => {
  try {
    const { studentId, password } = req.body;
    if (!studentId || !password) {
      return res.status(400).json({ success: false, error: 'Student and password required' });
    }

    const data = readData();
    const student = (data.students || []).find(s => s.id === studentId);
    if (!student) return res.status(404).json({ success: false, error: 'Student not found' });

    const match = await bcrypt.compare(String(password), student.password);
    if (!match) return res.status(401).json({ success: false, error: 'Invalid student password' });

    res.json({ success: true });
  } catch (err) {
    console.error('/api/exam/student/verify error:', err);
    res.status(500).json({ success: false, error: 'Server error during verification' });
  }
});

// ======================================================
// SINGLE ID CARD (ADMIN ONLY)
// ======================================================
// ---------------- ADMIN: GENERATE TEACHER ID CARD ----------------
app.post("/api/admin/teacher/:teacherId/idcard", async (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Admin login required" });

  try {
    const data = readData();
    const teacher = (data.teachers || []).find(t => t.id === req.params.teacherId);
    if (!teacher) return res.status(404).json({ error: "Teacher not found" });

    // Teacher IDs at this school can contain slashes (e.g. "ASLM/P/01"),
    // which Node would otherwise read as a folder separator, causing the
    // file write to fail outright since that subfolder doesn't exist.
    const safeId = String(teacher.id).replace(/[\/\\]/g, "_");
    const outputPath = tempPdfPath(`teacher_${safeId}.pdf`);

    // Generated fresh and streamed straight back — no Storage upload
    // needed, same reasoning as the other ID card routes above.
    const resolved = await withResolvedImages(data.meta || {}, teacher);
    const { generateTeacherIDCard } = require("./utils/idCardGenerator");
    await generateTeacherIDCard(resolved.student, resolved.meta, outputPath);
    resolved.cleanup();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=teacher_${safeId}.pdf`);
    res.sendFile(outputPath, (err) => {
      fs.unlink(outputPath, () => {});
      if (err) console.error("Error streaming teacher ID card:", err.message);
    });
  } catch (err) {
    console.error("Teacher ID card error:", err);
    res.status(500).json({ error: "Failed to generate teacher ID card" });
  }
});

app.post("/api/admin/idcard/:studentId", async (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Admin login required" });

  try {
    const data = readData();
    const students = data.students || [];

    const student = students.find(
      s => s.id === req.params.studentId || s.studentId === req.params.studentId
    );

    if (!student)
      return res.status(404).json({ error: "Student not found" });

    const sid = String(student.id || student.studentId).replace(/[\/\\]/g, "_");
    const outputPath = tempPdfPath(`${sid}.pdf`);

    // This card is generated fresh and streamed straight back for
    // this one request — it never needs to persist afterward, so no
    // Storage upload here, just a temp file cleaned up once sent. The
    // student's photo and the school's logo are Supabase URLs now,
    // resolved to local temp files first so generateIDCard (kept
    // completely unchanged) keeps working exactly as it always has.
    const resolved = await withResolvedImages(data.meta || {}, student);
    const { generateIDCard } = require("./utils/idCardGenerator");
    await generateIDCard(resolved.student, resolved.meta, outputPath, req.body.plainPassword);
    resolved.cleanup();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=${sid}.pdf`);
    res.sendFile(outputPath, (err) => {
      fs.unlink(outputPath, () => {}); // best-effort cleanup either way
      if (err) console.error("Error streaming ID card:", err.message);
    });

  } catch (err) {
    console.error("❌ Single ID card error:", err);
    res.status(500).json({ error: "Failed to generate ID Card" });
  }
});

// ======================================================
// BULK ID CARDS (ONE PDF PER CLASS – ADMIN ONLY)
// ======================================================
app.post("/api/admin/idcards/class/:classId", async (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Admin login required" });

  try {
    const classId = req.params.classId.trim().toUpperCase();
    // Optional: generate cards for only a specific subset of students
    // in this class, rather than everyone — lets the admin select
    // exactly who needs a card instead of always printing the whole class.
    const studentIds = Array.isArray(req.body?.studentIds) ? req.body.studentIds : null;

    const data = readData();
    const students = data.students || [];

    let classStudents = students.filter(
      s => String(s.classId || "").toUpperCase() === classId
    );

    if (studentIds && studentIds.length) {
      const idSet = new Set(studentIds);
      classStudents = classStudents.filter(s => idSet.has(s.id));
    }

    if (!classStudents.length) {
      return res.status(404).json({
        error: `No matching students found in class ${classId}`
      });
    }

    const fileName = `CLASS_${classId}_ID_CARDS.pdf`;
    const outputFile = tempPdfPath(fileName);

    // Generated fresh and streamed straight back — no Storage upload
    // needed, same reasoning as the single ID card route above.
    const resolved = await withResolvedImagesForMany(data.meta || {}, classStudents);
    const { generateBulkIDCards } = require("./utils/idCardGenerator");
    await generateBulkIDCards(resolved.people, resolved.meta, outputFile);
    resolved.cleanup();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=${fileName}`);
    res.sendFile(outputFile, (err) => {
      fs.unlink(outputFile, () => {});
      if (err) console.error("Error streaming bulk ID cards:", err.message);
    });

  } catch (err) {
    console.error("❌ Bulk ID card error:", err);
    res.status(500).json({ error: "Failed to generate class ID cards" });
  }
});

// ======================================================
// BULK STUDENT ID CARDS BY SELECTION (ONE COMBINED PDF)
// ======================================================
// Unlike the class-scoped route above, this takes a flat list of
// student IDs directly — used when the admin's selection spans more
// than one class, so there's no single classId to scope the URL to.
app.post("/api/admin/idcards/students/bulk", async (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Admin login required" });

  try {
    const studentIds = Array.isArray(req.body?.studentIds) ? req.body.studentIds : [];
    if (!studentIds.length) {
      return res.status(400).json({ error: "No students selected" });
    }

    const data = readData();
    const idSet = new Set(studentIds);
    const selected = (data.students || []).filter(s => idSet.has(s.id));

    if (!selected.length) {
      return res.status(404).json({ error: "No matching students found" });
    }

    const fileName = `STUDENT_ID_CARDS_${Date.now()}.pdf`;
    const outputFile = tempPdfPath(fileName);

    const resolved = await withResolvedImagesForMany(data.meta || {}, selected);
    const { generateBulkIDCards } = require("./utils/idCardGenerator");
    await generateBulkIDCards(resolved.people, resolved.meta, outputFile);
    resolved.cleanup();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=${fileName}`);
    res.sendFile(outputFile, (err) => {
      fs.unlink(outputFile, () => {});
      if (err) console.error("Error streaming student ID cards:", err.message);
    });
  } catch (err) {
    console.error("❌ Bulk student ID card error:", err);
    res.status(500).json({ error: "Failed to generate student ID cards" });
  }
});

// ======================================================
// BULK TEACHER ID CARDS (ONE COMBINED PDF – ADMIN ONLY)
// ======================================================
// Accepts an optional list of specific teacher IDs; with none given,
// generates cards for every teacher in the school.
app.post("/api/admin/idcards/teachers/bulk", async (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Admin login required" });

  try {
    const teacherIds = Array.isArray(req.body?.teacherIds) ? req.body.teacherIds : null;

    const data = readData();
    let teachers = data.teachers || [];

    if (teacherIds && teacherIds.length) {
      const idSet = new Set(teacherIds);
      teachers = teachers.filter(t => idSet.has(t.id));
    }

    if (!teachers.length) {
      return res.status(404).json({ error: "No matching teachers found" });
    }

    const fileName = `TEACHER_ID_CARDS_${Date.now()}.pdf`;
    const outputFile = tempPdfPath(fileName);

    const resolved = await withResolvedImagesForMany(data.meta || {}, teachers);
    const { generateBulkTeacherIDCards } = require("./utils/idCardGenerator");
    await generateBulkTeacherIDCards(resolved.people, resolved.meta, outputFile);
    resolved.cleanup();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=${fileName}`);
    res.sendFile(outputFile, (err) => {
      fs.unlink(outputFile, () => {});
      if (err) console.error("Error streaming teacher ID cards:", err.message);
    });
  } catch (err) {
    console.error("❌ Bulk teacher ID card error:", err);
    res.status(500).json({ error: "Failed to generate teacher ID cards" });
  }
});

// ✅ Update class lock
app.put("/api/admin/class/:classId/lock", async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { classId } = req.params;
    const { locked } = req.body;

    const data = readData();

    const cls = (data.classes || []).find(c => c.id === classId);
    if (!cls) return res.status(404).json({ error: "Class not found" });

    cls.locked = !!locked;
    await writeData(data, ['classes']);

    res.json({ success: true, locked: cls.locked });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update class lock" });
  }
});
// 🔔 Global Broadcast Message (Admin only)
app.post("/api/admin/broadcast", (req, res) => {
  if (!req.session.admin) {
    return res.status(401).json({ error: "Admin login required" });
  }

  const { text, durationSeconds } = req.body; // Expect { text, durationSeconds } from front-end
  if (!text || text.trim() === "") {
    return res.status(400).json({ error: "Broadcast message cannot be empty" });
  }

  const seconds = Number(durationSeconds) > 0 ? Number(durationSeconds) : 30; // 30s default

  global.broadcastMessage = {
    text: text.trim(),
    durationSeconds: seconds,
    expiresAt: Date.now() + seconds * 1000
  };

  console.log(`Broadcast sent (${seconds}s):`, global.broadcastMessage.text);
  res.json({ success: true, message: "Broadcast sent to all users" });
});

// 🔍 Route for users to fetch current broadcast message
app.get("/api/broadcast", (req, res) => {
  if (!global.broadcastMessage || Date.now() > global.broadcastMessage.expiresAt) {
    return res.json({ text: null });
  }

  res.json({
    text: global.broadcastMessage.text,
    durationSeconds: global.broadcastMessage.durationSeconds || 30
  });
});
let receiptCounter = 1; // simple auto numbering

app.post("/api/admin/receipts/bulk", async (req, res) => {
  try {
    if (!req.session?.admin) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { classId, term, amount, students } = req.body;

    if (!classId || !term || !amount || !Array.isArray(students) || students.length === 0) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const data = readData();
    const meta = data.meta || {};

    const PDFDocument = require("pdfkit");
    const path = require("path");
    const fs = require("fs");

    const doc = new PDFDocument({ size: "A4", margin: 40 });

    const filename = `receipts_${Date.now()}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

    doc.pipe(res);

    // meta.logo is a Supabase Storage URL now — resolved to a local
    // temp file first, since PDFKit's .image() needs a real local
    // path or buffer, not a URL. This streams straight to the
    // response and is never stored, so cleanup happens once the PDF
    // finishes streaming (the "end" listener further below).
    const logoResolved = await resolveImageForGeneration(meta.logo);
    const logoPath = logoResolved.path || path.join(__dirname, "public", "logo.png");
    doc.on("end", logoResolved.cleanup);

    const PAGE_WIDTH = doc.page.width;
    const RECEIPT_HEIGHT = 230; // height for each receipt
    const START_X = 50;
    const WIDTH = PAGE_WIDTH - 100;

    let receiptIndexOnPage = 0;

    students.forEach((student, index) => {

      // Add new page after every 3 receipts
      if (receiptIndexOnPage === 3) {
        doc.addPage();
        receiptIndexOnPage = 0;
      }

      const startY = 50 + receiptIndexOnPage * (RECEIPT_HEIGHT + 20);

      // Border
      doc
        .lineWidth(1)
        .rect(40, startY - 10, PAGE_WIDTH - 80, RECEIPT_HEIGHT)
        .stroke();

      // Logo
      if (fs.existsSync(logoPath)) {
        try {
          doc.image(logoPath, PAGE_WIDTH / 2 - 20, startY, { width: 40 });
        } catch {}
      }

      // School Name
      doc.font("Helvetica-Bold").fontSize(12);
      fitSingleLine(doc, meta.schoolName || "ASSALAM INTERNATIONAL ACADEMIC SCHOOL", START_X, startY + 50, WIDTH, { startSize: 12, minSize: 7, font: "Helvetica-Bold", align: "center" });

      // Motto + Address
      doc
        .font("Helvetica")
        .fontSize(8)
        .text(
          meta.address || "Behind Garko Motor Park, Opp. Tasidi Filling Station",
          START_X,
          startY + 68,
          { width: WIDTH, align: "center" }
        )
        .text(
          `Motto: ${meta.motto || "Success comes after tears"}`,
          START_X,
          startY + 80,
          { width: WIDTH, align: "center" }
        );

    doc.moveTo(60, startY + 95).lineTo(PAGE_WIDTH - 60, startY + 95).stroke();

// ===== FORM TITLE =====
doc
  .font("Helvetica-Bold")
  .fontSize(13) // slightly bigger
  .text(
    "PAYMENT RECEIPT",
    START_X,
    startY + 102,
    { width: WIDTH, align: "center" }
  );

     const receiptNo = `RCPT-${new Date().getFullYear()}-${receiptCounter++}`;

// ===== FORM TITLE =====
doc
  .font("Helvetica-Bold")
  .fontSize(13)
  .text(
    "PAYMENT RECEIPT",
    START_X,
    startY + 102,
    { width: WIDTH, align: "center" }
  );

// ===== BODY START POSITION =====
const bodyStartY = startY + 125;
const lineGap = 15;

doc
  .font("Helvetica")
  .fontSize(9)
  .text(`Receipt No: ${receiptNo}`, START_X, bodyStartY);

// Student name and class each protected against overflow — a long
// name here previously had no width limit at all, and could run
// straight past this receipt's own border since three receipts stack
// on one page.
fitSingleLine(doc, `Student Name: ${student.name}`, START_X, bodyStartY + lineGap, WIDTH, { startSize: 9, minSize: 6.5, font: "Helvetica" });
fitSingleLine(doc, `Class: ${classId}`, START_X, bodyStartY + lineGap * 2, WIDTH, { startSize: 9, minSize: 6.5, font: "Helvetica" });

doc
  .font("Helvetica")
  .fontSize(9)
  .text(`Term: ${term}`, START_X, bodyStartY + lineGap * 3)
  .text(
    `Amount Paid: ₦${Number(amount).toLocaleString()}`,
    START_X,
    bodyStartY + lineGap * 4
  )
  .text(
    `Date: ${new Date().toLocaleDateString()}`,
    START_X,
    bodyStartY + lineGap * 5
  );

const generatedY = startY + RECEIPT_HEIGHT - 18;

doc
  .fontSize(8)
  .text(
    `Generated by ${meta.schoolName || "Assalam International Academic School"} portal on: ${new Date().toLocaleString()}`,
    START_X,
    generatedY,
    { width: WIDTH, align: "right", lineBreak: false }
  );
      receiptIndexOnPage++;
    });

    doc.end();

  } catch (err) {
    console.error("Receipt PDF error:", err);
    res.status(500).json({ error: "Failed to generate receipt" });
  }
});
// ================= SYSTEM MANAGEMENT API =================

// Get system status
app.get("/api/system/status", (req, res) => {
  res.json({
    locked: SYSTEM_LOCKED,
    reason: SYSTEM_LOCK_REASON
  });
});

// Lock system
app.post("/api/system/lock", (req, res) => {
  SYSTEM_LOCKED = true;
  SYSTEM_LOCK_REASON = req.body.reason || "System locked by administrator";
  res.json({ success: true });
});

// Unlock system — an already-logged-in admin can always unlock directly;
// anyone else needs the unlock password, if one has been set.
app.post("/api/system/unlock", async (req, res) => {
  if (!(req.session && req.session.admin)) {
    const data = readData();
    const hash = data.meta?.unlockPasswordHash;
    if (!hash) {
      return res.status(403).json({ error: "No unlock password has been set. Please log in as admin instead." });
    }
    const match = req.body.unlockPassword && (await bcrypt.compare(req.body.unlockPassword, hash));
    if (!match) {
      return res.status(401).json({ error: "Incorrect unlock password." });
    }
  }

  SYSTEM_LOCKED = false;
  SYSTEM_LOCK_REASON = "";
  res.json({ success: true });
});

// ---------------- ADMIN: CHANGE OWN LOGIN PASSWORD ----------------
app.post("/api/admin/change-password", async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: "Unauthorized" });

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Both current and new password are required." });
  }

  try {
    const data = readData();
    const admin = (data.admins || []).find(a => a.username === req.session.admin);
    if (!admin) return res.status(404).json({ error: "Admin account not found." });

    const match = await bcrypt.compare(currentPassword, admin.password);
    if (!match) return res.status(401).json({ error: "Current password is incorrect." });

    admin.password = await bcrypt.hash(String(newPassword), 10);
    await writeData(data, ['admins']);
    res.json({ success: true });
  } catch (err) {
    console.error("Admin change-password error:", err);
    res.status(500).json({ error: "Failed to change password." });
  }
});

// ---------------- ADMIN: SET / CHANGE THE UNLOCK PASSWORD ----------------
app.post("/api/admin/set-unlock-password", async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: "Unauthorized" });

  const { newUnlockPassword } = req.body;
  if (!newUnlockPassword) {
    return res.status(400).json({ error: "New unlock password is required." });
  }

  try {
    const data = readData();
    data.meta ||= {};
    data.meta.unlockPasswordHash = await bcrypt.hash(String(newUnlockPassword), 10);
    await writeData(data, ['settings']);
    res.json({ success: true });
  } catch (err) {
    console.error("Set unlock password error:", err);
    res.status(500).json({ error: "Failed to set unlock password." });
  }
});

// ======================================================
// DOWNLOAD STUDENT STATISTICS PDF (WITH SCHOOL HEADER)
// ======================================================
app.get("/api/admin/student-stats-pdf", async (req, res) => {
  try {
    const data = readData();

    const students = data.students || [];
    const classes = data.classes || [];

    const PDFDocument = require("pdfkit");

    /* ================= CONSTANTS ================= */
    const BORDER_MARGIN = 25;
    const INNER_MARGIN = BORDER_MARGIN + 15;
    const CONTENT_START_Y = 200;
    const CONTENT_WIDTH = 595 - INNER_MARGIN * 2; // A4 width

    const doc = new PDFDocument({ size: "A4", margin: 40 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "inline; filename=Student_Statistics.pdf"
    );

    doc.pipe(res);

    // data.meta.logo is a Supabase Storage URL now — resolved once,
    // up front, to a local temp file, since drawHeader() below gets
    // called multiple times (once per page) and PDFKit needs a real
    // local path or buffer, not a URL.
    const logoResolved = await resolveImageForGeneration(data.meta?.logo);
    doc.on("end", logoResolved.cleanup);

    /* ========== HEADER FUNCTION ========== */
    function drawHeader() {
      // Border
      doc.lineWidth(1).strokeColor("#000");
      doc.rect(
        BORDER_MARGIN,
        BORDER_MARGIN,
        doc.page.width - BORDER_MARGIN * 2,
        doc.page.height - BORDER_MARGIN * 2
      ).stroke();

      // Logo
      const logoPath = logoResolved.path || path.join(__dirname, "public", "logo.png");
      if (fs.existsSync(logoPath)) {
        try {
          doc.image(logoPath, doc.page.width / 2 - 20, 40, { width: 40 });
        } catch {}
      }

      // School name box
      doc.font("Helvetica-Bold").fontSize(14);
      const schoolName = data.meta?.schoolName || "ASSALAM INTERNATIONAL ACADEMIC SCHOOL GARKO";
      const boxW = Math.min(doc.widthOfString(schoolName) + 60, doc.page.width - 120);
      const boxX = (doc.page.width - boxW) / 2;
      const boxY = 90;

      doc.rect(boxX, boxY, boxW, 26).stroke();
      fitSingleLine(doc, schoolName, 0, boxY + 6, doc.page.width, { startSize: 14, minSize: 8, font: "Helvetica-Bold", align: "center" });

      // School info
      doc.font("Helvetica").fontSize(9);
      fitSingleLine(doc, `Address: ${data.meta?.address || "Behind Garko Motor Park, Opp. Tasidi Filling Station"}`, INNER_MARGIN, boxY + 36, CONTENT_WIDTH, { startSize: 9, minSize: 6.5, font: "Helvetica", align: "center" });
      fitSingleLine(doc, `Motto: ${data.meta?.motto || "Success comes after tears"}`, INNER_MARGIN, boxY + 50, CONTENT_WIDTH, { startSize: 9, minSize: 6.5, font: "Helvetica", align: "center" });
      fitSingleLine(doc, `Phone: ${data.meta?.phone || "08165789331, 08103992584, 08151015152, 07068595598"}`, INNER_MARGIN, boxY + 64, CONTENT_WIDTH, { startSize: 9, minSize: 6.5, font: "Helvetica", align: "center" });

      doc.moveTo(60, boxY + 80).lineTo(540, boxY + 80).stroke();
      doc.y = CONTENT_START_Y;
    }

    /* ========== INITIAL HEADER ========== */
    drawHeader();

    /* ========== HEADER ON EVERY PAGE ========== */
    doc.on("pageAdded", drawHeader);

    /* ========== CONTENT ================= */
    doc.font("Helvetica-Bold").fontSize(14);
    doc.text("STUDENT ENROLLMENT STATISTICS", INNER_MARGIN, doc.y, {
      width: CONTENT_WIDTH,
      align: "center"
    });

    doc.moveDown(1.5);

    doc.font("Helvetica").fontSize(11);
    doc.text(`Total Students: ${students.length}`, INNER_MARGIN);

    doc.moveDown();

    classes.forEach(cls => {
      const count = students.filter(s => s.classId === cls.id).length;
      fitSingleLine(doc, `${cls.name || cls.id}: ${count} students`, INNER_MARGIN, doc.y, CONTENT_WIDTH, { startSize: 11, minSize: 8, font: "Helvetica" });
      doc.moveDown(0.6);
    });

    doc.moveDown(2);
    doc.fontSize(9).text(
      `Generated by Assalam International Academic School portal on: ${new Date().toLocaleString()}`,
      INNER_MARGIN,
      doc.y,
      { width: CONTENT_WIDTH, align: "right" }
    );

    doc.end();
  } catch (err) {
    console.error("Student stats PDF error:", err);
    res.status(500).send("PDF generation failed");
  }
});

// ======================================================
// FEATURE REQUEST TO DEVELOPER
// ======================================================
app.post("/api/admin/feature-request", (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ success: false });
    }

    console.log("📩 FEATURE REQUEST RECEIVED:");
    console.log(message);

    // FOR NOW (FREE VERSION):
    // Just log it — later you can send email via Gmail / SMTP

    res.json({ success: true });
  } catch (err) {
    console.error("Feature request error:", err);
    res.status(500).json({ success: false });
  }
});
// ======================================================
// ADMIN: VIEW ALL DATA (READ ONLY)
// ======================================================
app.get("/api/admin/data-view", (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: "Unauthorized" });
  try {
    const data = readData();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Failed to load data" });
  }
});
// ======================================================
// ADMIN: RESET ALL DATA
// ======================================================
// ======================================================
// FACTORY RESET — wipes every piece of school data (classes,
// teachers, students, subjects, questions, results, attendance,
// generated PDFs, branding, and settings back to defaults).
//
// Marked clearly as NEW: the old route that used to sit at this URL
// had no admin authentication at all, and wrote directly to the old
// data.json file — meaning it never actually touched the real
// Postgres database this whole time. Replaced entirely with a real
// one for the new system.
//
// Deliberately preserves the admin login and unlock password, a
// factory reset should clear the school's data, not lock the person
// doing the reset out of their own software.
// ======================================================
app.post("/api/admin/factory-reset", async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: "Unauthorized" });

  const { confirmation } = req.body;
  if (confirmation !== "RESET SCHOOL DATA") {
    return res.status(400).json({ error: 'Confirmation phrase did not match exactly.' });
  }

  try {
    const data = readData();

    const keepAdmins = data.admins || [];
    const keepUnlockPasswordHash = data.meta?.unlockPasswordHash || null;

    data.classes = [];
    data.teachers = [];
    data.students = [];
    data.subjects = [];
    data.results = [];
    data.attendance = {};
    data.teacherAttendance = {};
    data.pdfs = [];
    data.admins = keepAdmins;

    data.meta = {
      schoolName: "",
      address: "",
      motto: "",
      phone: "",
      logo: null,
      signaturePrincipal: null,
      term: "",
      session: "",
      nextTermBegins: "",
      portalToggles: { teacherPortal: true, examPortal: true, parentPortal: true, attendancePortal: true },
      portalPasswords: { teacherPortal: "portalteach2025", examPortal: "portalexam2025", reportPortal: "portalreport2025" },
      testToggles: { test1: true, test2: true, test3: true, exam: true },
      unlockPasswordHash: keepUnlockPasswordHash
    };

    await writeData(data);
    res.json({ success: true });
  } catch (err) {
    console.error("Factory reset error:", err);
    res.status(500).json({ error: "Factory reset failed" });
  }
});

app.post("/api/admin/school", async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: "Unauthorized" });

  const data = readData();
  data.meta = data.meta || {};
  const { name, address, phone, motto, term, session, nextTermBegins } = req.body;
  if (typeof name !== "undefined") data.meta.schoolName = name;
  if (typeof address !== "undefined") data.meta.address = address;
  if (typeof phone !== "undefined") data.meta.phone = phone;
  if (typeof motto !== "undefined") data.meta.motto = motto;
  if (typeof term !== "undefined") data.meta.term = term;
  if (typeof session !== "undefined") data.meta.session = session;
  if (typeof nextTermBegins !== "undefined") data.meta.nextTermBegins = nextTermBegins;

  try {
    await writeData(data, ['settings']);
    res.json({ success: true });
  } catch (err) {
    console.error("Save school info error:", err);
    res.status(500).json({ error: "Failed to save school info" });
  }
});
// ---------------- RESULT ANALYTICS ----------------
app.get("/api/admin/results/analytics", (req, res) => {
  if (!req.session || !req.session.admin) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { classId, mode } = req.query;
  if (!classId || !mode) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  const data = readData();
  const results = Array.isArray(data.results) ? data.results : [];

  // 🔎 Filter strictly by class
  const filtered = results.filter(r => r.classId === classId);

  const output = {};

  if (mode === "students") {
    filtered.forEach(r => {
      if (!r.studentId) return;

      output[r.studentId] ??= { total: 0, count: 0 };
      output[r.studentId].total += Number(r.total) || 0;
      output[r.studentId].count++;
    });
  }

  if (mode === "subjects") {
    filtered.forEach(r => {
      const subject =
        typeof r.subject === "string"
          ? r.subject
          : r.subject?.id || "UNKNOWN";

      output[subject] ??= { total: 0, count: 0 };
      output[subject].total += Number(r.total) || 0;
      output[subject].count++;
    });
  }

  // 🧮 Compute averages
  const result = {};
  Object.entries(output).forEach(([k, v]) => {
    result[k] = Math.round(v.total / Math.max(v.count, 1));
  });

  res.json({ data: result });
});
// ---------------- HELPER: BUILD STUDENT MAP ----------------
function buildStudentStats(results, students, classId) {
  const map = {};

  results
    .filter(r => r.classId === classId)
    .forEach(r => {
      map[r.studentId] ??= { total: 0, count: 0 };
      map[r.studentId].total += Number(r.total) || 0;
      map[r.studentId].count++;
    });

  return Object.entries(map).map(([studentId, v]) => {
    const student = (students || []).find(s => s.id === studentId) || {};
    const avg = v.total / Math.max(v.count, 1);

    return {
      studentId,
      name: student.name || "Unknown",
      avg: Math.round(avg)
    };
  });
}

// ---------------- CLASS RANKING ----------------
app.get("/api/admin/results/ranking", (req, res) => {
  if (!req.session?.admin) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { classId } = req.query;
  if (!classId) {
    return res.status(400).json({ error: "Missing classId" });
  }

  const data = readData();
  const results = Array.isArray(data.results) ? data.results : [];
  const students = Array.isArray(data.students) ? data.students : [];

  let ranking = buildStudentStats(results, students, classId)
    .sort((a, b) => b.avg - a.avg)
    .map((s, i) => ({
      ...s,
      position: i + 1
    }));

  res.json({ ranking });
});

// ---------------- TOP 5 ----------------
app.get("/api/admin/results/top5", (req, res) => {
  if (!req.session?.admin) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { classId } = req.query;
  if (!classId) return res.status(400).json({ error: "Missing classId" });

  const data = readData();
  const results = Array.isArray(data.results) ? data.results : [];
  const students = Array.isArray(data.students) ? data.students : [];

  const top5 = buildStudentStats(results, students, classId)
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 5);

  res.json({ top5 });
});

// ---------------- PASS / FAIL (FIXED) ----------------
app.get("/api/admin/results/passfail", (req, res) => {
  if (!req.session?.admin) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { classId } = req.query;
  if (!classId) return res.status(400).json({ error: "Missing classId" });

  const data = readData();
  const results = Array.isArray(data.results) ? data.results : [];
  const students = Array.isArray(data.students) ? data.students : [];

  const stats = buildStudentStats(results, students, classId);

  let pass = 0;
  let fail = 0;

  stats.forEach(s => {
    if (s.avg >= 50) pass++;
    else fail++;
  });

  res.json({
    pass,
    fail,
    total: stats.length
  });
});

// ---------------- EXTRA: CLASS SUMMARY ----------------
app.get("/api/admin/results/summary", (req, res) => {
  if (!req.session?.admin) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { classId } = req.query;
  if (!classId) return res.status(400).json({ error: "Missing classId" });

  const data = readData();
  const results = Array.isArray(data.results) ? data.results : [];
  const students = Array.isArray(data.students) ? data.students : [];

  const stats = buildStudentStats(results, students, classId);

  if (!stats.length) {
    return res.json({ avg: 0, highest: 0, lowest: 0 });
  }

  const avgs = stats.map(s => s.avg);

  res.json({
    avg: Math.round(avgs.reduce((a, b) => a + b, 0) / avgs.length),
    highest: Math.max(...avgs),
    lowest: Math.min(...avgs)
  });
});

// ---------------- TEACHER REPORT (Single Student) ----------------
app.put("/api/teacher/student/:studentId/report", async (req, res) => {
  try {
    const { studentId } = req.params;
    const { reports } = req.body;
    if (!reports) return res.status(400).json({ error: "Missing report data" });

    const data = readData();

    // Find student
    const student = (data.students || []).find(s => s.id === studentId);
    if (!student) return res.status(404).json({ error: "Student not found" });

    // Check class
    const classEntry = data.classes?.find(c => c.id === student.classId);
    if (!classEntry) return res.status(400).json({ error: "Class info missing" });

    // Build subjectId -> subjectName map from the real subjects for this class
    const resolvedSubjects = getClassSubjectsResolved(data, student.classId);
    const subjectNameMap = {};
    resolvedSubjects.forEach(s => { subjectNameMap[s.id] = s.name; });

    if (classEntry.locked) {
      return res.status(403).json({ error: "Class is locked. Contact admin." });
    }

    if (!data.results) data.results = [];

    // Merge logic: only for subjects in this class
    const validSubjectIds = resolvedSubjects.map(s => s.id);

  for (const [subjectId, vals] of Object.entries(reports)) {
  if (!validSubjectIds.includes(subjectId)) continue;


      const existing = data.results.find(
        r => r.studentId === studentId && r.subject === subjectId
      );

      if (existing) {
        // Merge with CBT + teacher inputs — each field is validated
        // before being accepted; a garbage or out-of-range value
        // (this route previously accepted anything at all here) is
        // rejected and the previous value is kept instead, rather
        // than silently saving something like a stray timestamp as
        // if it were a real score.
        existing.test1 = sanitizeIncomingScore("test1", vals.test1, existing.test1 ?? 0);
        existing.test2 = sanitizeIncomingScore("test2", vals.test2, existing.test2 ?? 0);
        existing.test3 = sanitizeIncomingScore("test3", vals.test3, existing.test3 ?? 0);
        existing.exam  = sanitizeIncomingScore("exam", vals.exam, existing.exam);

        existing.total =
          (existing.test1 || 0) +
          (existing.test2 || 0) +
          (existing.test3 || 0) +
          (existing.exam  || 0);

        existing.updatedAt = new Date().toISOString();
      } else {
        const t1 = sanitizeIncomingScore("test1", vals.test1, 0);
        const t2 = sanitizeIncomingScore("test2", vals.test2, 0);
        const t3 = sanitizeIncomingScore("test3", vals.test3, 0);
        const ex = sanitizeIncomingScore("exam", vals.exam, undefined);

        data.results.push({
          studentId,
          classId: student.classId,
          subject: subjectId,
          test1: t1,
          test2: t2,
          test3: t3,
          exam: ex,
          total: t1 + t2 + t3 + (ex || 0),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    await writeData(data, ['results']);

    // This route can touch several subjects and both categories
    // (test1-3 and exam) in one call, so regenerate both parent-facing
    // summary PDFs to stay consistent, rather than trying to work out
    // exactly which category actually changed.
    try {
      await regenerateConsolidatedPDF(studentId, 'Tests');
      await regenerateConsolidatedPDF(studentId, 'Exam');
    } catch (pdfErr) {
      console.error('regenerateConsolidatedPDF error:', pdfErr);
    }

    // ---------- ENSURE SUBJECTS ARE RESOLVABLE FOR PDF ----------
    const studentResults = (data.results || [])
      .filter(r => r.studentId === studentId);

    studentResults.forEach(r => {
      if (!subjectNameMap[r.subject]) {
        console.warn("⚠️ Unresolved subject:", r.subject);
      }
    });
    res.json({ success: true, message: "Report updated successfully." });
  } catch (err) {
    console.error("PUT /api/teacher/student/:studentId/report error:", err);
    res.status(500).json({ error: "Internal server error", details: err.message });
  }
});

// ---------------- DELETE REPORT + CLEAN OLD SCORES ----------------
// ---------------- ADMIN: DELETE ALL REPORT/RESULT DATA AT ONCE ----------------
app.delete("/api/admin/reports/all", async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: "Unauthorized" });

  try {
    const data = readData();
    const countBefore = (data.results || []).length;

    // Every report sheet, consolidated summary, and exam/test receipt
    // this school has ever generated lives in the Supabase Storage
    // bucket, not on local disk. Previously this route only cleared
    // the `results` table and a local "reports" folder left over from
    // before the Storage migration (which doesn't exist on Render any
    // more, so that part silently did nothing) — meaning every one of
    // these files stayed in the bucket forever, orphaned, even after
    // "clearing all report data." deleteFromStorage() already existed
    // for exactly this but was never actually called anywhere in the
    // app. This now genuinely removes each file before dropping its
    // database row. A failed individual delete is logged and skipped
    // rather than aborting the whole operation — deleteFromStorage()
    // already swallows its own errors for this reason.
    const reportPdfTypes = ['report_sheet', 'tests_summary', 'exam_summary', 'exam_result'];
    const pdfsToDelete = (data.pdfs || []).filter(p => reportPdfTypes.includes(p.type));

    await Promise.all(
      pdfsToDelete.map((p) => {
        const storagePath = storagePathFromUrl(p.filePath);
        return storagePath ? deleteFromStorage(storagePath) : Promise.resolve();
      })
    );

    data.results = [];
    data.pdfs = (data.pdfs || []).filter(p => !reportPdfTypes.includes(p.type));
    await writeData(data, ['results', 'pdfs']);

    // Old local-disk cleanup kept as a harmless defensive fallback —
    // does nothing on Render today, but costs nothing to leave in.
    const reportDir = path.join(__dirname, "reports");
    let deletedFiles = 0;
    if (fs.existsSync(reportDir)) {
      fs.readdirSync(reportDir).forEach((file) => {
        if (file.endsWith(".pdf")) {
          fs.unlinkSync(path.join(reportDir, file));
          deletedFiles++;
        }
      });
    }

    res.json({
      success: true,
      resultsCleared: countBefore,
      pdfsDeletedFromStorage: pdfsToDelete.length,
      filesDeleted: deletedFiles
    });
  } catch (err) {
    console.error("Delete all reports error:", err);
    res.status(500).json({ error: "Failed to delete all report data" });
  }
});

app.delete("/api/teacher/student/:studentId/report", async (req, res) => {
  try {
    const { studentId } = req.params;
    const data = readData();

    // Same fix as /api/admin/reports/all above — this student's report
    // PDFs actually live in Supabase Storage, not the local disk folder
    // this used to (and only) clean up, which meant every one of them
    // stayed in the bucket forever after being "cleaned."
    const reportPdfTypes = ['report_sheet', 'tests_summary', 'exam_summary', 'exam_result'];
    const pdfsToDelete = (data.pdfs || []).filter(
      (p) => p.studentId === studentId && reportPdfTypes.includes(p.type)
    );

    await Promise.all(
      pdfsToDelete.map((p) => {
        const storagePath = storagePathFromUrl(p.filePath);
        return storagePath ? deleteFromStorage(storagePath) : Promise.resolve();
      })
    );

    // Old local-disk cleanup kept as a harmless defensive fallback —
    // does nothing on Render today, but costs nothing to leave in.
    const reportDir = path.join(__dirname, "reports");
    const deleted = [];
    if (fs.existsSync(reportDir)) {
      fs.readdirSync(reportDir).forEach((file) => {
        if (file.startsWith(studentId) && file.endsWith(".pdf")) {
          fs.unlinkSync(path.join(reportDir, file));
          deleted.push(file);
        }
      });
    }

    // Clean all results and pdfs records for this student
    data.results = (data.results || []).filter((r) => r.studentId !== studentId);
    data.pdfs = (data.pdfs || []).filter(
      (p) => !(p.studentId === studentId && reportPdfTypes.includes(p.type))
    );
    await writeData(data, ['results', 'pdfs']);

    console.log(`🧹 Cleaned old test/exam records for student ${studentId}`);
    res.json({ success: true, deleted });
  } catch (err) {
    console.error("Error deleting report:", err);
    res.status(500).json({ error: "Failed to delete report", details: err.message });
  }
});

// ---------------- GET CLASS INFO ----------------
app.get("/api/classes/:classId", (req, res) => {
  const data = readData();
  const classId = req.params.classId;

  const found = (data.classes || []).find(
    c => c.id.toUpperCase() === classId.toUpperCase()
  );

  if (!found) {
    return res.status(404).json({ error: "Class not found" });
  }

  // Subjects belong to a class via subject.classId — derive the list
  // from there rather than a separate (and easily out-of-sync) array
  // on the class itself.
  const subjectIds = (data.subjects || [])
    .filter(s => s.classId.toUpperCase() === classId.toUpperCase())
    .map(s => s.id);

  res.json({
    id: found.id,
    name: found.name,
    locked: !!found.locked,
    subjects: subjectIds
  });
});

// ---------------- TEACHER: GET A STUDENT'S CURRENT RESULTS ----------------
app.get("/api/teacher/student/:studentId/results", (req, res) => {
  if (!req.session.portalTeacher && !req.session.admin) {
    return res.status(401).json({ error: "Login required" });
  }
  const data = readData();
  const results = (data.results || []).filter(r => r.studentId === req.params.studentId);
  res.json({ results });
});

// ======================================================
// NEW SCALABLE SCORE ENTRY — one subject, every student at once.
// Marked clearly since this is new (not present in the old system):
// added to support the redesigned Teacher Portal score-entry grid,
// which replaces opening one student at a time.
// ======================================================

// Subjects for a class, WITH real names (the older /api/classes/:id
// route only returns bare subject IDs, not enough for a nice picker).
app.get("/api/teacher/class/:classId/subjects", (req, res) => {
  if (!req.session.portalTeacher)
    return res.status(401).json({ error: "Teacher login required" });

  const { classId } = req.params;
  const data = readData();
  const subjects = getClassSubjectsResolved(data, classId).map(s => ({ id: s.id, name: s.name }));
  res.json({ subjects });
});

// Every student in the class, with their current scores for ONE
// subject. Missing fields come back as `null` explicitly (never
// omitted, never silently 0) — JSON drops `undefined` keys entirely
// when sent over the wire, so `null` is the only value that reliably
// tells the frontend "this was never entered" versus "entered as 0".
app.get("/api/teacher/class/:classId/subject/:subjectId/scores", (req, res) => {
  if (!req.session.portalTeacher)
    return res.status(401).json({ error: "Teacher login required" });

  // A teacher must have actually authenticated into THIS class (not
  // just the teacher portal in general) before seeing its scores —
  // tighter than the older per-student route, which never checked this.
  if (req.session.teacherClass !== req.params.classId)
    return res.status(403).json({ error: "You haven't unlocked this class" });

  const { classId, subjectId } = req.params;
  const data = readData();

  const subj = (data.subjects || []).find(s => s.id === subjectId && s.classId === classId);
  if (!subj) return res.status(404).json({ error: "Subject not found for this class" });

  const students = (data.students || [])
    .filter(s => s.classId === classId)
    .map(s => {
      const r = (data.results || []).find(x => x.studentId === s.id && x.subject === subjectId);
      return {
        id: s.id,
        name: s.name,
        test1: r && r.test1 !== undefined ? r.test1 : null,
        test2: r && r.test2 !== undefined ? r.test2 : null,
        test3: r && r.test3 !== undefined ? r.test3 : null,
        exam: r && r.exam !== undefined ? r.exam : null,
      };
    });

  res.json({ students });
});

// Saves exactly ONE cell — deliberately separate from the older
// per-student /report route, which also regenerates a PDF as a side
// effect. Doing that on every single keystroke across a large class
// would be slow and wasteful; PDF generation stays its own explicit
// action on the admin Report Sheets page.
app.put(
  "/api/teacher/class/:classId/subject/:subjectId/student/:studentId/score",
  async (req, res) => {
    if (!req.session.portalTeacher)
      return res.status(401).json({ error: "Teacher login required" });
    if (req.session.teacherClass !== req.params.classId)
      return res.status(403).json({ error: "You haven't unlocked this class" });

    const { classId, subjectId, studentId } = req.params;
    const { field, value } = req.body;

    if (!["test1", "test2", "test3", "exam"].includes(field)) {
      return res.status(400).json({ error: "Invalid field" });
    }

    if (value !== null && value !== "" && value !== undefined) {
      const num = Number(value);
      const cap = SCORE_CAPS[field];
      if (Number.isNaN(num) || num < 0 || num > cap) {
        return res.status(400).json({ error: `${field} must be between 0 and ${cap}` });
      }
    }

    try {
      // updateData() reads the CURRENT class/student list to validate
      // against, but the actual mutation of results (the part that
      // must never race against another concurrent save) happens
      // inside the mutator below, guaranteed to run against whatever
      // the queue's latest state actually is at that moment.
      const snapshot = readData();
      const classEntry = (snapshot.classes || []).find(c => c.id === classId);
      if (classEntry?.locked) {
        return res.status(403).json({ error: "This class is locked. Contact admin." });
      }
      const student = (snapshot.students || []).find(s => s.id === studentId && s.classId === classId);
      if (!student) return res.status(404).json({ error: "Student not found in this class" });

      let savedValue = null;

      await updateData((data) => {
        if (!data.results) data.results = [];
        let existing = data.results.find(r => r.studentId === studentId && r.subject === subjectId);
        if (!existing) {
          existing = { id: `res_${Date.now()}`, studentId, classId, subject: subjectId };
          data.results.push(existing);
        }

        // A blank/null value genuinely clears the field back to
        // "missing" — a teacher fixing a mistaken entry should be
        // able to do that, not get stuck at a forced 0.
        if (value === null || value === "" || value === undefined) {
          existing[field] = undefined;
        } else {
          existing[field] = Number(value);
        }

        existing.total =
          (existing.test1 || 0) + (existing.test2 || 0) + (existing.test3 || 0) + (existing.exam || 0);
        existing.updatedAt = new Date().toISOString();
        savedValue = existing[field] ?? null;
      }, ['results']); // only the results table needs re-saving here

      // Keep the parent-facing summary PDF in sync with manual edits
      // too — a teacher fixing a score here should update what a
      // parent sees, not just CBT submissions. Deliberately NOT
      // awaited: the teacher's save response comes back immediately,
      // and the PDF regenerates in the background a moment later. The
      // score itself is already safely committed above by this point
      // either way, so there's nothing to lose by not waiting on this.
      regenerateConsolidatedPDF(studentId, field === 'exam' ? 'Exam' : 'Tests').catch((pdfErr) => {
        console.error('regenerateConsolidatedPDF error:', pdfErr);
      });

      res.json({ success: true, value: savedValue });
    } catch (err) {
      console.error("Score save error:", err);
      res.status(500).json({ error: "Failed to save score" });
    }
  }
);

// ---------------- TEACHER: GENERATE ALL REPORTS IN A CLASS ----------------
app.get(
  "/api/teacher/class/:classId/reports",
  reportGuard,
  async (req, res) => {


  try {
    const { classId } = req.params;
    const { studentId } = req.query; // optional — generate for just one student instead of the whole class
    // Was reading the old data.json file directly, disconnected from
    // the real Postgres-backed data since the migration — meaning
    // this specific report generator could have been silently working
    // from stale student/result data this whole time.
    const data = readData();

    // Kept unfiltered — ranking/position must always be computed
    // against every student in the class, even when only generating
    // one student's report, otherwise that one student would always
    // show up as "1st" regardless of their real position.
    const allStudentsInClass = (data.students || []).filter(s => s.classId === classId);
    if (!allStudentsInClass.length) {
      return res.status(404).json({ error: "No students found in this class." });
    }

    // This is what actually gets generated — the full class by
    // default, or just one student when a studentId is specified.
    let students = allStudentsInClass;
    if (studentId) {
      students = allStudentsInClass.filter(s => s.id === studentId);
      if (!students.length) {
        return res.status(404).json({ error: "That student wasn't found in this class." });
      }
    }

    // =========================
    // RESOLVE CLASS SUBJECTS (SINGLE SOURCE OF TRUTH)
    // =========================
    const resolvedSubjects = getClassSubjectsResolved(data, classId);
  console.log("📚 RESOLVED SUBJECTS:", resolvedSubjects);
  if (!resolvedSubjects.length) {
      return res.status(404).json({ error: "No subjects found for this class." });
    }

    const subjectIdToName = {};
    resolvedSubjects.forEach(s => {
      subjectIdToName[s.id] = s.name;
    });

    const subjectIds = resolvedSubjects.map(s => s.id);

    // =========================
    // CALCULATE AVERAGES (SAME LOGIC AS CLASS REPORT)
    // =========================
    const averages = allStudentsInClass.map(s => {
      const results = (data.results || []).filter(
        r => r.studentId === s.id && subjectIds.includes(r.subject)
      );

      const total = results.reduce(
        (a, r) =>
          a +
          (r.test1 || 0) +
          (r.test2 || 0) +
          (r.test3 || 0) +
          (r.exam || 0),
        0
      );

      const avg = results.length ? total / results.length : 0;
      return { id: s.id, avg };
    });

    averages.sort((a, b) => b.avg - a.avg);

    const suffix = (n) => {
      if (n % 10 === 1 && n % 100 !== 11) return `${n}st`;
      if (n % 10 === 2 && n % 100 !== 12) return `${n}nd`;
      if (n % 10 === 3 && n % 100 !== 13) return `${n}rd`;
      return `${n}th`;
    };

    // =========================
    // META
    // =========================
    const metaResp = await fetch(`http://localhost:${PORT}/api/meta`);
    const metaJson = await metaResp.json();
    const baseMeta = metaJson.meta || {};
    baseMeta.totalStudents = allStudentsInClass.length;

    // The old check here looked for a local disk file
    // (public/uploads/teacher_signature.png) that migration to Supabase
    // Storage means never exists any more, and even when it did it set
    // a field name (teacherSignaturePath) the PDF generator never
    // actually reads (it reads teacherSignature). Net effect: the
    // teacher's signature was never being passed into report
    // generation at all. The real value lives on the class record
    // itself (classEntry.teacherSignature — a Supabase Storage URL set
    // when the teacher uploads their signature), so it's looked up
    // there and merged into baseMeta before withResolvedImages()
    // downloads it to a local temp file below.
    const classEntryForSig = (data.classes || []).find(c => c.id === classId);
    baseMeta.teacherSignature = classEntryForSig?.teacherSignature || null;

    const timestamp = new Date().toISOString().replace(/[:T]/g, "-").split(".")[0];
    // Reports are generated straight to Supabase Storage now (see the
    // loop below) — no local batch folder needed any more.

    // baseMeta.logo is a Supabase Storage URL now — resolved once,
    // up front (it's the same logo for every student in this batch),
    // to a local temp file, since generateReportPDF needs a real
    // local path or buffer, not a URL. Cleaned up once the whole
    // batch is done, after the loop below.
    const logoResolved = await withResolvedImages(baseMeta);

    const generated = [];
    const reportSheetEntries = []; // collected here, saved once in one batch update below

    try {
      // =========================
      // GENERATE PER-STUDENT REPORTS
      // =========================
      for (let i = 0; i < averages.length; i++) {
        const { id } = averages[i];
        const student = students.find(s => s.id === id);
        if (!student) continue; // not one of the students we're actually generating for this run
        const reportData = {};

       (data.results || [])
    .filter(r => r.studentId === id)
    .forEach(r => {

      let subjectId = null;

      // 🔹 Normalize subject field (ALL historical formats)
      if (typeof r.subject === "string") {
        subjectId = r.subject.trim().toUpperCase();
      } else if (typeof r.subject === "object" && r.subject?.id) {
        subjectId = String(r.subject.id).trim().toUpperCase();
      }

      // 🔹 Resolve name
      const subjectName = subjectIdToName[subjectId];
      if (!subjectName) return;

      reportData[subjectName] = {
        test1: r.test1 || 0,
        test2: r.test2 || 0,
        test3: r.test3 || 0,
        exam: r.exam || 0
      };
    });


        const meta = { ...logoResolved.meta, position: suffix(i + 1) };
        // Generated to a temp file first (PDFKit needs a writable
        // stream), then uploaded to Supabase Storage and the temp copy
        // cleaned up — nothing is left behind on local disk for a
        // redeploy or restart to lose.
        const localPath = tempPdfPath(`${id}_report.pdf`);

        await new Promise((resolve, reject) => {
          generateReportPDF(meta, student, reportData, localPath, (err) => {
            if (err) return reject(err);
            resolve();
          });
        });

        const relPath = await uploadLocalFileAndCleanup(localPath, `reports/${classId}/${id}_report.pdf`);
        generated.push(relPath);
        reportSheetEntries.push({ studentId: id, classId, filePath: relPath });
      }
    } finally {
      // Guaranteed to run even if generation fails partway through
      // for one student — otherwise a single bad record could leave
      // the resolved logo's temp file behind indefinitely.
      logoResolved.cleanup();
    }

    if (reportSheetEntries.length) {
      // One "report_sheet" entry per student, overwriting whatever was
      // there before — a parent should always see the CURRENT report,
      // not every batch ever generated for their child.
      await updateData((liveData) => {
        if (!liveData.pdfs) liveData.pdfs = [];
        reportSheetEntries.forEach(({ studentId, classId, filePath }) => {
          const existing = liveData.pdfs.find(p => p.studentId === studentId && p.type === 'report_sheet');
          if (existing) {
            existing.filePath = filePath;
            existing.timestamp = new Date().toISOString();
          } else {
            liveData.pdfs.push({
              id: `pdf_report_sheet_${studentId}`,
              type: 'report_sheet',
              studentId,
              classId,
              filePath,
              timestamp: new Date().toISOString(),
            });
          }
        });
      }, ['pdfs']);
    }

    console.log(`✅ Generated ${generated.length} reports for class ${classId}`);
    res.json({
      success: true,
      reports: generated,
      count: generated.length
    });

  } catch (err) {
    console.error("Bulk report generation error:", err);
    res.status(500).json({
      error: "Internal server error during bulk report generation."
    });
  }
});


// ============================================================================
// GENERATE ONE SINGLE PDF FOR A WHOLE CLASS (ALL STUDENTS + SUMMARY PAGE)
// ============================================================================
//
// The combined class report is a fully regenerable artifact — every value in
// it is recomputed from Postgres on each request, and nothing ever fetches an
// old copy back. So it is no longer written to Supabase Storage at all. This
// route now just (a) fires the background per-student report-sheet sync (those
// DO persist, because parents fetch them later) and (b) hands the frontend a
// URL to a fresh-stream endpoint. The frontend contract is unchanged: it still
// receives { success, file } and still does window.open(file).
//
// Shared calculation lives in buildCombinedReportContext() below so this route
// and the stream route can never drift apart.
app.get(
  "/api/teacher/class/:classId/combined-report",
  reportGuard,
  async (req, res) => {

  try {
    const { classId } = req.params;
    const data = readData();

    // Validate up front so the frontend still gets a clean 404/JSON error
    // before we ever hand back a stream URL that would just fail later.
    const ctx = buildCombinedReportContext(data, classId);
    if (ctx.error) {
      return res.status(ctx.status).json({ error: ctx.error });
    }

    // Per-student parent-facing report sheets still persist — this calls the
    // individual-reports route, exactly as before. Runs in the background; the
    // admin doesn't wait on it before getting the combined-report URL back.
    fetch(`http://localhost:${PORT}/api/teacher/class/${encodeURIComponent(classId)}/reports`).catch((syncErr) => {
      console.error('Combined report → individual parent-portal sync error:', syncErr);
    });

    // No upload, no pdfs row. The file is regenerated on demand by the stream
    // route below whenever it's opened.
    res.json({
      success: true,
      file: `/api/teacher/class/${encodeURIComponent(classId)}/combined-report/stream`
    });

  } catch (err) {
    console.error("Combined report error:", err);
    res.status(500).json({ error: "Server error." });
  }
});


// Streams a freshly generated combined class report straight to the browser.
// Nothing is written to Supabase Storage and no pdfs row is created — the temp
// file is piped to the response and deleted afterward, whether the pipe
// succeeds or fails.
app.get(
  "/api/teacher/class/:classId/combined-report/stream",
  reportGuard,
  async (req, res) => {

  try {
    const { classId } = req.params;
    const data = readData();

    const ctx = buildCombinedReportContext(data, classId);
    if (ctx.error) {
      return res.status(ctx.status).json({ error: ctx.error });
    }
    const { students, subjects, meta } = ctx;

    const localPath = tempPdfPath(`Class_${classId}_FULL_REPORT.pdf`);
    const logoResolved = await withResolvedImages(meta);

    generateClassReportPDF(
      logoResolved.meta,
      students,
      data.results || [],
      subjects,
      localPath,
      (err) => {
        logoResolved.cleanup();

        if (err) {
          console.error("PDF generation error:", err);
          if (!res.headersSent) res.status(500).json({ error: "PDF generation failed." });
          fs.unlink(localPath, () => {});
          return;
        }

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `inline; filename="Class_${classId}_FULL_REPORT.pdf"`
        );

        const stream = fs.createReadStream(localPath);
        stream.on("error", (streamErr) => {
          console.error("Combined report stream error:", streamErr);
          if (!res.headersSent) res.status(500).json({ error: "Failed to stream report." });
          fs.unlink(localPath, () => {});
        });
        // Delete the temp file once the response is fully sent (or the client
        // disconnects) — best-effort, never blocks.
        res.on("close", () => fs.unlink(localPath, () => {}));
        stream.pipe(res);
      }
    );

  } catch (err) {
    console.error("Combined report stream error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Server error." });
  }
});


// Shared calculation for both combined-report routes above. Returns either
// { error, status } on a validation failure, or { students, subjects, meta }
// ready for generateClassReportPDF. Kept as one function so the JSON route and
// the stream route always compute identical totals, ranks, and positions.
function buildCombinedReportContext(data, classId) {
  const students = (data.students || []).filter(s => s.classId === classId);
  if (!students.length) {
    return { error: "No students found.", status: 404 };
  }

  const classEntry = (data.classes || []).find(c => c.id === classId);
  if (!classEntry) {
    return { error: "Class not found.", status: 404 };
  }

  // ✅ ALWAYS resolve full subject list
  const subjects = getClassSubjectsResolved(data, classEntry.id);
  if (!subjects.length) {
    return { error: "No subjects configured for this class yet.", status: 404 };
  }
  const subjectIds = subjects.map(s => s.id);
  const subjectCount = subjects.length || 1; // prevent division by zero

  // =========================
  // CALCULATE TOTALS & RANK (MATCH REPORT SHEET LOGIC)
  // =========================
  students.forEach(s => {

    let totalScore = 0;

    subjects.forEach(sub => {
      const r = (data.results || []).find(
        x => x.studentId === s.id && x.subject === sub.id
      ) || {};

      totalScore +=
        (r.test1 || 0) +
        (r.test2 || 0) +
        (r.test3 || 0) +
        (r.exam  || 0);
    });

    s.totalScore = totalScore;
    s.average = totalScore / subjectCount; // ✅ SAME AS REPORT SHEET
  });

  students.sort((a, b) => b.average - a.average);

  const suffix = n => {
    if (n % 10 === 1 && n % 100 !== 11) return "st";
    if (n % 10 === 2 && n % 100 !== 12) return "nd";
    if (n % 10 === 3 && n % 100 !== 13) return "rd";
    return "th";
  };

  students.forEach((s, i) => {
    s.positionIndex = i + 1;
    s.position = `${i + 1}${suffix(i + 1)}`;
  });

  // =========================
  // META
  // =========================
  const meta = {
    ...(data.meta || {}), // real school branding: address, motto, phone, logo, signaturePrincipal, nextTermBegins, etc.
    schoolName: data.meta?.schoolName || "ASSALAM INTERNATIONAL ACADEMIC SCHOOL",
    className: classId,
    term: data.meta?.term || "Third Term",
    session: data.meta?.session || "",
    totalStudents: students.length,
    // classEntry.teacherSignature is a Supabase Storage URL set when the
    // teacher uploads their signature — data.meta never carries this
    // (it's a per-class value, not a global setting), so without this
    // it's silently missing from every combined class report, the same
    // bug fixed for the individual per-student reports below.
    teacherSignature: classEntry.teacherSignature || null
  };

  return { students, subjects, meta };
}


// ---------------- SIGNATURE UPLOAD ROUTES ----------------

// ✅ Upload teacher signature (Class-specific)
app.post("/api/upload/teacher-signature/:classId", upload.single("signature"), async (req, res) => {
  try {
    const { classId } = req.params;
    // This route had no auth check at all before — anyone who guessed
    // a classId could overwrite that class's signature. Now requires
    // the teacher to have actually unlocked this specific class.
    if (!req.session.portalTeacher)
      return res.status(401).json({ error: "Teacher login required" });
    if (req.session.teacherClass !== classId)
      return res.status(403).json({ error: "You haven't unlocked this class" });

    if (!classId) return res.status(400).json({ error: "Missing classId parameter" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // Uploaded to Supabase Storage — survives a redeploy or restart,
    // which local disk never did.
    const rel = await uploadBuffer(`signatures/${classId}_signature.png`, req.file.buffer, req.file.mimetype);

    const data = readData();
    if (!data.classes) data.classes = [];

    let cls = data.classes.find(c => c.id === classId);
    if (cls) {
      cls.teacherSignature = rel;
    } else {
      data.classes.push({ id: classId, name: classId, teacherSignature: rel });
    }

    await writeData(data, ['classes']);
    res.json({
      success: true,
      file: rel,
      message: `Signature uploaded and saved for class ${classId}.`
    });

  } catch (err) {
    console.error("Teacher signature upload error:", err);
    res.status(500).json({ error: "Upload failed", details: err.message });
  }
});

// ✅ Upload principal signature (Global)
app.post("/api/upload/principal-signature", upload.single("signature"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // Uploaded to Supabase Storage — survives a redeploy or restart,
    // which local disk never did.
    const publicUrl = await uploadBuffer("branding/principal_signature.png", req.file.buffer, req.file.mimetype);

    await updateData((data) => {
      data.meta = data.meta || {};
      data.meta.signaturePrincipal = publicUrl;
    }, ['settings']);

    res.json({
      success: true,
      file: publicUrl,
      message: "Principal signature uploaded successfully.",
    });

  } catch (err) {
    console.error("Principal signature upload error:", err);
    res.status(500).json({ error: "Upload failed", details: err.message });
  }
});

// ---------------- EXAM ----------------
// New: subjects for a class, with real names, scoped to the exam
// portal's own session — the existing subjects-with-names route
// requires a teacher-portal session, which a student sitting an exam
// never has.
app.get('/api/exam/class/:classId/subjects', (req, res) => {
  if (!req.session.portalExam)
    return res.status(401).json({ error: 'Portal exam access required' });

  const { classId } = req.params;
  const data = readData();
  const subjects = getClassSubjectsResolved(data, classId).map(s => ({ id: s.id, name: s.name }));
  res.json({ subjects });
});

app.get('/api/exam/questions', (req, res) => {
  if (!req.session.portalExam)
    return res.status(401).json({ error: 'Portal exam access required' });

  const { subjectId, type, classId } = req.query;
  const data = readData();

  // enforce test toggles
  if (data.meta?.testToggles && data.meta.testToggles[type] === false) {
    return res.status(403).json({ error: `${type} is disabled by admin` });
  }

  const subj = (data.subjects || []).find(
    (s) => s.id === subjectId && s.classId === classId
  );
  if (!subj)
    return res.status(404).json({ error: 'Subject not found for this class' });

  // Provide both questions and time limit for the requested test type
  const items = subj.questions[type] || [];
  const timeForType =
    subj.timeLimits && typeof subj.timeLimits[type] !== 'undefined'
      ? subj.timeLimits[type]
      : data.meta?.defaultTimeLimits?.[type] ?? (type === 'exam' ? 60 : 30);

  // return questions and duration (minutes)
  res.json({ items, duration: timeForType });
});

// ---------------- EXAM ATTEMPT TRACKING ----------------
function preventMultipleSubmissions(req, res, next) {
  if (!req.session.portalExam) {
    return res.status(401).json({ error: 'Portal exam access required' });
  }

  const { studentId, type, subjectId, classId } = req.body || req.query;

  if (!studentId || !type || !subjectId || !classId) {
    return res.status(400).json({ error: 'Missing exam attempt parameters' });
  }

  const data = readData();
  const results = Array.isArray(data.results) ? data.results : [];

  const normalizedSubjectId = String(subjectId).trim().toUpperCase();

  // 🔑 FIND ONLY VALID, CURRENT RESULTS
  const existing = results.find(r => {
    if (r.studentId !== studentId) return false;
    if (r.classId !== classId) return false;

    // Normalize stored subject (id OR name OR object)
    const stored =
      typeof r.subject === 'string'
        ? r.subject.trim().toUpperCase()
        : String(r.subject?.id || '').trim().toUpperCase();

    // 🔥 KEY FIX: must match subjectId EXACTLY
    if (stored !== normalizedSubjectId) return false;

    // 🔥 KEY FIX: record must actually contain this exam type
    if (type === 'test1' && r.test1 === undefined) return false;
    if (type === 'test2' && r.test2 === undefined) return false;
    if (type === 'test3' && r.test3 === undefined) return false;
    if (type === 'exam'  && r.exam  === undefined) return false;

    return true;
  });

  // ✅ No valid prior submission → allow
  if (!existing) {
    return next();
  }

  // 🚫 Block only if THIS attempt truly exists
  return res.status(403).json({
    error: `You have already submitted ${type} for this subject`
  });
}


// ======================================================
// Regenerates ONE of a student's two persistent, parent-facing PDFs
// — "Tests" (Test 1-3 across every subject) or "Exam" (exam scores
// across every subject) — overwriting the same fixed file every time
// a relevant score changes, so the parent portal always shows one
// current file per category rather than accumulating a new one per
// submission.
// ======================================================
async function regenerateConsolidatedPDF(studentId, category) {
  const data = readData();
  const student = (data.students || []).find(s => s.id === studentId);
  if (!student) return;

  // Excludes any result whose total is outside a realistic bound —
  // same protection as the parent dashboard's average, applied here
  // too so a corrupted row can't inflate the "Overall Average" line
  // printed on the PDF itself either.
  const studentResults = (data.results || []).filter(
    r => r.studentId === studentId && (r.total || 0) <= REASONABLE_MAX_SCORE
  );
  const subjectRows = [];
  let totalSum = 0;
  let countedSubjects = 0;

  for (const r of studentResults) {
    const subj = (data.subjects || []).find(s => s.id === r.subject && s.classId === student.classId);
    const subjectName = subj ? subj.name : r.subject;

    if (category === 'Tests') {
      if (r.test1 === undefined && r.test2 === undefined && r.test3 === undefined) continue;
      const total = (r.test1 || 0) + (r.test2 || 0) + (r.test3 || 0);
      subjectRows.push({ subjectName, test1: r.test1 ?? null, test2: r.test2 ?? null, test3: r.test3 ?? null, total });
      totalSum += total;
      countedSubjects++;
    } else {
      if (r.exam === undefined) continue;
      // The real bug: this used to divide by the LIVE exam question
      // bank's summed marks — a number that has nothing to do with
      // the score's actual scale. r.exam is capped at submission time
      // (see the /exam/submit route: `score = Math.min(score,
      // SCORE_CAPS.exam)`) to SCORE_CAPS.exam, which — together with
      // test1+test2+test3 (10+10+10) — is the school's actual 100-mark
      // grading convention: 30% continuous assessment + 70% exam.
      // SCORE_CAPS.exam (70) IS the exam's real, fixed full-marks
      // value; it was never meant to be derived from how many
      // questions currently exist or what their live marks add up to.
      // Dividing by the live question bank instead means: whenever
      // that live total happened to be smaller than a student's score,
      // the result exceeded 100% (showing absurd values like 1400%).
      // Dividing by the fixed constant instead is correct by
      // construction — the clamp below stays in as a harmless backstop
      // regardless.
      const examMaxMarks = SCORE_CAPS.exam;
      const rawPercentage = examMaxMarks > 0 ? (r.exam / examMaxMarks) * 100 : null;
      const percentage = rawPercentage === null ? null : Number(Math.min(100, Math.max(0, rawPercentage)).toFixed(1));
      subjectRows.push({ subjectName, examScore: r.exam, percentage });
      if (percentage !== null) {
        totalSum += percentage;
        countedSubjects++;
      }
    }
  }

  if (!subjectRows.length) return; // nothing recorded for this category yet

  const average = countedSubjects > 0 ? totalSum / countedSubjects : null;

  const filename = `${studentId}_${category.toUpperCase()}.pdf`;
  // Generated to a temp file first (PDFKit needs a writable stream),
  // then uploaded to Supabase Storage — this file gets regenerated
  // and overwritten on every relevant score change, so it needs to
  // genuinely persist, not just live on whatever server happened to
  // generate it most recently.
  const localPath = tempPdfPath(filename);

  // data.meta.logo is a Supabase Storage URL now — resolved to a
  // local temp file first. This call was missing entirely before —
  // the upload/storage side got fixed, but the logo itself never
  // did, for this specific PDF.
  const logoResolved = await withResolvedImages(data.meta);

  try {
    await new Promise((resolve, reject) => {
      generateConsolidatedResultPDF(logoResolved.meta, student, category, subjectRows, average, localPath, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  } finally {
    logoResolved.cleanup();
  }

  const relPath = await uploadLocalFileAndCleanup(localPath, `summaries/${student.classId}/${filename}`);

  const pdfType = category === 'Tests' ? 'tests_summary' : 'exam_summary';
  await updateData((liveData) => {
    if (!liveData.pdfs) liveData.pdfs = [];
    const existing = liveData.pdfs.find(p => p.studentId === studentId && p.type === pdfType);
    if (existing) {
      existing.filePath = relPath;
      existing.timestamp = new Date().toISOString();
    } else {
      liveData.pdfs.push({
        id: `pdf_${pdfType}_${studentId}`,
        type: pdfType,
        studentId,
        classId: student.classId,
        filePath: relPath,
        timestamp: new Date().toISOString(),
      });
    }
  }, ['pdfs']);
}

app.post('/api/exam/submit', preventMultipleSubmissions, async (req, res) => {
  if (!req.session.portalExam)
    return res.status(401).json({ error: 'Portal exam access required' });

  try {
    const { studentId, classId, subjectId, type, answers } = req.body;
    const data = readData();

    // enforce test toggles
    if (data.meta?.testToggles && data.meta.testToggles[type] === false) {
      return res.status(403).json({ error: `${type} is disabled by admin` });
    }

    const student = (data.students || []).find(
      (s) => s.id === studentId && s.classId === classId
    );
    const subj = (data.subjects || []).find(
      (s) => s.id === subjectId && s.classId === classId
    );

    if (!student || !subj)
      return res
        .status(404)
        .json({ error: 'Student or subject not found for this class' });

    // compute score safely
    let score = 0;
    const items = subj.questions[type] || [];
    const itemsWithAns = items.map((q) => {
      const ans =
        answers && Object.prototype.hasOwnProperty.call(answers, q.qid)
          ? answers[q.qid]
          : undefined;
      const marks = Number(q.marks) || 1;
      if (
        ans &&
        q.answer &&
        ans.trim().toLowerCase() === q.answer.trim().toLowerCase()
      )
        score += marks;
      return {
        qid: q.qid,
        text: q.text,
        options: Array.isArray(q.options)
          ? q.options.slice()
          : q.options || [],
        answer: q.answer,
        marks,
        studentAnswer: ans,
        image: q.image || null, // ✅ include question image
      };
    });

    const totalPossible = items.reduce(
      (sum, q) => sum + (Number(q.marks) || 1),
      0
    );
    // The old percentage calc used to live here, computed from the raw
    // (not-yet-capped) score against the raw question-bank total. But
    // a few lines below, `score` gets capped to the school's actual
    // grading scale (SCORE_CAPS) — so that percentage was already
    // wrong before the response was even built: it reflected a score
    // the student's own receipt would then show as something smaller.
    // The correct total/percentage (using the same fixed grading-scale
    // denominator the parent-portal summary now uses) is computed
    // further below, once the capped score is actually known — see
    // gradedTotal/percentage after the updateData() call.

    // Score is saved FIRST, immediately, using the same race-free
    // update path the manual score-entry grid uses — before this fix,
    // the score only got saved AFTER the PDF finished generating,
    // meaning a PDF failure (a bad image, anything) meant the
    // student's entire result was silently never recorded at all,
    // even though they'd genuinely completed the exam. Now the score
    // is safe regardless of what happens with the PDF afterward.
    await updateData((liveData) => {
      if (!liveData.results) liveData.results = [];
      let existing = liveData.results.find(
        (r) =>
          r.studentId === studentId &&
          r.classId === classId &&
          r.subject === subjectId
      );

      if (!existing) {
        existing = {
          id: `res_${Date.now()}`,
          studentId,
          classId,
          subject: subjectId,
        };
        liveData.results.push(existing);
      }

      // A CBT score is computed from question marks, not typed
      // directly, but it's still clamped to the school's real grading
      // scale (SCORE_CAPS) — a safety net in case a subject's
      // question marks were ever set up to add to more than the type
      // actually allows. Reassigning `score` itself here (rather than
      // a separate variable) keeps everything downstream consistent —
      // the student's own confirmation screen, the saved result, and
      // the PDF all agree on the same number.
      score = Math.min(score, SCORE_CAPS[type] ?? score);

      if (type === 'test1') existing.test1 = score;
      if (type === 'test2') existing.test2 = score;
      if (type === 'test3') existing.test3 = score;
      if (type === 'exam') existing.exam = score;
      existing.total =
        (existing.test1 || 0) +
        (existing.test2 || 0) +
        (existing.test3 || 0) +
        (existing.exam || 0);
      existing.updatedAt = new Date().toISOString();
    }, ['results']); // only the results table needs re-saving here

    // Computed here, AFTER score has been capped above, using the
    // same fixed grading-scale denominator the parent-portal Exam
    // Summary uses (SCORE_CAPS[type]) rather than the live, raw
    // question-bank total — so the score, its "out of" total, and its
    // percentage always agree with each other on this student's own
    // confirmation screen, on their downloadable receipt PDF, and
    // later on the parent portal's summary, for the exact same
    // submission. Falls back to the raw totalPossible only for a type
    // with no defined cap (shouldn't happen for test1/test2/test3/exam,
    // but keeps this safe if a new type is ever added without one).
    const gradedTotal = SCORE_CAPS[type] ?? totalPossible;
    const percentage = gradedTotal > 0 ? Number(((score / gradedTotal) * 100).toFixed(2)) : 0;

    // Regenerate this student's persistent, parent-facing summary PDF
    // for whichever category this submission belongs to. Wrapped so a
    // PDF problem never takes the score down with it — the score is
    // already safely saved above by this point.
    try {
      await regenerateConsolidatedPDF(studentId, type === 'exam' ? 'Exam' : 'Tests');
    } catch (pdfErr) {
      console.error('regenerateConsolidatedPDF error:', pdfErr);
    }

    // Filename deliberately has NO timestamp and DOES include subjectId.
    // The old version (exam_${type}_${studentId}_${Date.now()}.pdf, no
    // subjectId at all) meant every single sitting — every retake, of
    // every subject — created a brand-new permanent file in Storage,
    // with nothing anywhere in the app that ever cleaned an old one up.
    // For a real school that's every student × every subject × every
    // test type × every attempt, forever. Using a fixed, deterministic
    // name per (student, subject, type) and uploading with upsert:true
    // means a retake correctly REPLACES the previous attempt's receipt
    // at the same path — which is also the more correct product
    // behavior, since the current attempt is what should be on file,
    // not a permanent stack of every past one. subjectId has to be
    // part of the name now that it's no longer timestamp-unique,
    // otherwise two different subjects' receipts for the same student
    // would collide onto the same path and silently overwrite each other.
    const filename = `exam_${type}_${subjectId}.pdf`;
    const localPath = tempPdfPath(filename);
    const examMeta = {
      type,
      subject: subj.name,
      items: itemsWithAns,
      score,
      total: gradedTotal,
      percentage,
    };

    // The logo and student's photo are now Supabase Storage URLs —
    // fetched to quick local temp files here so generateExamPDF (kept
    // completely unchanged) can keep working with real local paths
    // exactly as it always has.
    const resolved = await withResolvedImages(data.meta, student);

    // ✅ generate PDF including student photo + question images
    generateExamPDF(resolved.meta, resolved.student, examMeta, localPath, async (err) => {
      resolved.cleanup();

      if (err) {
        // The score is already safely saved above — a PDF problem is
        // now just a PDF problem, not a lost result.
        console.error('generateExamPDF error:', err);
        return res.json({
          success: true,
          score,
          total: gradedTotal,
          percentage,
          pdf: null,
          warning: 'Result saved, but the PDF could not be generated.',
        });
      }

      let relPath;
      try {
        relPath = await uploadLocalFileAndCleanup(localPath, `exam-results/${classId}/${studentId}/${filename}`);
      } catch (uploadErr) {
        console.error('Exam PDF storage upload failed:', uploadErr);
        return res.json({
          success: true,
          score,
          total: gradedTotal,
          percentage,
          pdf: null,
          warning: 'Result saved, but the PDF could not be stored.',
        });
      }

      updateData((liveData) => {
        if (!liveData.pdfs) liveData.pdfs = [];
        // Same reasoning as the storage path above: update the existing
        // record for this exact student+subject+type instead of always
        // pushing a new one, so the pdfs table stays bounded too and
        // never holds a stale entry pointing at an attempt that's since
        // been overwritten in Storage.
        const existing = liveData.pdfs.find(
          (p) => p.type === 'exam_result' && p.studentId === studentId && p.subject === subj.name && p.examType === type
        );
        if (existing) {
          existing.filePath = relPath;
          existing.timestamp = new Date().toISOString();
        } else {
          liveData.pdfs.push({
            id: `pdf_exam_result_${studentId}_${subjectId}_${type}`,
            type: 'exam_result',
            studentId,
            filePath: relPath,
            timestamp: new Date().toISOString(),
            subject: subj.name,
            examType: type,
          });
        }
      }, ['pdfs']) // only the pdfs table needs re-saving here
        .then(() => {
          res.json({
            success: true,
            score,
            total: gradedTotal,
            percentage,
            pdf: relPath,
          });
        })
        .catch((saveErr) => {
          console.error('updateData after exam pdf error:', saveErr);
          // Score is still safe — only the PDF record itself failed to save.
          res.json({
            success: true,
            score,
            total: gradedTotal,
            percentage,
            pdf: relPath,
            warning: 'Result saved, but the PDF record could not be stored.',
          });
        });
    });
  } catch (err) {
    console.error('/api/exam/submit unexpected error:', err);
    res
      .status(500)
      .json({ error: 'Internal server error', details: err.message });
  }
});

// ---------------- PARENT PORTAL AUTH ----------------
app.post('/api/portal/parent/auth', (req, res) => {
  try {
    const { portalPassword } = req.body;
    const data = readData();

    // Optional toggle: allow admin to disable parent portal
    if (data.meta?.portalToggles?.parentPortal === false) {
      return res.status(403).json({ error: 'Parent portal is disabled by admin' });
    }

    // Check password
    if (portalPassword === data.meta?.portalPasswords?.parentPortal) {
      req.session.parentAuth = true; // ✅ unified session flag
      return res.json({ success: true, message: 'Parent portal login successful' });
    } else {
      return res.status(401).json({ error: 'Invalid password' });
    }
  } catch (err) {
    console.error('Parent portal auth error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});


// ---------------- VERIFY STUDENT ID (NEW) ----------------
app.post('/api/verify-student-id', (req, res) => {
  try {
    // Require parent portal session
    if (!req.session.parentAuth) {
      return res.status(401).json({ error: 'Unauthorized. Please login to parent portal.' });
    }

    const { studentId } = req.body;
    if (!studentId) {
      return res.status(400).json({ error: 'Missing student ID.' });
    }

    const data = readData();
    let foundStudent = null;

    // Check in data.students
    if (Array.isArray(data.students)) {
      foundStudent = data.students.find(s => s.id === studentId);
    }

    // If not found, check nested class structure
    if (!foundStudent && Array.isArray(data.classes)) {
      for (const cls of data.classes) {
        const student = (cls.students || []).find(s => s.id === studentId);
        if (student) {
          foundStudent = student;
          break;
        }
      }
    }

    if (!foundStudent) {
      return res.status(404).json({ valid: false, error: 'Student ID not found.' });
    }

    return res.json({
      valid: true,
      student: {
        id: foundStudent.id,
        name: foundStudent.name,
        classId: foundStudent.classId || 'N/A'
      }
    });
  } catch (err) {
    console.error('Verify student ID error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});


// ---------------- PARENT PORTAL: DOWNLOAD REPORTS ----------------
app.post('/api/portal/parent/download', async (req, res) => {
  try {
    // Require parent portal session
    if (!req.session.parentAuth) {
      return res.status(401).json({ error: 'Unauthorized. Please login to parent portal.' });
    }

    const { studentId } = req.body;
    if (!studentId) {
      return res.status(400).json({ error: 'Missing student ID' });
    }

    const data = readData();

    // Find student record
    const student = (data.students || []).find(s => s.id === studentId);
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // Collect this student's PDF records from the real database
    let pdfs = (data.pdfs || []).filter(p => p.studentId === studentId);

    // Include teacher portal PDFs (from reports folder)
    const reportDir = path.join(__dirname, 'reports');
    if (fs.existsSync(reportDir)) {
      const files = fs.readdirSync(reportDir).filter(f => f.startsWith(studentId));
      const folderPdfs = files.map(f => ({
        studentId,
        type: 'Report Sheet',
        filePath: `/reports/${f}`,
      }));

      // Merge, avoiding duplicates
      const existingPaths = pdfs.map(p => p.filePath);
      folderPdfs.forEach(f => {
        if (!existingPaths.includes(f.filePath)) pdfs.push(f);
      });
    }

    // CLEAN STALE ENTRIES: this used to check fs.existsSync() on every
    // filePath to drop anything that no longer exists — but every
    // filePath is now a full Supabase Storage URL, not a local path.
    // Stripping the leading slash off "https://..." does nothing
    // useful, and joining the result with __dirname produces a path
    // that can never exist on local disk — meaning this was silently
    // removing every single real PDF before the response was even
    // built. A URL is trusted as-is (it was only ever stored here
    // after a successful upload); the local-existence check now only
    // still applies to genuine old-style relative paths, for any
    // pre-migration data that hasn't been regenerated yet.
    pdfs = pdfs.filter(p => {
      if (/^https?:\/\//i.test(p.filePath)) return true;
      const fullPath = path.join(__dirname, p.filePath.replace(/^\/+/, ''));
      return fs.existsSync(fullPath);
    });

    // Actually persisted now via the real database — this used to
    // write the cleaned-up list straight to the old data.json file,
    // a file nothing else in the system reads, so the cleanup never
    // really took effect on the real dataset at all.
    //
    // This had the exact same bug as the filter above, and it was
    // far more serious here: since this actually writes to the real
    // database, it was permanently deleting every valid Supabase-URL
    // PDF entry for this student, on every single call to this
    // route — a parent opening their portal was quietly erasing
    // their own child's real records each time.
    await updateData((liveData) => {
      liveData.pdfs = (liveData.pdfs || []).filter(p => {
        if (p.studentId !== studentId) return true; // leave other students' entries untouched
        if (/^https?:\/\//i.test(p.filePath)) return true;
        const fullPath = path.join(__dirname, p.filePath.replace(/^\/+/, ''));
        return fs.existsSync(fullPath);
      });
    }, ['pdfs']);

    if (pdfs.length === 0) {
      return res.status(404).json({ error: 'No reports found for this student.' });
    }

    return res.json({ success: true, pdfs });
  } catch (err) {
    console.error('Parent portal download error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// ---------------- FILE DELIVERY ----------------
// ======================================================
// NEW: parent dashboard for the redesigned portal — deliberately a
// separate route rather than modifying '/api/portal/parent/download'
// above, since the old parent.html/parent.js still calls that route
// exactly as it is. Reuses the SAME auth ('/api/portal/parent/auth')
// and student lookup ('/api/verify-student-id') already in place —
// this only adds what's needed to serve the new dashboard: the
// student's photo, their two consolidated PDFs plus their current
// report sheet, and their overall average across all recorded results.
// ======================================================
app.get('/api/portal/parent/dashboard/:studentId', (req, res) => {
  if (!req.session.parentAuth) {
    return res.status(401).json({ error: 'Unauthorized. Please login to parent portal.' });
  }

  try {
    const { studentId } = req.params;
    const data = readData();

    const student = (data.students || []).find(s => s.id === studentId);
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const cls = (data.classes || []).find(c => c.id === student.classId);

    const testsPdf = (data.pdfs || []).find(p => p.studentId === studentId && p.type === 'tests_summary') || null;
    const examPdf = (data.pdfs || []).find(p => p.studentId === studentId && p.type === 'exam_summary') || null;
    const reportSheetPdf = (data.pdfs || []).find(p => p.studentId === studentId && p.type === 'report_sheet') || null;

    // The individual, full-detail per-submission PDFs — same as the
    // old system always showed, question-by-question, one per CBT
    // sitting. These sit alongside the two new consolidated summaries
    // rather than replacing them, newest first.
    const individualSubmissions = (data.pdfs || [])
      .filter(p => p.studentId === studentId && p.type === 'exam_result')
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .map(p => ({
        subject: p.subject || null,
        examType: p.examType || null,
        filePath: p.filePath,
        timestamp: p.timestamp,
      }));

    // Overall average — every subject's total (test1+test2+test3+exam)
    // recorded for this student, averaged. A subject with no results
    // recorded at all is left out entirely rather than counted as 0,
    // so a student who's only sat 2 of their 6 subjects isn't shown
    // an artificially low average.
    //
    // Also guards against corrupted historical data: a `total` value
    // above any realistic school score (REASONABLE_MAX_SCORE) is
    // excluded rather than averaged in — one bad row from old data
    // shouldn't be able to produce an absurd result like an average
    // in the trillions.
    const studentResults = (data.results || []).filter(
      r => r.studentId === studentId && (r.total || 0) <= REASONABLE_MAX_SCORE
    );
    const average =
      studentResults.length > 0
        ? Number(
            (studentResults.reduce((sum, r) => sum + (r.total || 0), 0) / studentResults.length).toFixed(1)
          )
        : null;

    res.json({
      student: {
        id: student.id,
        name: student.name,
        classId: student.classId,
        className: cls ? cls.name : student.classId,
        photo: student.photo || null,
      },
      average,
      pdfs: {
        tests: testsPdf ? { filePath: testsPdf.filePath, updatedAt: testsPdf.timestamp } : null,
        exam: examPdf ? { filePath: examPdf.filePath, updatedAt: examPdf.timestamp } : null,
        reportSheet: reportSheetPdf ? { filePath: reportSheetPdf.filePath, updatedAt: reportSheetPdf.timestamp } : null,
      },
      individualSubmissions,
    });
  } catch (err) {
    console.error('Parent dashboard error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

app.get('/file', (req, res) => {
  try {
    const rel = req.query.path;
    if (!rel) return res.status(400).send('Missing path');

    const full = path.join(__dirname, rel);
    if (fs.existsSync(full)) {
      return res.sendFile(full);
    } else {
      return res.status(404).send('Not found');
    }
  } catch (err) {
    console.error('File delivery error:', err);
    return res.status(500).send('Internal server error');
  }
});

// ---------------- GLOBAL ERROR HANDLERS ----------------
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason && reason.stack ? reason.stack : reason);
});

// ---------------- START ----------------
const PORT = process.env.PORT || 5000;
const { whenReady } = require('./utils/dataStore');
whenReady().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

  // Registry check-in: confirms this school is still active and
  // reports its current student/result counts, every 5 minutes.
  // Safe to call even if this school hasn't been linked to the
  // registry yet — it just runs standalone in that case.
  startRegistryHeartbeat(() => {
    const data = readData();
    return {
      students: (data.students || []).length,
      records: (data.results || []).length,
    };
  });
}).catch(err => {
  console.error('❌ Could not start: dataStore failed to load from the database.', err);
  process.exit(1);
});
// The old Mega Server heartbeat used to run here every 60 seconds —
// removed along with megaClient.js. The registry integration's own
// heartbeat (started above, inside whenReady().then()) now does this
// job properly, checking in with the real operator console instead.
const interfaces = os.networkInterfaces();
for (const name of Object.keys(interfaces)) {
  for (const iface of interfaces[name]) {
    if (iface.family === 'IPv4' && !iface.internal) {
      console.log(`🌍 Access this server at: http://${iface.address}:${PORT}`);
    }
  }
}
