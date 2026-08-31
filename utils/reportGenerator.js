// utils/reportGenerator.js
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const dayjs = require("dayjs");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// Auto grading + remarks
function getGradeAndRemark(score) {
  let grade = "F";
  let remark = "Poor";
  if (score >= 70) { grade = "A"; remark = "Excellent"; }
  else if (score >= 60) { grade = "B"; remark = "Very Good"; }
  else if (score >= 50) { grade = "C"; remark = "Good"; }
  else if (score >= 40) { grade = "D"; remark = "Fair"; }
  else if (score >= 30) { grade = "E"; remark = "Weak"; }
  return { grade, remark };
}

// Auto recommendation
function getRecommendation(avg) {
  if (avg >= 70) return "Excellent performance. Keep it up!";
  if (avg >= 60) return "Very good work. A little more effort to reach excellence.";
  if (avg >= 50) return "Good performance. Try to improve further.";
  if (avg >= 40) return "Fair effort, more study is required.";
  return "Needs serious improvement and closer attention.";
}

// ======================================================================
//   OPTIMIZED TRIPLE-LAYER EMBOSSED WATERMARK (FAST VERSION)
// ======================================================================
function applyAshBackgroundWithWatermark(doc, text) {
  const W = doc.page.width;
  const H = doc.page.height;

  // White background
  doc.save();
  doc.rect(0, 0, W, H).fillColor("#ffffff").fill();
  doc.restore();

  // Common settings
  const baseFont = "Helvetica-Bold";
  const size = 4.5;      // reduced from 5 → faster
  const opacity1 = 0.08;
  const opacity2 = 0.12;
  const opacity3 = 0.18;

  // Slight variations
  const rot1 = -36;
  const rot2 = -36.4;
  const rot3 = -36.8;

  // **Optimized loop grid size**
  const dx = 32;   // spacing horizontally
  const dy = 12;   // spacing vertically

  // =============== LAYER 1 ===============
  doc.save();
  doc.font(baseFont).fontSize(size);
  doc.fillColor("#d6d6d6");
  doc.opacity(opacity1);
  doc.rotate(rot1, { origin: [W / 2, H / 2] });

  for (let y = -H; y < H * 2; y += dy) {
    for (let x = -W; x < W * 2; x += dx) {
      doc.text(text, x, y, { lineBreak: false });
    }
  }
  doc.restore();

  // =============== LAYER 2 ===============
  doc.save();
  doc.font(baseFont).fontSize(size);
  doc.fillColor("#b8b8b8");
  doc.opacity(opacity2);
  doc.rotate(rot2, { origin: [W / 2, H / 2] });

  for (let y = -H; y < H * 2; y += dy) {
    for (let x = -W; x < W * 2; x += dx) {
      doc.text(text, x + 5, y + 4, { lineBreak: false });
    }
  }
  doc.restore();

  // =============== LAYER 3 ===============
  doc.save();
  doc.font(baseFont).fontSize(size);
  doc.fillColor("#f7f7f7");
  doc.opacity(opacity3);
  doc.rotate(rot3, { origin: [W / 2, H / 2] });

  for (let y = -H; y < H * 2; y += dy) {
    for (let x = -W; x < W * 2; x += dx) {
      doc.text(text, x + 9, y + 7, { lineBreak: false });
    }
  }
  doc.restore();

  // Reset
  doc.opacity(1).fillColor("#000");
}



/**
 * Generates PDF report
 */
function generateReportPDF(meta, student, reportData, outPath, callback) {
  try {
    ensureDir(path.dirname(outPath));

    const doc = new PDFDocument({ margin: 40 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    // ======================================================
    // 1. APPLY WATERMARK + BACKGROUND FIRST
    // ======================================================
    applyAshBackgroundWithWatermark(
      doc,
      meta.schoolName || "ASSALAM INTERNATIONAL ACADEMIC SCHOOL GARKO"
    );

    // ======================================================
    // 2. BORDER (always above watermark)
    // ======================================================
    const margin = 25;
    doc.lineWidth(1).strokeColor("#888");
    doc.rect(
      margin,
      margin,
      doc.page.width - margin * 2,
      doc.page.height - margin * 2
    ).stroke();

    // ===== LOGO =====
    // meta.logo may now be a genuine, already-existing absolute temp
    // path (resolved ahead of time in server.js before calling this
    // function), not just the old "/uploads/xyz.png"-style web path
    // this line was originally written for.
    const logoPath = meta.logo && fs.existsSync(meta.logo)
      ? meta.logo
      : meta.logo
        ? path.join(__dirname, "..", "public", meta.logo.replace(/^\//, ""))
        : path.join(__dirname, "../public/logo.png");
    if (fs.existsSync(logoPath)) {
      try {
        doc.image(logoPath, doc.page.width / 2 - 20, 40, { width: 40 });
      } catch {}
    }

    // ===== TITLE BOX =====
    const schoolName = meta.schoolName || "SCHOOL NAME";
    doc.font("Helvetica-Bold").fontSize(15);
    const boxWidth = doc.widthOfString(schoolName) + 60;
    const boxX = (doc.page.width - boxWidth) / 2;
    const boxY = 90;

    doc.rect(boxX, boxY, boxWidth, 28).stroke();
    doc.text(schoolName, 0, boxY + 7, { align: "center" });

    // Address + details
    doc.font("Helvetica").fontSize(10).fillColor("#333");
    doc.text(`Address: ${meta.address || "Behind Garko Motor Park, Opp. Tasidi Filling Station"}`, 0, boxY + 38, { align: "center" });
    doc.text(`Motto: ${meta.motto || "Success comes after tears"}`, 0, boxY + 52, { align: "center" });
    doc.text(`Phone: ${meta.phone || "08165789331, 08103992584, 08151015152"}`, 0, boxY + 66, { align: "center" });

    doc.moveTo(60, boxY + 82).lineTo(540, boxY + 82).stroke();

    // ===== TITLE =====
    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(13).text("STUDENT REPORT SHEET", { align: "center" });

    // ===== PHOTO =====
    if (student.photoPath) {
      try {
        const relative = student.photoPath.replace(/^\/?public\//, "").replace(/^\//, "");
        const pic = path.join(__dirname, "..", relative);
        if (fs.existsSync(pic)) doc.image(pic, 430, 160, { width: 90, height: 100 });
      } catch {}
    }

    // ===== STUDENT INFO =====
    doc.moveDown(1);
    const infoY = doc.y;
    doc.font("Helvetica").fontSize(10);

    let classDisplay = student.classId;
    try {
      if (Array.isArray(meta.classes)) {
        const c = meta.classes.find(cl =>
          (cl.id || "").toUpperCase() === (student.classId || "").toUpperCase()
        );
        if (c && c.name) classDisplay = c.name;
      }
    } catch {}

    const sessionValue = meta.session || meta.Session || meta.sessionName || "";

    doc.text(`Name: ${student.name}`, 60, infoY);
    doc.text(`Class: ${classDisplay}`, 60, infoY + 14);
    doc.text(`Admission No: ${student.id}`, 60, infoY + 28);

    doc.text(`Term: ${meta.term}`, 300, infoY);
    doc.text(`Session: ${sessionValue}`, 300, infoY + 14);
    doc.text(`Date: ${dayjs().format("YYYY-MM-DD HH:mm")}`, 300, infoY + 28);

    if (meta.totalStudents)
      doc.text(`No. Students: ${meta.totalStudents}`, 60, infoY + 42);

    doc.text(`Position: ${meta.position || "—"}`, 300, infoY + 42);

    doc.moveDown(4);

    // ===== TABLE HEADER =====
    const startY = doc.y;
    const headers = ["Subject","Test1","Test2","Test3","Exam","Total","Grade","Remark"];
    const colX = [60,175,225,275,325,385,445,495];

    doc.font("Helvetica-Bold").fontSize(10);
    headers.forEach((h,i)=> doc.text(h, colX[i], startY));
    doc.moveTo(60,startY+12).lineTo(540,startY+12).stroke();

    doc.font("Helvetica").fontSize(9);

    let y = startY + 18;
    let totalScore = 0;
    let subjectCount = 0;

    for (const subject in reportData) {
      const r = reportData[subject];
      const t1 = +r.test1 || 0;
      const t2 = +r.test2 || 0;
      const t3 = +r.test3 || 0;
      const ex = +r.exam  || 0;
      const total = t1 + t2 + t3 + ex;

      const { grade, remark } = getGradeAndRemark(total);

      totalScore += total;
      subjectCount++;

      const vals = [subject, t1, t2, t3, ex, total, grade, remark];
      vals.forEach((v,i)=> doc.text(String(v), colX[i], y));

      y += 14;

      if (y > doc.page.height - 150) {
        // NEW PAGE
        doc.addPage();

        // Repeat background + watermark
        applyAshBackgroundWithWatermark(doc, meta.schoolName || "ASSALAM INTERNATIONAL ACADEMIC SCHOOL GARKO");

        // border
        doc.lineWidth(1).strokeColor("#888");
        doc.rect(margin, margin, doc.page.width - margin * 2, doc.page.height - margin * 2).stroke();

        y = 60;
      }
    }

    if (!subjectCount) {
      doc.text("No subjects found.", 60, y);
      y += 16;
    }

    const avg = subjectCount ? (totalScore / subjectCount).toFixed(2) : 0;

    // ===== SUMMARY =====
    y += 10;
    doc.font("Helvetica-Bold").fontSize(10);
    doc.text(`Subjects: ${subjectCount}`,60,y);
    doc.text(`Total: ${totalScore}`,200,y);
    doc.text(`Average: ${avg}`,360,y);

    const recommendation = getRecommendation(avg);

    y += 28;
    doc.text("Teacher's Recommendation:",60,y);

    doc.font("Helvetica").fontSize(10).text(recommendation,60,y+14,{width:380});

    // Next Term
    doc.font("Helvetica-Bold").fontSize(10).text("Next Term Begins:",400,y);
    doc.font("Helvetica").fontSize(10).text(meta.nextTermBegins || "TBA",400,y+14);

    // ===== SIGNATURES =====
    y += 90;
    doc.font("Helvetica-Bold").fontSize(10);
    doc.text("Teacher's Signature:",60,y);
    doc.text("Principal's Signature:",350,y);

    // Teacher signature
    // meta.teacherSignature may already be a genuine, existing absolute
    // temp path — resolved ahead of time in server.js (withResolvedImages
    // downloads the class's Supabase Storage signature URL to a local
    // file before this function is ever called), exactly the same
    // pattern already used above for the logo. That must be checked
    // FIRST: joining an already-absolute path onto __dirname/.. (the old
    // behaviour below) silently produces a path that never exists, which
    // is why the signature was never actually rendering.
    let teacherSigPath = null;
    if (student.classId) {
      const sigFile = `${student.classId}_signature.png`;
      const try1 = path.join(__dirname, "../public/uploads/teachers", sigFile);
      const try2 = path.join(__dirname, "../public/uploads", sigFile);
      if (fs.existsSync(try1)) teacherSigPath = try1;
      else if (fs.existsSync(try2)) teacherSigPath = try2;
    }

    if (!teacherSigPath && meta.teacherSignature) {
      teacherSigPath = fs.existsSync(meta.teacherSignature)
        ? meta.teacherSignature
        : path.join(__dirname, "..", meta.teacherSignature.replace(/^\//, ""));
    }

    if (teacherSigPath && fs.existsSync(teacherSigPath)) {
      doc.image(teacherSigPath,60,y+15,{width:80,height:40});
    } else {
      doc.text("____________________________",160,y);
    }

  // Principal signature — same already-resolved-path-first fix as above.
  let principalPath = meta.signaturePrincipal || "/uploads/principal_signature.png";
  const principalSig = fs.existsSync(principalPath)
    ? principalPath
    : path.join(__dirname, "..", "public", principalPath.replace(/^\//, ""));

if (fs.existsSync(principalSig)) {
  doc.image(principalSig, 350, y + 15, { width: 80, height: 40 });
} else {
  doc.text("____________________", 350, y + 15);
}


    y += 70;
    doc.font("Helvetica").fontSize(8).fillColor("#444");
    doc.text(
      `Generated by ${meta.schoolName || "School"} Portal - ${dayjs().format("YYYY-MM-DD")}`,
      60,
      y
    );

    doc.end();
    stream.on("finish",()=> callback && callback(null,outPath));
    stream.on("error",(err)=> callback && callback(err));

  } catch(err) {
    callback && callback(err);
  }
}

module.exports = { generateReportPDF };


