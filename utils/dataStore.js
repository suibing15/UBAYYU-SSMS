// utils/dataStore.js
//
// Drop-in replacement for the old data.json-based store. Every other
// file in the project keeps calling readData() / writeData(obj) exactly
// as before, nothing else needs to change.
//
// How it works:
//   - On startup, everything is loaded ONCE from Postgres + Storage
//     into an in-memory object shaped exactly like the old data.json.
//   - readData() just returns that in-memory object instantly (synchronous,
//     same as before).
//   - writeData(obj) updates the in-memory object immediately, then saves
//     it to Postgres in the background (writes are queued in order, so
//     they can never race or corrupt each other).
//
// Required environment variables (same as the migration scripts):
//   SUPABASE_DB_URL, SCHOOL_SCHEMA, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SCHOOL_BUCKET

const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const SCHEMA = process.env.SCHOOL_SCHEMA;
const BUCKET = process.env.SCHOOL_BUCKET;

if (!SCHEMA || !/^[a-z][a-z0-9_]*$/.test(SCHEMA)) {
  throw new Error('SCHOOL_SCHEMA is missing or unsafe. dataStore.js cannot start.');
}

const pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Every query in this file runs against this school's schema only.
async function query(sql, params) {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${SCHEMA}`);
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// --------------------------------------------------------------
// LOAD: pull everything from Postgres and rebuild the exact same
// nested shape the old data.json had.
// --------------------------------------------------------------
async function loadFromDatabase() {
  const [settingsRes, adminsRes, teachersRes, classesRes, subjectsRes,
         questionsRes, studentsRes, resultsRes, sessionsRes, recordsRes,
         teacherAttRes, pdfsRes] = await Promise.all([
    query('SELECT * FROM settings WHERE id = 1'),
    query('SELECT username, password FROM admins'),
    query('SELECT * FROM teachers'),
    query('SELECT * FROM classes'),
    query('SELECT * FROM subjects'),
    query('SELECT * FROM questions'),
    query('SELECT * FROM students'),
    query('SELECT * FROM results'),
    query('SELECT * FROM attendance_sessions'),
    query('SELECT * FROM attendance_records'),
    query('SELECT * FROM teacher_attendance'),
    query('SELECT * FROM pdfs')
  ]);

  const s = settingsRes.rows[0] || {};

  // A school whose settings row was created without these keys ever
  // being seeded ends up with portal_toggles = {} (or a partial
  // object) in Postgres. The admin panel's "Portal Toggles" card
  // renders one button per key in this object — with zero keys, it
  // renders nothing at all, and looks like the card is simply broken.
  // Defaulting every known toggle to true here, then letting whatever
  // was actually saved override those defaults, guarantees the full
  // set of toggle buttons always appears — for every school, including
  // ones whose row predates a given toggle being added. Nothing here
  // touches Postgres directly; the very next time any single toggle is
  // flipped, writeData(['settings']) persists this complete merged
  // object back, so the row self-heals on first use.
  const DEFAULT_PORTAL_TOGGLES = {
    teacherPortal: true,
    examPortal: true,
    reportPortal: true,
    parentPortal: true,
    attendancePortal: true
  };
  const meta = {
    schoolName: s.school_name,
    address: s.address,
    motto: s.motto,
    phone: s.phone,
    term: s.term,
    session: s.session,
    nextTermBegins: s.next_term_begins,
    logo: s.logo_path,
    signaturePrincipal: s.signature_principal_path,
    portalToggles: { ...DEFAULT_PORTAL_TOGGLES, ...(s.portal_toggles || {}) },
    portalPasswords: s.portal_passwords || {},
    testToggles: s.test_toggles || {},
    unlockPasswordHash: s.unlock_password_hash
  };

  const admins = adminsRes.rows.map(a => ({ username: a.username, password: a.password }));

  const teachers = teachersRes.rows.map(t => ({
    id: t.id, name: t.name, password: t.password, photo: t.photo_path,
    active: t.active, blocked: t.blocked, createdAt: t.created_at
  }));

  const classes = classesRes.rows.map(c => ({
    id: c.id, name: c.name, password: c.password, locked: c.locked,
    teacherSignature: c.teacher_signature_path
  }));

  // Rebuild each subject's nested questions.test1/test2/test3/exam arrays
  const questionsBySubject = {};
  for (const q of questionsRes.rows) {
    const key = `${q.subject_id}::${q.class_id}`;
    if (!questionsBySubject[key]) {
      questionsBySubject[key] = { test1: [], test2: [], test3: [], exam: [] };
    }
    questionsBySubject[key][q.exam_type].push({
      qid: q.qid, text: q.text, options: q.options || [], answer: q.answer,
      marks: q.marks, image: q.image_path
    });
  }
  const subjects = subjectsRes.rows.map(s => ({
    id: s.id, classId: s.class_id, name: s.name, timeLimits: s.time_limits || {},
    questions: questionsBySubject[`${s.id}::${s.class_id}`] || { test1: [], test2: [], test3: [], exam: [] }
  }));

  const students = studentsRes.rows.map(st => ({
    id: st.id, name: st.name, classId: st.class_id, password: st.password, photo: st.photo_path
  }));

  // NUMERIC columns come back from Postgres as strings, not numbers —
  // that's node-postgres's deliberate behavior for NUMERIC/DECIMAL
  // types, to avoid floating-point precision loss. Every one of these
  // five columns is NUMERIC in the schema, so without this explicit
  // conversion, every "+" done anywhere against these fields (totals,
  // averages, the PDF generators, all of it) silently concatenates
  // digit strings instead of adding numbers — exactly what produced
  // those absurd inflated "averages". Converting once, right here,
  // where the data enters the app, is the actual fix — not patching
  // every individual calculation that touches these fields elsewhere.
  const toNumOrUndef = (v) => (v === null || v === undefined ? undefined : Number(v));
  const results = resultsRes.rows.map(r => ({
    id: r.id, studentId: r.student_id, classId: r.class_id, subject: r.subject_id,
    test1: toNumOrUndef(r.test1), test2: toNumOrUndef(r.test2), test3: toNumOrUndef(r.test3),
    exam: toNumOrUndef(r.exam), total: toNumOrUndef(r.total),
    updatedAt: r.updated_at
  }));

  // Rebuild attendance[classId][date] = { teacherId, timestamp, students: {id: status} }
  const attendance = {};
  const sessionById = {};
  for (const sess of sessionsRes.rows) {
    sessionById[sess.id] = sess;
    if (!attendance[sess.class_id]) attendance[sess.class_id] = {};
    const dateKey = sess.session_date.toISOString ? sess.session_date.toISOString().slice(0, 10) : sess.session_date;
    attendance[sess.class_id][dateKey] = {
      teacherId: sess.teacher_id, timestamp: sess.timestamp, students: {}
    };
  }
  for (const rec of recordsRes.rows) {
    const sess = sessionById[rec.session_id];
    if (!sess) continue;
    const dateKey = sess.session_date.toISOString ? sess.session_date.toISOString().slice(0, 10) : sess.session_date;
    attendance[sess.class_id][dateKey].students[rec.student_id] = rec.status;
  }

  const teacherAttendance = {};
  for (const ta of teacherAttRes.rows) {
    if (!teacherAttendance[ta.teacher_id]) teacherAttendance[ta.teacher_id] = {};
    const dateKey = ta.attendance_date.toISOString ? ta.attendance_date.toISOString().slice(0, 10) : ta.attendance_date;
    teacherAttendance[ta.teacher_id][dateKey] = ta.login_time;
  }

  const pdfs = pdfsRes.rows.map(p => ({
    id: p.id, type: p.type, studentId: p.student_id, classId: p.class_id,
    subject: p.subject, examType: p.exam_type, filePath: p.storage_path,
    timestamp: p.created_at
  }));

  return {
    meta, admins, teachers, classes, subjects, students, results,
    attendance, teacherAttendance, pdfs, users: [], settings: {}
  };
}

// --------------------------------------------------------------
// SAVE: push the current in-memory object back to Postgres.
// Each table is fully replaced (delete + re-insert) inside one
// transaction. Simple and always correct; fine at this data size
// (a few thousand rows), even though it's not the most efficient
// possible approach.
// --------------------------------------------------------------
// `only`, when given, restricts a save to just these table-groups —
// e.g. ['results'] for a single score edit, instead of the previous
// behavior of always re-saving every one of the 12 tables regardless
// of what actually changed. That was the real cause of the delay:
// a single score edit was triggering a full delete-and-reinsert of
// the entire results table (thousands of rows) and questions table
// (hundreds of rows) every single time, no matter how small the
// actual change. Leaving `only` unset preserves the exact old
// behavior (a full save of everything), so nothing that doesn't
// explicitly opt in is affected by this change.
async function saveToDatabase(data, only = null) {
  const shouldSave = (group) => !only || only.includes(group);

  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${SCHEMA}`);
    await client.query('BEGIN');

    if (shouldSave('settings')) {
      const meta = data.meta || {};
      await client.query(
        `UPDATE settings SET school_name=$1, address=$2, motto=$3, phone=$4, term=$5,
          session=$6, next_term_begins=$7, logo_path=$8, signature_principal_path=$9, portal_toggles=$10,
          portal_passwords=$11, test_toggles=$12, unlock_password_hash=$13 WHERE id = 1`,
        [meta.schoolName, meta.address, meta.motto, meta.phone, meta.term, meta.session,
         meta.nextTermBegins, meta.logo, meta.signaturePrincipal, JSON.stringify(meta.portalToggles || {}),
         JSON.stringify(meta.portalPasswords || {}), JSON.stringify(meta.testToggles || {}), meta.unlockPasswordHash]
      );
    }

    if (shouldSave('admins')) {
      await replaceTable(client, 'admins', ['username', 'password'],
        (data.admins || []).map(a => [a.username, a.password]));
    }

    if (shouldSave('teachers')) {
      await upsertTable(client, 'teachers', ['id', 'name', 'password', 'photo_path', 'active', 'blocked', 'created_at'], ['id'],
        (data.teachers || []).map(t => [t.id, t.name, t.password, t.photo || null, t.active !== false, !!t.blocked, t.createdAt || null]));
      await deleteStaleRows(client, 'teachers', 'id', (data.teachers || []).map(t => t.id));
    }

    if (shouldSave('classes')) {
      await upsertTable(client, 'classes', ['id', 'name', 'password', 'locked', 'teacher_signature_path'], ['id'],
        (data.classes || []).map(c => [c.id, c.name, c.password || null, !!c.locked, c.teacherSignature || null]));
      await deleteStaleRows(client, 'classes', 'id', (data.classes || []).map(c => c.id));
    }

    if (shouldSave('subjects')) {
      await replaceTable(client, 'subjects', ['id', 'class_id', 'name', 'time_limits'],
        (data.subjects || []).map(s => [s.id, s.classId, s.name, JSON.stringify(s.timeLimits || {})]));
    }

    if (shouldSave('questions')) {
      const questionRows = [];
      for (const s of (data.subjects || [])) {
        for (const type of ['test1', 'test2', 'test3', 'exam']) {
          for (const q of ((s.questions && s.questions[type]) || [])) {
            questionRows.push([s.id, s.classId, type, q.qid, q.text, JSON.stringify(q.options || []), q.answer || null, q.marks || 1, q.image || null]);
          }
        }
      }
      await replaceTable(client, 'questions', ['subject_id', 'class_id', 'exam_type', 'qid', 'text', 'options', 'answer', 'marks', 'image_path'], questionRows);
    }

    if (shouldSave('students')) {
      await upsertTable(client, 'students', ['id', 'name', 'class_id', 'password', 'photo_path'], ['id'],
        (data.students || []).map(s => [s.id, s.name, s.classId, s.password, s.photo || null]));
      await deleteStaleRows(client, 'students', 'id', (data.students || []).map(s => s.id));
    }

    if (shouldSave('results')) {
      await replaceTable(client, 'results', ['id', 'student_id', 'class_id', 'subject_id', 'test1', 'test2', 'test3', 'exam', 'total', 'updated_at'],
        (data.results || []).map(r => [r.id, r.studentId, r.classId, r.subject, r.test1 ?? null, r.test2 ?? null, r.test3 ?? null, r.exam ?? null, r.total ?? null, r.updatedAt || new Date()]));
    }

    if (shouldSave('attendance')) {
      // Attendance: rebuild sessions + records from the nested shape
      await client.query('DELETE FROM attendance_records');
      await client.query('DELETE FROM attendance_sessions');
      for (const [classId, days] of Object.entries(data.attendance || {})) {
        for (const [date, day] of Object.entries(days)) {
          const sessRes = await client.query(
            `INSERT INTO attendance_sessions (class_id, session_date, teacher_id, timestamp)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [classId, date, day.teacherId || null, day.timestamp || new Date()]
          );
          const sessionId = sessRes.rows[0].id;
          for (const [studentId, status] of Object.entries(day.students || {})) {
            await client.query(
              `INSERT INTO attendance_records (session_id, student_id, status) VALUES ($1, $2, $3)`,
              [sessionId, studentId, status]
            );
          }
        }
      }
    }

    if (shouldSave('teacherAttendance')) {
      // Teacher attendance (login-marks-attendance)
      await client.query('DELETE FROM teacher_attendance');
      for (const [teacherId, days] of Object.entries(data.teacherAttendance || {})) {
        for (const [date, loginTime] of Object.entries(days)) {
          await client.query(
            `INSERT INTO teacher_attendance (teacher_id, attendance_date, login_time) VALUES ($1, $2, $3)`,
            [teacherId, date, loginTime]
          );
        }
      }
    }

    if (shouldSave('pdfs')) {
      // `created_at` was missing from this column list entirely — it
      // was never actually being saved, meaning `replaceTable`'s
      // delete-and-reinsert reset every PDF's timestamp back to
      // right-now on every unrelated save that touched this table,
      // and a full server restart lost it completely (since the load
      // side below didn't map it back either). Fixed on both sides.
      await replaceTable(client, 'pdfs', ['id', 'type', 'student_id', 'class_id', 'subject', 'exam_type', 'storage_path', 'created_at'],
        (data.pdfs || []).map(p => [p.id, p.type, p.studentId, p.classId || null, p.subject || null, p.examType || null, p.filePath, p.timestamp || new Date()]));
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Background save to database failed:', err.message);
    if (err.detail) console.error('   Detail:', err.detail);
    throw err;
  } finally {
    client.release();
  }
}

// Deletes everything in a table then re-inserts the given rows, in
// batches, inside the caller's existing transaction. Safe ONLY for
// tables nothing else points to by foreign key (or where the FK has
// ON DELETE CASCADE and gets rebuilt in the same transaction anyway).
async function replaceTable(client, table, columns, rows) {
  await client.query(`DELETE FROM ${table}`);
  if (!rows.length) return;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const valuesSql = [];
    const params = [];
    for (const row of chunk) {
      const base = params.length;
      valuesSql.push(`(${row.map((_, j) => `$${base + j + 1}`).join(',')})`);
      params.push(...row);
    }
    await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${valuesSql.join(',')}`, params);
  }
}

// Removes rows from a table that are no longer in the given list of
// IDs to keep. Wrapped in a SAVEPOINT so that if a row can't be
// removed (e.g. a teacher who still has attendance history and no
// ON DELETE CASCADE for it), that specific cleanup is skipped rather
// than aborting the whole save.
async function deleteStaleRows(client, table, pkCol, keepIds) {
  await client.query('SAVEPOINT before_cleanup');
  try {
    if (keepIds.length) {
      const placeholders = keepIds.map((_, i) => `$${i + 1}`).join(',');
      await client.query(`DELETE FROM ${table} WHERE ${pkCol} NOT IN (${placeholders})`, keepIds);
    } else {
      await client.query(`DELETE FROM ${table}`);
    }
    await client.query('RELEASE SAVEPOINT before_cleanup');
  } catch (err) {
    console.warn(`⚠ Could not remove some rows from ${table} (likely still referenced elsewhere, e.g. attendance history): ${err.message}`);
    await client.query('ROLLBACK TO SAVEPOINT before_cleanup');
    await client.query('RELEASE SAVEPOINT before_cleanup');
  }
}

// Inserts or updates rows by primary key, WITHOUT ever deleting.
// Required for tables other tables point to by foreign key without
// ON DELETE CASCADE (teachers, classes) — a delete-then-reinsert
// there gets rejected the instant any attendance history exists,
// even though the row is about to be put right back.
async function upsertTable(client, table, columns, conflictCols, rows) {
  if (!rows.length) return;
  const updateCols = columns.filter(c => !conflictCols.includes(c));
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const valuesSql = [];
    const params = [];
    for (const row of chunk) {
      const base = params.length;
      valuesSql.push(`(${row.map((_, j) => `$${base + j + 1}`).join(',')})`);
      params.push(...row);
    }
    const updateSql = updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ');
    await client.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${valuesSql.join(',')}
       ON CONFLICT (${conflictCols.join(',')}) DO UPDATE SET ${updateSql}`,
      params
    );
  }
}

// --------------------------------------------------------------
// PUBLIC API — same shape as the old dataStore.js
// --------------------------------------------------------------
let cache = null;
let ready = false;
let saveQueue = Promise.resolve(); // serializes background saves, in order

async function init() {
  cache = await loadFromDatabase();
  ready = true;
  console.log('✔ dataStore loaded from Postgres schema:', SCHEMA);
}
const initPromise = init().catch(err => {
  console.error('❌ dataStore failed to load from the database on startup:', err);
  process.exit(1);
});

function readData() {
  if (!ready) {
    // This should basically never happen in practice (init() runs at
    // require-time), but fail loudly rather than silently if it does.
    throw new Error('dataStore is still loading from the database, try again in a moment.');
  }
  return JSON.parse(JSON.stringify(cache)); // detached copy, same behaviour as before
}

function writeData(obj, only = null) {
  cache = obj;
  saveQueue = saveQueue.then(() => saveToDatabase(obj, only)).catch(err => {
    // Logged inside saveToDatabase already. We swallow it here so one
    // failed background save doesn't break the queue for later saves.
  });
  return saveQueue;
}

// Safe for anything that does a rapid sequence of small, independent
// changes — auto-saving one grid cell at a time is exactly this.
//
// readData()+writeData() has a real race: readData() hands back a
// detached snapshot, so if two saves overlap, the second one can grab
// its snapshot before the first one's writeData() has replaced the
// cache, then silently overwrite the cache with a copy that's missing
// the first save entirely. A single "Save" button click per student
// (the old system's pattern) rarely overlaps enough to hit this in
// practice; auto-saving on every cell blur across a whole class does,
// easily.
//
// updateData() closes that gap: the mutator function only ever runs
// once its turn comes up in the same queue writeData() already uses,
// so it always sees whatever the most recently queued change actually
// left behind, not a stale snapshot from before it.
//
// `only`, same as writeData() above, restricts which tables actually
// get re-saved — pass e.g. ['results'] for a score edit so it doesn't
// pay the cost of re-saving students, questions, and everything else
// untouched.
function updateData(mutatorFn, only = null) {
  saveQueue = saveQueue.then(async () => {
    mutatorFn(cache);
    await saveToDatabase(cache, only);
  }).catch(err => {
    // Logged inside saveToDatabase already.
  });
  return saveQueue;
}

// Exposed for anything that wants to know the store is ready before
// serving requests (see the small server.js startup change below).
function whenReady() {
  return initPromise;
}

module.exports = { readData, writeData, updateData, whenReady, supabase, SCHOOL_BUCKET: BUCKET };
