// utils/pdfGenerator.js
//
// Compact exam-result PDF: two questions per row, answer info on
// one line, so most real exams (this school averages ~7 questions
// per subject) fit cleanly on a single page. Falls back to extra
// pages gracefully only when a genuinely large exam needs them.

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { fitSingleLine, measureWrappedHeight } = require('./pdfTextFit');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function resolveLocalPath(p) {
  if (!p) return null;

  // If this is already a real, existing local path — exactly what
  // storage.js's resolveImageForGeneration hands in now (a genuine
  // absolute OS temp file path, e.g. "/tmp/173829_abc.png") — use it
  // directly. The candidate-guessing below was built assuming its
  // input is always a "/uploads/xyz.png"-style web path relative to
  // this app's own folders, and mangles a real absolute path into
  // something that never exists, silently dropping the logo.
  if (fs.existsSync(p)) return p;

  const clean = String(p).replace(/^\/+/, '');

  // Question images and branding images (logo/signature) both get
  // stored with the same "/uploads/..." style path, but they
  // actually live in two different physical folders (question
  // images in the top-level "uploads/", branding in "public/uploads/").
  // Try every real possibility rather than assuming one, and use
  // whichever file genuinely exists.
  const candidates = [
    path.join(__dirname, '..', clean),
    path.join(__dirname, '..', 'public', clean),
    path.join(__dirname, '..', 'uploads', path.basename(clean)),
    path.join(__dirname, '..', 'public', 'uploads', path.basename(clean))
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function generateExamPDF(meta, student, examMeta, outPath, callback) {
  try {
    ensureDir(path.dirname(outPath));
    const doc = new PDFDocument({ margin: 40, autoFirstPage: true });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    // Uses the same safe resolveLocalPath() helper as the other logo
    // block further down in this file — this one had its own
    // separate, still-broken inline copy that never got the fix,
    // which is exactly why one PDF type from this file kept losing
    // its logo while the other (already using resolveLocalPath)
    // worked fine.
    const logoPath = resolveLocalPath(meta.logo) || path.join(__dirname, '../public/logo.png');
    const margin = 25;

    doc.on('pageAdded', () => {
      doc.lineWidth(1).strokeColor('#999');
      doc.rect(margin, margin, doc.page.width - margin * 2, doc.page.height - margin * 2).stroke();
    });

    doc.fillColor('#000').opacity(1);
    doc.lineWidth(1).strokeColor('#999');
    doc.rect(margin, margin, doc.page.width - margin * 2, doc.page.height - margin * 2).stroke();

    if (fs.existsSync(logoPath)) {
      try { doc.image(logoPath, doc.page.width / 2 - 20, 45, { width: 40, height: 40 }); } catch {}
    }

    const title = meta.schoolName || 'School Name';
    doc.fontSize(14).font('Helvetica-Bold');
    const boxWidth = Math.min(doc.widthOfString(title) + 60, doc.page.width - 120);
    const boxX = (doc.page.width - boxWidth) / 2;
    const boxY = 95;
    const boxHeight = 22;
    doc.rect(boxX, boxY, boxWidth, boxHeight).stroke();
    fitSingleLine(doc, title, 0, boxY + 5, doc.page.width, { startSize: 14, minSize: 8, font: 'Helvetica-Bold', align: 'center' });

    doc.fontSize(8).font('Helvetica').fillColor('#333');
    fitSingleLine(doc, `Address: ${meta.address || "Behind Garko Motor Park, Opp. Tasidi Filling Station"}`, 0, boxY + 28, doc.page.width, { startSize: 8, minSize: 6, font: 'Helvetica', align: 'center' });
    fitSingleLine(doc, `Motto: ${meta.motto || "Success comes after tears"}`, 0, boxY + 39, doc.page.width, { startSize: 8, minSize: 6, font: 'Helvetica', align: 'center' });
    fitSingleLine(doc, `Phone number: ${meta.phone || "08165789331, 08103992584, 08151015152"}`, 0, boxY + 50, doc.page.width, { startSize: 8, minSize: 6, font: 'Helvetica', align: 'center' });
    doc.moveTo(60, boxY + 62).lineTo(540, boxY + 62).stroke();
    doc.y = boxY + boxHeight + 45;

    doc.fontSize(10).font('Helvetica-Bold').fillColor('#000');
    doc.text(`Exam: ${examMeta.type || ''} - ${examMeta.subject || ''}`, { align: 'center' });
    doc.text(`Session: ${meta.session || ""}`, { align: 'center' });
    doc.moveDown(0.4);

    // Student photo, top right
    if (student.photo) {
      try {
        const photoFull = resolveLocalPath(student.photo);
        if (photoFull && fs.existsSync(photoFull)) {
          doc.image(photoFull, 460, doc.y - 5, { width: 70, height: 70 });
        }
      } catch {}
    }

    doc.fontSize(9).font('Helvetica');
    const infoY = doc.y;
    fitSingleLine(doc, `Name: ${student.name || ''}`, 60, infoY, 380, { startSize: 9, minSize: 6.5, font: 'Helvetica' });
    fitSingleLine(doc, `Class: ${student.classId || ''}`, 60, infoY + 13, 380, { startSize: 9, minSize: 6.5, font: 'Helvetica' });
    doc.text(`Admission No: ${student.id || ''}`, 60, infoY + 26);
    doc.text(`Submitted at: ${dayjs().format('YYYY-MM-DD HH:mm:ss')}`, 60, infoY + 39);
    doc.y = infoY + 56;

    // ---- Compact two-column question grid ----
    const usableLeft = 60;
    const usableRight = doc.page.width - 60;
    const gap = 20;
    const colWidth = (usableRight - usableLeft - gap) / 2;
    const col1X = usableLeft;
    const col2X = usableLeft + colWidth + gap;

    let colY = [doc.y, doc.y]; // independent cursor per column
    const bottomLimit = doc.page.height - 90;

    // Estimates how tall drawQuestionBlock will actually make this
    // question, accounting for wrapped question text, the options
    // line, the answer line, and a possible image — used to decide
    // whether a question fits BEFORE drawing it, not after.
    function measureQuestionBlock(q, width, fullWidth) {
      const textWidth = width - (fullWidth && q.image ? 100 : 0);
      let height = measureWrappedHeight(doc, `1. ${q.text}`, textWidth, 8.5, 'Helvetica-Bold');
      if (q.image) height = Math.max(height, 82);
      const optionsLine = `Options: ${(q.options || []).join(' | ')}`;
      height += 2 + measureWrappedHeight(doc, optionsLine, width, 7.5, 'Helvetica');
      height += 1 + measureWrappedHeight(doc, 'Correct: X   Answer: X', width, 7.5, 'Helvetica-Bold');
      return height + 6; // matches the small gap drawQuestionBlock adds after itself
    }

    (examMeta.items || []).forEach((q, i) => {
      const hasImage = !!q.image;

      // A question with an image takes the full row width, so it
      // always starts a fresh row rather than sharing a column pair.
      if (hasImage) {
        const rowY = Math.max(colY[0], colY[1]);
        const estimatedHeight = measureQuestionBlock(q, usableRight - usableLeft, true);
        if (rowY + estimatedHeight > bottomLimit) {
          doc.addPage();
          colY = [doc.y, doc.y];
        }
        const y = Math.max(colY[0], colY[1]);
        drawQuestionBlock(doc, q, i, usableLeft, y, usableRight - usableLeft, true);
        const used = doc.y - y;
        colY = [y + used, y + used];
        return;
      }

      // Pick whichever column currently has more room (the shorter one)
      const col = colY[0] <= colY[1] ? 0 : 1;
      const x = col === 0 ? col1X : col2X;
      let y = colY[col];

      const estimatedHeight = measureQuestionBlock(q, colWidth, false);
      if (y + estimatedHeight > bottomLimit) {
        doc.addPage();
        colY = [doc.y, doc.y];
        y = colY[col];
      }

      drawQuestionBlock(doc, q, i, x, y, colWidth, false);
      colY[col] = doc.y;
    });

    doc.y = Math.max(colY[0], colY[1]) + 10;
    if (doc.y > doc.page.height - 70) doc.addPage();

    const perc = examMeta.total ? ((examMeta.score / examMeta.total) * 100).toFixed(2) : 0;
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(11)
      .text(`Score: ${examMeta.score || 0} / ${examMeta.total || 0} (${perc}%)`, 60);

    const generatedText = `Generated by ${meta.schoolName || 'School'} Portal - ${dayjs().format('YYYY-MM-DD')}`;
    doc.fontSize(8).fillColor('#444').text(generatedText, 60, doc.y + 10);

    doc.end();
    stream.on('finish', () => callback && callback(null, outPath));
    stream.on('error', (err) => callback && callback(err));
  } catch (err) {
    callback && callback(err);
  }
}

// Draws one question block at (x, y) within the given width, and
// leaves doc.y positioned right after it (used to measure block height).
function drawQuestionBlock(doc, q, i, x, y, width, fullWidth) {
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000');
  doc.text(`${i + 1}. ${q.text}`, x, y, { width: width - (fullWidth && q.image ? 100 : 0) });
  let afterTextY = doc.y;

  if (q.image) {
    try {
      const imgPath = resolveLocalPath(q.image);
      if (imgPath && fs.existsSync(imgPath)) {
        doc.image(imgPath, x + width - 90, y, { width: 80, height: 80 });
        afterTextY = Math.max(afterTextY, y + 82);
      }
    } catch {}
  }

  const correct = q.answer || '';
  const given = q.studentAnswer || '';
  const mark = given && correct && given === correct ? '✓' : (given ? '✗' : '');

  doc.font('Helvetica').fontSize(7.5).fillColor('#000');
  doc.text(`Options: ${(q.options || []).join(' | ')}`, x, afterTextY + 2, { width });
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#000');
  doc.text(`Correct: ${correct}   Answer: ${given} ${mark}`, x, doc.y + 1, { width });
  doc.fillColor('#000');

  doc.y = doc.y + 6; // small gap before next block
}

// ======================================================
// CONSOLIDATED RESULT PDF — new for the Parent Portal redesign.
//
// Before this, every single CBT submission created its own brand new
// PDF file, so a student with 4 subjects each sitting Test 1, Test 2,
// Test 3, and the Exam could accumulate 16+ separate files over a
// term, all showing up loose in the parent portal. This generates
// exactly ONE persistent file per category — "Tests" (Test 1-3 across
// every subject) or "Exam" (the exam score across every subject) —
// and the caller overwrites the same fixed path every time, so a
// parent only ever sees one file per category, always up to date.
//
// Deliberately a summary table (subject + scores), not a full
// question-by-question review repeated for every subject — that
// would make a single document unmanageably long as more subjects
// get added, and a parent checking progress cares about the scores,
// not the exam transcript. The full question-level review PDF from
// each individual CBT sitting still exists separately if that level
// of detail is ever needed.
function generateConsolidatedResultPDF(meta, student, category, subjectRows, average, outPath, callback) {
  try {
    ensureDir(path.dirname(outPath));
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    const margin = 40;
    doc.fillColor('#000').opacity(1);
    doc.lineWidth(1).strokeColor('#999');
    doc.rect(margin, margin, doc.page.width - margin * 2, doc.page.height - margin * 2).stroke();

    const logoPath = resolveLocalPath(meta.logo);
    if (logoPath && fs.existsSync(logoPath)) {
      try { doc.image(logoPath, doc.page.width / 2 - 20, 45, { width: 40, height: 40 }); } catch {}
    }

    const title = meta.schoolName || 'School Name';
    doc.fontSize(14).font('Helvetica-Bold');
    const boxWidth = Math.min(doc.widthOfString(title) + 60, doc.page.width - 120);
    const boxX = (doc.page.width - boxWidth) / 2;
    const boxY = 95;
    const boxHeight = 22;
    doc.rect(boxX, boxY, boxWidth, boxHeight).stroke();
    fitSingleLine(doc, title, 0, boxY + 5, doc.page.width, { startSize: 14, minSize: 8, font: 'Helvetica-Bold', align: 'center' });

    doc.fontSize(8).font('Helvetica').fillColor('#333');
    fitSingleLine(doc, `Address: ${meta.address || ''}`, 0, boxY + 28, doc.page.width, { startSize: 8, minSize: 6, font: 'Helvetica', align: 'center' });
    fitSingleLine(doc, `Term: ${meta.term || ''}   Session: ${meta.session || ''}`, 0, boxY + 39, doc.page.width, { startSize: 8, minSize: 6, font: 'Helvetica', align: 'center' });
    doc.moveTo(60, boxY + 52).lineTo(540, boxY + 52).stroke();

    doc.fontSize(12).font('Helvetica-Bold').fillColor('#000');
    fitSingleLine(doc, `${category.toUpperCase()} SUMMARY`, 0, boxY + 62, doc.page.width, { startSize: 12, minSize: 8, font: 'Helvetica-Bold', align: 'center' });

    // Student photo, top right — uses the real field name (`photo`),
    // not the non-existent `photoPath` the per-submission generator
    // was checking above.
    if (student.photo) {
      try {
        const photoFull = resolveLocalPath(student.photo);
        if (photoFull && fs.existsSync(photoFull)) {
          doc.image(photoFull, 460, boxY + 85, { width: 65, height: 65 });
        }
      } catch {}
    }

    doc.fontSize(9).font('Helvetica').fillColor('#000');
    const infoY = boxY + 90;
    fitSingleLine(doc, `Name: ${student.name || ''}`, 60, infoY, 380, { startSize: 9, minSize: 6.5, font: 'Helvetica' });
    fitSingleLine(doc, `Class: ${student.classId || ''}`, 60, infoY + 14, 380, { startSize: 9, minSize: 6.5, font: 'Helvetica' });
    doc.text(`Admission No: ${student.id || ''}`, 60, infoY + 28);
    doc.text(`Last updated: ${dayjs().format('YYYY-MM-DD HH:mm')}`, 60, infoY + 42);

    let y = infoY + 75;
    doc.font('Helvetica-Bold').fontSize(10);

    if (category === 'Tests') {
      const colX = [60, 260, 330, 400, 470];
      const headers = ['Subject', 'Test 1', 'Test 2', 'Test 3', 'Total'];
      headers.forEach((h, i) => doc.text(h, colX[i], y));
      y += 18;
      doc.font('Helvetica').fontSize(9.5);
      subjectRows.forEach((row) => {
        fitSingleLine(doc, row.subjectName, colX[0], y, 190, { startSize: 9.5, minSize: 7, font: 'Helvetica' });
        doc.text(row.test1 ?? '—', colX[1], y);
        doc.text(row.test2 ?? '—', colX[2], y);
        doc.text(row.test3 ?? '—', colX[3], y);
        doc.font('Helvetica-Bold').text(String(row.total ?? 0), colX[4], y);
        doc.font('Helvetica');
        y += 18;
      });
    } else {
      const colX = [60, 320, 430];
      const headers = ['Subject', 'Exam Score', 'Percentage'];
      headers.forEach((h, i) => doc.text(h, colX[i], y));
      y += 18;
      doc.font('Helvetica').fontSize(9.5);
      subjectRows.forEach((row) => {
        fitSingleLine(doc, row.subjectName, colX[0], y, 250, { startSize: 9.5, minSize: 7, font: 'Helvetica' });
        doc.text(row.examScore ?? '—', colX[1], y);
        doc.font('Helvetica-Bold').text(row.percentage !== null ? `${row.percentage}%` : '—', colX[2], y);
        doc.font('Helvetica');
        y += 18;
      });
    }

    y += 12;
    doc.moveTo(60, y).lineTo(540, y).strokeColor('#999').stroke();
    y += 12;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000');
    doc.text(`Overall ${category} Average: ${average !== null ? average.toFixed(1) : '—'}`, 60, y);

    doc.end();
    stream.on('finish', () => callback(null));
    stream.on('error', (err) => callback(err));
  } catch (err) {
    callback(err);
  }
}

module.exports = { generateExamPDF, generateConsolidatedResultPDF };
