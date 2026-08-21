// utils/pdfTextFit.js
//
// Shared helpers so every PDF generator handles unexpectedly long
// text the same, safe way, without needing a code change every time
// someone has a longer name, address, or remark than whoever wrote
// the original layout happened to test with.
//
// Two different problems, two different tools:
//
//  1. A field that MUST stay on one line (a name in a table row, an
//     ID card label, a receipt line) — shrink the font size step by
//     step until it fits the box, and only as an absolute last
//     resort (even the minimum size still doesn't fit) truncate with
//     an ellipsis. Use fitSingleLine() for these.
//
//  2. A field that's ALLOWED to wrap onto more than one line (a
//     remark, a question's own text, a comment) — the risk there
//     isn't overflow sideways, it's the next element below silently
//     overlapping it because the caller assumed a fixed height. Use
//     measureWrappedHeight() to ask PDFKit how tall the text will
//     actually be BEFORE drawing whatever comes next.

/**
 * Draws `text` inside a box exactly `maxWidth` wide, on one line,
 * shrinking the font size in small steps if needed so it actually
 * fits, then truncating with "…" only if it still doesn't fit even
 * at the smallest allowed size.
 */
function fitSingleLine(doc, text, x, y, maxWidth, opts = {}) {
  const {
    font = "Helvetica",
    startSize = 10,
    minSize = 6.5,
    step = 0.5,
    align = "left",
  } = opts;

  const value = String(text ?? "");
  doc.font(font);

  let size = startSize;
  while (size > minSize && doc.fontSize(size).widthOfString(value) > maxWidth) {
    size -= step;
  }

  let toDraw = value;
  doc.fontSize(size);
  if (doc.widthOfString(toDraw) > maxWidth) {
    // Even the smallest readable size doesn't fit — truncate rather
    // than let it run past the border or collide with the next column.
    while (toDraw.length > 1 && doc.widthOfString(toDraw + "…") > maxWidth) {
      toDraw = toDraw.slice(0, -1);
    }
    toDraw += "…";
  }

  doc.text(toDraw, x, y, { width: maxWidth, align, lineBreak: false });
  return size;
}

/**
 * Returns how tall `text` will actually render at the given width and
 * font size — call this before drawing, then advance your cursor by
 * the real number, not a guessed fixed row height.
 */
function measureWrappedHeight(doc, text, width, fontSize = 10, font = "Helvetica") {
  doc.font(font).fontSize(fontSize);
  return doc.heightOfString(String(text ?? ""), { width });
}

module.exports = { fitSingleLine, measureWrappedHeight };
