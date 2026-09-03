// =====================================================================
//  Shared Supabase Storage helper — replaces local-disk file writes
//  across the whole app (student/teacher photos, signatures, branding,
//  question images, and every generated PDF).
//
//  Every school already has its own isolated Storage bucket
//  (SCHOOL_BUCKET), the same way it has its own Postgres schema — this
//  just gives every upload/generation route one clean way to actually
//  use it, instead of writing to a local folder that a new deployment
//  (or a restart on a host without a persistent disk) would silently
//  wipe.
// =====================================================================
const { supabase, SCHOOL_BUCKET } = require("./dataStore");

// Uploads a buffer to this school's bucket and returns its public URL.
// `storagePath` is the path *inside* the bucket, e.g. "students/0136A.jpg"
// — organizing by folder inside the bucket, not by separate buckets,
// keeps this simple regardless of how many categories of file exist.
//
// cacheControl defaults to '0' (no caching). Several paths in this app
// (report sheets, class reports, summaries, signatures) are uploaded to
// the SAME fixed storage path repeatedly with upsert:true, specifically
// so a fresh generation replaces the old file. Supabase Storage's own
// default cache-control (max-age=3600) meant a browser or any CDN in
// front of it could keep serving the OLD bytes at that same URL for up
// to an hour after the file was correctly overwritten server-side —
// showing a teacher or parent stale scores even though the database and
// the stored object were both already correct. cacheControl: '0' makes
// every download revalidate against the current object instead.
async function uploadBuffer(storagePath, buffer, contentType, cacheControl = "0") {
  const { error } = await supabase.storage
    .from(SCHOOL_BUCKET)
    .upload(storagePath, buffer, { contentType, upsert: true, cacheControl });

  if (error) throw new Error(`Storage upload failed for ${storagePath}: ${error.message}`);

  const { data } = supabase.storage.from(SCHOOL_BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}

// Convenience wrapper for anything currently written with PDFKit —
// PDFKit needs a writable stream, so the generator still writes to a
// temp file first (nothing about the generator functions themselves
// needs to change), and this uploads the finished file afterward and
// cleans up the temp copy either way.
const fs = require("fs");
const os = require("os");
const path = require("path");

async function uploadLocalFileAndCleanup(localPath, storagePath, contentType = "application/pdf", cacheControl = "0") {
  try {
    const buffer = fs.readFileSync(localPath);
    const url = await uploadBuffer(storagePath, buffer, contentType, cacheControl);
    return url;
  } finally {
    fs.unlink(localPath, () => {}); // best-effort cleanup, never blocks on failure
  }
}

// A fresh temp path to generate a PDF into before uploading — using
// the OS temp directory rather than anywhere inside the app's own
// folder, so there's nothing left behind for a redeploy to care about.
function tempPdfPath(filename) {
  return path.join(os.tmpdir(), `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${filename}`);
}

async function deleteFromStorage(storagePath) {
  try {
    await supabase.storage.from(SCHOOL_BUCKET).remove([storagePath]);
  } catch (err) {
    console.error(`Storage delete failed for ${storagePath} (non-critical):`, err.message);
  }
}

// Every filePath saved anywhere in this app (pdfs table entries, etc.)
// is the FULL public URL returned by uploadBuffer() — e.g.
// "https://xxxxx.supabase.co/storage/v1/object/public/{bucket}/reports/nur1/UB000_report.pdf"
// — not the bucket-relative path deleteFromStorage() above actually
// needs ("reports/nur1/UB000_report.pdf"). This pulls that relative
// path back out. Returns null for anything that doesn't look like one
// of this school's own Storage URLs, so a caller can safely skip it
// rather than attempt a delete with a garbage path.
function storagePathFromUrl(url) {
  if (!url) return null;
  const marker = `/object/public/${SCHOOL_BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return url.slice(idx + marker.length);
}

// Every PDF generator (reportGenerator.js, pdfGenerator.js, etc.)
// expects a real *local file path* for a logo, a student's photo, or
// a signature — that's what they were built and carefully tested
// against. Rather than touch those already-verified files, this
// downloads a Supabase Storage URL to a quick temp file right before
// generation, and the generators keep working completely unchanged.
// A value that's already a local path (or missing) passes through
// untouched — this only ever does something for a genuine http(s) URL.
//
// Deliberately never throws: if a single student's photo URL is
// unreachable (a permissions issue, a network hiccup, anything), that
// should mean a report generated without that one photo, not an
// entire class's batch of 40 reports failing outright over one bad
// image. Matches the same "fail open" approach used everywhere else
// in this app — a missing image is a cosmetic gap, not a reason to
// block a teacher or admin from getting real, needed documents.
async function resolveImageForGeneration(urlOrPath) {
  if (!urlOrPath || !/^https?:\/\//i.test(urlOrPath)) return { path: urlOrPath, cleanup: () => {} };

  const https = require("https");
  const ext = path.extname(new URL(urlOrPath).pathname) || ".png";
  const localPath = path.join(os.tmpdir(), `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);

  try {
    await new Promise((resolve, reject) => {
      https.get(urlOrPath, (res) => {
        if (res.statusCode !== 200) return reject(new Error(`Image fetch failed: ${res.statusCode}`));
        const fileStream = fs.createWriteStream(localPath);
        res.pipe(fileStream);
        fileStream.on("finish", () => fileStream.close(resolve));
        fileStream.on("error", reject);
      }).on("error", reject);
    });
  } catch (err) {
    console.error(`Could not fetch image for PDF generation (continuing without it): ${urlOrPath} — ${err.message}`);
    fs.unlink(localPath, () => {}); // in case a partial file was left behind
    return { path: null, cleanup: () => {} };
  }

  return { path: localPath, cleanup: () => fs.unlink(localPath, () => {}) };
}

module.exports = { uploadBuffer, uploadLocalFileAndCleanup, tempPdfPath, deleteFromStorage, storagePathFromUrl, resolveImageForGeneration, withResolvedImages, withResolvedImagesForMany, withResolvedFieldForMany };

// Generic version of withResolvedImagesForMany for any field name —
// question papers resolve each question's own "image" field, not a
// person's "photo". Same shape: resolved copies + one cleanup.
async function withResolvedFieldForMany(items, fieldName) {
  const resolutions = await Promise.all(items.map((it) => resolveImageForGeneration(it[fieldName])));
  const resolvedItems = items.map((it, i) => ({ ...it, [fieldName]: resolutions[i].path }));
  const cleanup = () => resolutions.forEach((r) => r.cleanup());
  return { items: resolvedItems, cleanup };
}

// Same idea as withResolvedImages, for a whole list of people at once
// (a bulk ID card batch, a whole class) — the shared logo/signature
// only need resolving once, but each person's own photo needs its
// own resolution. One combined cleanup covers everything.
async function withResolvedImagesForMany(meta, people) {
  const logo = await resolveImageForGeneration(meta?.logo);
  const signature = await resolveImageForGeneration(meta?.signaturePrincipal);
  // meta.teacherSignature is a per-class Supabase Storage URL, same as
  // logo/signaturePrincipal — resolved the same way so any caller that
  // ends up drawing a teacher signature from this batch gets a real
  // local file instead of an unresolved URL.
  const teacherSig = await resolveImageForGeneration(meta?.teacherSignature);
  const resolvedMeta = meta ? { ...meta, logo: logo.path, signaturePrincipal: signature.path, teacherSignature: teacherSig.path } : meta;

  const photoResolutions = await Promise.all(
    people.map((p) => resolveImageForGeneration(p.photo))
  );
  const resolvedPeople = people.map((p, i) => ({ ...p, photo: photoResolutions[i].path }));

  const cleanup = () => {
    logo.cleanup();
    signature.cleanup();
    teacherSig.cleanup();
    photoResolutions.forEach((r) => r.cleanup());
  };

  return { meta: resolvedMeta, people: resolvedPeople, cleanup };
}

// Convenience wrapper for the common case: a PDF generator needs the
// school's logo, its principal's signature, and (sometimes) a
// student's own photo, all resolved to local temp files at once, with
// one cleanup call afterward covering all three. Returns shallow
// copies of `meta`/`student` — the originals passed in are untouched.
//
// Also resolves meta.teacherSignature when present — it's the same
// kind of value (a Supabase Storage URL, set per-class when a teacher
// uploads their signature) as logo/signaturePrincipal, and the report
// generators need it downloaded to a real local file for the exact
// same reason they need the logo downloaded: PDFKit's doc.image()
// only accepts a local path or buffer, never a URL.
async function withResolvedImages(meta, student = null) {
  const logo = await resolveImageForGeneration(meta?.logo);
  const signature = await resolveImageForGeneration(meta?.signaturePrincipal);
  const teacherSig = await resolveImageForGeneration(meta?.teacherSignature);
  const photo = student ? await resolveImageForGeneration(student.photo) : { path: null, cleanup: () => {} };

  const resolvedMeta = meta ? { ...meta, logo: logo.path, signaturePrincipal: signature.path, teacherSignature: teacherSig.path } : meta;
  const resolvedStudent = student ? { ...student, photo: photo.path } : student;

  const cleanup = () => {
    logo.cleanup();
    signature.cleanup();
    teacherSig.cleanup();
    photo.cleanup();
  };

  return { meta: resolvedMeta, student: resolvedStudent, cleanup };
}
