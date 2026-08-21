const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

/* =========================================================
   CONSTANTS – CR80 PLASTIC ID SIZE
   ========================================================= */
const CARD_W = 242; // 85.6mm
const CARD_H = 153; // 54mm
const PRIMARY = "#004080";

/* =========================================================
   ROBUST IMAGE RESOLVER (ABSOLUTE + RELATIVE)
   ========================================================= */
function resolveImage(p) {
  if (!p) return null;

  const clean = String(p).replace(/^\/+/, "");
  const base = path.join(__dirname, "..", "public");

  const candidates = [
    path.isAbsolute(p) ? p : null,
    path.join(base, "images", clean),
    path.join(base, clean),
    path.join(base, "images", path.basename(clean))
  ].filter(Boolean);

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      return file;
    }
  }

  return null;
}


/* =========================================================
   FRONT SIDE
   ========================================================= */
function drawFront(doc, student, meta, x, y, scale = 1, plainPassword) {
  const sx = v => x + v * scale;
  const sy = v => y + v * scale;
  const W = CARD_W * scale;
  const H = CARD_H * scale;

  /* ---------- BORDER ---------- */
  doc.lineWidth(2)
    .strokeColor(PRIMARY)
    .roundedRect(sx(2), sy(2), W - 4, H - 4, 8)
    .stroke();

  /* ---------- HEADER ---------- */
  doc.rect(sx(2), sy(2), W - 4, 36 * scale).fill(PRIMARY);

  doc.fillColor("#fff")
    .font("Helvetica-Bold")
    .fontSize(7.8 * scale)
    .text(
      meta.schoolName || "ASSALAM INTERNATIONAL ACADEMIC SCHOOL",
      sx(6),
      sy(6),
      { width: W - 12, align: "center", lineBreak: false }
    );

  doc.font("Helvetica")
    .fontSize(6.2 * scale)
    .fillColor("#e6f0ff")
    .text(
      `Address: ${meta.address || "Behind Garko Motor Park, Opp. Tasidi Filling Station"}`,
      sx(6),
      sy(18),
      { width: W - 12, align: "center", lineBreak: false }
    );

  doc.fontSize(6.2 * scale)
    .text(
      `Motto: ${meta.motto || "Success comes after tears"}`,
      sx(6),
      sy(26),
      { width: W - 12, align: "center", lineBreak: false }
    );

  /* ---------- TITLE ---------- */
  doc.font("Helvetica-Bold")
    .fontSize(7.2 * scale)
    .fillColor(PRIMARY)
    .text(
      "STUDENT IDENTIFICATION CARD",
      sx(0),
      sy(42),
      { width: W, align: "center" }
    );

  /* ---------- LOGO ---------- */
  const logo = resolveImage(meta.logo) || path.join(__dirname, "../public/images/logo.png");
  if (fs.existsSync(logo)) {
    doc.image(logo, sx(W - 42), sy(48), { width: 28 });
  }

const fallbackPhoto = path.join(__dirname, "../public/images/default-photo.jpg");

const photoPath =
  resolveImage(student.photo) ||
  (fs.existsSync(fallbackPhoto) ? fallbackPhoto : null);

const px = sx(10);
const py = sy(54);
const ps = 62 * scale;

if (photoPath) {
  doc.image(photoPath, px, py, { width: ps, height: ps });
  doc.rect(px, py, ps, ps).stroke(PRIMARY);
} else {
  doc.rect(px, py, ps, ps).stroke(PRIMARY);
  doc.fontSize(6 * scale)
     .fillColor("#555")
     .text("NO PHOTO", px + 12, py + 24);
}

  /* ---------- DETAILS ---------- */
  doc.fillColor("#000")
    .font("Helvetica")
    .fontSize(7.2 * scale);

  let ty = sy(58);
  const gap = 12 * scale;

  doc.text(`Name: ${student.name || "N/A"}`, sx(82), ty); ty += gap;
  doc.text(`Class: ${student.classId || "N/A"}`, sx(82), ty); ty += gap;
  doc.text(`ID: ${student.studentId || student.id || "N/A"}`, sx(82), ty); ty += gap;
  doc.text(`Password: ${plainPassword || "Contact admin for login details"}`, sx(82), ty);

  /* ---------- FOOTER ---------- */
  doc.moveTo(sx(8), sy(H - 22))
    .lineTo(sx(W - 8), sy(H - 22))
    .stroke(PRIMARY);

  doc.fontSize(6.2 * scale)
    .fillColor(PRIMARY)
    .text(
      "Authorized by School Administration : 07068595598, 09022783003",
      sx(0),
      sy(H - 18),
      { width: W, align: "center" }
    );
}

/* =========================================================
   BACK SIDE (SINGLE ID ONLY – CORRECT)
   ========================================================= */
function drawBack(doc, student, meta, x, y, scale = 1) {
  const sx = v => x + v * scale;
  const sy = v => y + v * scale;
  const W = CARD_W * scale;
  const H = CARD_H * scale;

  doc.lineWidth(2)
    .strokeColor(PRIMARY)
    .roundedRect(sx(2), sy(2), W - 4, H - 4, 8)
    .stroke();

  doc.font("Helvetica-Bold")
    .fontSize(7.5 * scale)
    .fillColor(PRIMARY)
    .text("IMPORTANT NOTICE", sx(0), sy(14), { width: W, align: "center" });

  doc.font("Helvetica")
    .fontSize(6.8 * scale)
    .fillColor("#000")
    .text(
      "If found, please return this card immediately to the school management. "
      + `This card remains the property of ${meta.schoolName || "the school"}.`,
      sx(14),
      sy(36),
      { width: W - 28, align: "center" }
    );

  doc.text(
    "Unauthorized use, alteration, or duplication of this card is strictly prohibited "
    + "and may attract disciplinary action.",
    sx(14),
    sy(82),
    { width: W - 28, align: "center" }
  );
}

/* =========================================================
   SINGLE ID – FRONT + BACK
   ========================================================= */
async function generateIDCard(student, meta, outputPath, plainPassword) {
  const doc = new PDFDocument({ size: [CARD_W, CARD_H], margin: 0 });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  drawFront(doc, student, meta, 0, 0, 1, plainPassword);
  doc.addPage();
  drawBack(doc, student, meta, 0, 0, 1);

  doc.end();
  return new Promise(res => stream.on("finish", res));
}

/* =========================================================
   BULK ID CARDS – FRONT ONLY (CORRECT)
   ========================================================= */
async function generateBulkIDCards(students, meta, outputPath) {
  const doc = new PDFDocument({ size: "A4", margin: 20 });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  const scale = 0.9;
  const cols = 2;
  const rows = 4;
  const gapX = 18;
  const gapY = 18;

  let i = 0;

  students.forEach(student => {
    if (i === cols * rows) {
      doc.addPage();
      i = 0;
    }

    const col = i % cols;
    const row = Math.floor(i / cols);

    const x = 20 + col * (CARD_W * scale + gapX);
    const y = 20 + row * (CARD_H * scale + gapY);

    drawFront(doc, student, meta, x, y, scale);
    i++;
  });

  doc.end();
  return new Promise(res => stream.on("finish", res));
}

module.exports = {
  generateIDCard,
  generateBulkIDCards,
  generateTeacherIDCard
};

/* =========================================================
   TEACHER ID CARD — mirrors the student card's proven layout
   exactly (same header, same title band, same photo box and
   detail-line positions), just with Class and Password removed
   and only Name + ID shown, per staff card requirements.
   ========================================================= */
function drawTeacherFront(doc, teacher, meta, x, y, scale = 1) {
  const sx = v => x + v * scale;
  const sy = v => y + v * scale;
  const W = CARD_W * scale;
  const H = CARD_H * scale;

  /* ---------- BORDER ---------- */
  doc.lineWidth(2)
    .strokeColor(PRIMARY)
    .roundedRect(sx(2), sy(2), W - 4, H - 4, 8)
    .stroke();

  /* ---------- HEADER ---------- */
  doc.rect(sx(2), sy(2), W - 4, 36 * scale).fill(PRIMARY);

  doc.fillColor("#fff")
    .font("Helvetica-Bold")
    .fontSize(7.8 * scale)
    .text(
      meta.schoolName || "ASSALAM INTERNATIONAL ACADEMIC SCHOOL",
      sx(6),
      sy(6),
      { width: W - 12, align: "center", lineBreak: false }
    );

  doc.font("Helvetica")
    .fontSize(6.2 * scale)
    .fillColor("#e6f0ff")
    .text(
      `Address: ${meta.address || "Behind Garko Motor Park, Opp. Tasidi Filling Station"}`,
      sx(6),
      sy(18),
      { width: W - 12, align: "center", lineBreak: false }
    );

  doc.fontSize(6.2 * scale)
    .text(
      `Motto: ${meta.motto || "Success comes after tears"}`,
      sx(6),
      sy(26),
      { width: W - 12, align: "center", lineBreak: false }
    );

  /* ---------- TITLE ---------- */
  doc.font("Helvetica-Bold")
    .fontSize(7.2 * scale)
    .fillColor(PRIMARY)
    .text(
      "STAFF IDENTIFICATION CARD",
      sx(0),
      sy(42),
      { width: W, align: "center" }
    );

  /* ---------- LOGO ---------- */
  const logo = resolveImage(meta.logo) || path.join(__dirname, "../public/images/logo.png");
  if (fs.existsSync(logo)) {
    try { doc.image(logo, sx(W - 42), sy(48), { width: 28 }); } catch {}
  }

  /* ---------- PHOTO ---------- (identical box to the student card) */
  const photoPath = resolveImage(teacher.photo);
  const px = sx(10);
  const py = sy(54);
  const ps = 62 * scale;

  if (photoPath) {
    doc.image(photoPath, px, py, { width: ps, height: ps });
    doc.rect(px, py, ps, ps).stroke(PRIMARY);
  } else {
    doc.rect(px, py, ps, ps).stroke(PRIMARY);
    doc.fontSize(6 * scale).fillColor("#555").text("NO PHOTO", px + 12, py + 24);
  }

  /* ---------- DETAILS — Name + ID only, no password ---------- */
  doc.fillColor("#000")
    .font("Helvetica")
    .fontSize(7.2 * scale);

  let ty = sy(58);
  const gap = 12 * scale;

  doc.text(`Name: ${teacher.name || "N/A"}`, sx(82), ty); ty += gap;
  doc.text(`ID: ${teacher.id || "N/A"}`, sx(82), ty);

  /* ---------- FOOTER ---------- */
  doc.moveTo(sx(8), sy(H - 22))
    .lineTo(sx(W - 8), sy(H - 22))
    .stroke(PRIMARY);

  doc.fontSize(6.2 * scale)
    .fillColor(PRIMARY)
    .text(
      "Authorized by School Administration",
      sx(0),
      sy(H - 18),
      { width: W, align: "center" }
    );
}

async function generateTeacherIDCard(teacher, meta, outputPath) {
  const doc = new PDFDocument({ size: [CARD_W, CARD_H], margin: 0 });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  drawTeacherFront(doc, teacher, meta, 0, 0, 1);

  doc.end();
  return new Promise(res => stream.on("finish", res));
}

