const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

// One class per starting page (a class that overflows a page continues
// onto the next, without starting a fresh page for every class if it
// fits) — ID, name, and each student's freshly-generated plaintext CBT
// password, with the principal's signature at the end of each class's
// list. Deliberately generated to a temp file and streamed straight to
// the browser by the caller — this document contains every listed
// student's live plaintext password, so it must never be persisted to
// Supabase Storage the way most other generated PDFs in this app are.
//
// meta.signaturePrincipal is expected to already be resolved to a real
// local file (or Supabase URL, checked defensively either way) by the
// caller, via withResolvedImages() — same pattern as every other
// generator in this app.
function generateCBTCredentialsPDF(meta, classesWithStudents, outputPath, callback) {
  try {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const pageBottom = doc.page.height - 90;
    const colNo = 40;
    const colId = 80;
    const colName = 175;
    const colPassword = 430;

    function drawTableHeader(y) {
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#1a1a1a");
      doc.text("No.", colNo, y);
      doc.text("Student ID", colId, y);
      doc.text("Name", colName, y);
      doc.text("Password", colPassword, y);
      doc.moveTo(40, y + 14).lineTo(555, y + 14).strokeColor("#999").stroke();
      return y + 22;
    }

    classesWithStudents.forEach((cls, classIndex) => {
      if (classIndex > 0) doc.addPage();

      doc.font("Helvetica-Bold").fontSize(14).fillColor("#1a1a1a")
        .text(meta.schoolName || "School", { align: "center" });
      doc.font("Helvetica").fontSize(9).fillColor("#a33")
        .text("CBT LOGIN CREDENTIALS — CONFIDENTIAL, KEEP SECURE", { align: "center" });
      doc.moveDown(0.4);
      doc.font("Helvetica-Bold").fontSize(12).fillColor("#000")
        .text(`Class: ${cls.className}`, 40);
      doc.moveDown(0.3);

      let y = drawTableHeader(doc.y);
      doc.font("Helvetica").fontSize(9).fillColor("#000");

      cls.students.forEach((s, i) => {
        if (y > pageBottom) {
          doc.addPage();
          doc.font("Helvetica-Bold").fontSize(10).fillColor("#000")
            .text(`Class: ${cls.className} (continued)`, 40, 40);
          y = drawTableHeader(70);
          doc.font("Helvetica").fontSize(9).fillColor("#000");
        }
        doc.text(String(i + 1), colNo, y);
        doc.text(s.id, colId, y);
        doc.text(s.name, colName, y, { width: 245 });
        doc.font("Helvetica-Bold").text(s.password, colPassword, y);
        doc.font("Helvetica");
        y += 18;
      });

      // Principal signature at the end of this class's list — if it
      // wouldn't fit on the current page, start a fresh one for it.
      if (y > pageBottom - 40) {
        doc.addPage();
        y = 60;
      }
      y += 30;

      const principalRaw = meta.signaturePrincipal || "/uploads/principal_signature.png";
      const pSig = fs.existsSync(principalRaw)
        ? principalRaw
        : path.join(__dirname, "..", "public", principalRaw.replace(/^\//, ""));
      if (fs.existsSync(pSig)) {
        doc.image(pSig, colPassword - 30, y, { width: 80, height: 40 });
      }
      doc.moveTo(colPassword - 30, y + 45).lineTo(colPassword + 70, y + 45).strokeColor("#000").stroke();
      doc.font("Helvetica").fontSize(8).fillColor("#000")
        .text("Principal's Signature", colPassword - 30, y + 48);
    });

    doc.end();
    stream.on("finish", () => callback(null));
    stream.on("error", (err) => callback(err));
  } catch (err) {
    callback(err);
  }
}

module.exports = { generateCBTCredentialsPDF };
