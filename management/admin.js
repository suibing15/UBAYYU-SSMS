// Admin Portal Logic (Toggles + Subjects/Questions + PDFs + Classes/Students + Timings)
// (Replace your existing admin.js with this file - keeps all original features but fixes class/subject population + uploads)


//////////////////////
// Helpers & startup
//////////////////////

// safe DOM elements
const classSelectorEl = document.getElementById('classSelector');
const subjectSelectorEl = document.getElementById('subjectSelector');

async function safeJson(resp) {
  try { return await resp.json(); } catch (e) { return null; }
}

//////////////////////
// TOGGLES (clean & stable)
//////////////////////

window.loadToggles = async function () {
  const metaResp = await fetch('/api/meta', { credentials: 'include' });
  if (!metaResp.ok) {
    alert('Failed to load meta');
    return;
  }

  const meta = await metaResp.json();
  const tDiv = document.getElementById('toggles');

  // Clear everything once (portal toggles own the container)
  tDiv.innerHTML = '';

  const toggles = meta.meta.portalToggles || {};

  Object.keys(toggles).forEach(k => {
    const row = document.createElement('div');
    row.className = 'list-item';

    const label = document.createElement('div');
    label.textContent = k;

    const btn = document.createElement('button');
    btn.textContent = toggles[k] ? 'ON' : 'OFF';

    btn.addEventListener('click', async () => {
      const res = await fetch('/api/admin/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ key: k, value: !toggles[k] })
      });

      const j = await res.json();
      if (j.success) {
        window.loadToggles();
      } else {
        alert(j.error || 'Error toggling');
      }
    });

    row.appendChild(label);
    row.appendChild(btn);
    tDiv.appendChild(row);
  });

  // Load test toggles AFTER portal toggles
  window.loadTestToggles();
};


window.loadTestToggles = async function () {
  const resp = await fetch('/api/admin/testToggles', { credentials: 'include' });
  if (!resp.ok) return;

  const body = await resp.json();
  const toggles = body.testToggles || {};
  const tDiv = document.getElementById('toggles');

  // 🔥 REMOVE previous test toggle section only
  const oldSection = tDiv.querySelector('.test-toggle-section');
  if (oldSection) oldSection.remove();

  // Create a dedicated wrapper (this is the key fix)
  const section = document.createElement('div');
  section.className = 'test-toggle-section';

  const divider = document.createElement('h4');
  divider.textContent = 'Test/Exam Toggles';
  section.appendChild(divider);

  Object.keys(toggles).forEach(k => {
    const row = document.createElement('div');
    row.className = 'list-item';

    const label = document.createElement('div');
    label.textContent = k.toUpperCase();

    const btn = document.createElement('button');
    btn.textContent = toggles[k] ? 'ON' : 'OFF';

    btn.addEventListener('click', async () => {
      await fetch('/api/admin/testToggles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ key: k, value: !toggles[k] })
      });

      // Re-render test toggles cleanly
      window.loadTestToggles();
    });

    row.appendChild(label);
    row.appendChild(btn);
    section.appendChild(row);
  });

  tDiv.appendChild(section);
};


//////////////////////
// UPLOAD LOGO / SIGNATURES (logo, principal signature, form master signature)
//////////////////////
document.querySelectorAll('.brandUploadForm').forEach(form => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = document.getElementById('brandUploadStatus');
    const fd = new FormData(form);
    const type = form.dataset.type; // logo | principal | formmaster

    try {
      // type goes in the URL (?type=...), not the form body — the
      // server needs it before it's finished reading the file itself,
      // and a query parameter is the only thing guaranteed to be
      // available that early.
      const r = await fetch(`/api/admin/upload?type=${encodeURIComponent(type)}`, {
        method: 'POST', body: fd, credentials: 'include'
      });
      const j = await r.json();
      if (j.success) {
        if (status) { status.style.color = 'var(--green)'; status.textContent = '✅ Uploaded: ' + j.path; }
        form.reset();
      } else {
        if (status) { status.style.color = 'var(--danger)'; status.textContent = '❌ ' + (j.error || 'Upload failed'); }
      }
    } catch {
      if (status) { status.style.color = 'var(--danger)'; status.textContent = '❌ Network error during upload.'; }
    }
  });
});

//////////////////////
// PDF LIST (unchanged)
//////////////////////
window.loadPdfs = async function () {
  const r = await fetch('/api/admin/pdfs', { credentials: 'include' });
  if (!r.ok) return;
  const j = await r.json();
  const pDiv = document.getElementById('pdfList');
  pDiv.innerHTML = '';
  (j.pdfs || []).forEach(p => {
    const row = document.createElement('div');
    row.className = 'list-item';
    row.innerHTML = `<div>${p.type} - ${p.studentId} - ${new Date(p.timestamp).toLocaleString()}</div>
      <div><a href="${p.filePath}" target="_blank">Open</a></div>`;
    pDiv.appendChild(row);
  });
};
//////////////////////
// CLASSES (populate list + selectors)
//////////////////////

window.loadClasses = async function () {
  const r = await fetch('/api/admin/classes', { credentials: 'include' });

  // If session expired, force login screen
  if (r.status === 401) {
    alert('Session expired — please login again');
    if (document.getElementById('loginPage')) {
      document.getElementById('loginPage').style.display = 'block';
    }
    if (document.getElementById('adminPanel')) {
      document.getElementById('adminPanel').style.display = 'none';
    }
    return;
  }

  if (!r.ok) {
    console.error('Failed loading classes:', r.status);
    return;
  }

  const j = await r.json();
  const cDiv = document.getElementById('classList');
  cDiv.innerHTML = '';

  if (typeof classSelectorEl !== 'undefined' && classSelectorEl) {
    classSelectorEl.innerHTML = `<option value="">-- Choose Class --</option>`;
  }
  if (typeof subjectSelectorEl !== 'undefined' && subjectSelectorEl) {
    subjectSelectorEl.innerHTML = `<option value="">-- Select Subject --</option>`;
  }

  (j.classes || []).forEach(c => {
    const row = document.createElement('div');
    row.className = 'list-item';
    row.innerHTML = `<div>${c.name} (${c.id})</div>`;
    const delBtn = document.createElement('button');
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => deleteClass(c.id));
    row.appendChild(delBtn);
    cDiv.appendChild(row);

    if (typeof classSelectorEl !== 'undefined' && classSelectorEl) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name} (${c.id})`;
      classSelectorEl.appendChild(opt);
    }
  });
};

// ===== ADD CLASS (OFFLINE-SAFE) =====
document.getElementById("addClassForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const fd = new FormData(e.target);

  const id = fd.get("id").trim();
  const name = fd.get("name").trim();
  const password = fd.get("password")?.trim() || "";

  const payload = { id, name, password };

const response = await fetch("/api/admin/class", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const result = await response.json();


  // If saved offline
  if (result?.offline) {
    alert("No internet. Class saved offline and will sync automatically.");
    return;
  }

  // Normal online response
  if (result?.success) {
    alert("Class added successfully");
    window.loadClasses();
  } else {
    alert(result?.error || "Failed to add class");
  }
});

//////////////////////
// SUBJECTS & QUESTIONS (class-wise only)
//////////////////////
window.loadSubjects = async function (classId = null) {
  if (!classId) {
    console.warn("No class selected for subject loading.");
    return;
  }

  let r;
  try {
    r = await fetch(
      `/api/admin/subjects?classId=${encodeURIComponent(classId)}`,
      { credentials: "include" }
    );
  } catch (err) {
    console.error("Network error loading subjects", err);
    return;
  }

  if (!r.ok) {
    console.error("Failed to fetch subjects");
    return;
  }

  const j = await r.json();
  const subjects = j.subjects || [];

  const sDiv = document.getElementById("subjectsList");
  if (!sDiv) {
    console.error("subjectsList container not found");
    return;
  }
  sDiv.innerHTML = "";

  if (typeof subjectSelectorEl !== "undefined" && subjectSelectorEl) {
    subjectSelectorEl.innerHTML =
      `<option value="">-- Select Subject --</option>`;
  }

  subjects.forEach(subj => {
    // ================= WRAPPER =================
    const wrapper = document.createElement("div");
    wrapper.className = "subject-block";
    wrapper.style.cssText =
      "border:1px solid #ddd;padding:10px;margin-bottom:12px;border-radius:6px;background:#f9f9f9";

    // ================= HEADER =================
    if (typeof subjectSelectorEl !== "undefined" && subjectSelectorEl) {
      const opt = document.createElement("option");
      opt.value = subj.id;
      opt.textContent = `${subj.name} (${subj.id}) — Class: ${subj.classId}`;
      subjectSelectorEl.appendChild(opt);
    }

    const header = document.createElement("div");
    header.innerHTML = `<b>${subj.name} (${subj.id}) — Class: ${subj.classId}</b>`;

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "Delete Subject";
    delBtn.onclick = async () => {
      if (!confirm(`Delete subject ${subj.name}?`)) return;
      await fetch(
        `/api/admin/subject/${subj.id}?classId=${encodeURIComponent(subj.classId)}`,
        { method: "DELETE", credentials: "include" }
      );
      window.loadSubjects(classId);
    };

    header.appendChild(delBtn);
    wrapper.appendChild(header);

    // ================= TIMING FORM (FIX) =================
    const timingForm = document.createElement("form");
    timingForm.innerHTML = `
      <hr>
      <b>Set Timings (minutes)</b><br>
      <input type="number" name="test1" placeholder="Test 1" value="${subj.timeLimits?.test1 ?? 30}">
      <input type="number" name="test2" placeholder="Test 2" value="${subj.timeLimits?.test2 ?? 30}">
      <input type="number" name="test3" placeholder="Test 3" value="${subj.timeLimits?.test3 ?? 30}">
      <input type="number" name="exam"  placeholder="Exam"  value="${subj.timeLimits?.exam  ?? 60}">
      <button type="submit">Save Timings</button>
    `;

    timingForm.onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(timingForm);

      await fetch("/api/admin/subject/timings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          subjectId: subj.id,
          classId: subj.classId,
          timings: {
            test1: Number(fd.get("test1")) || 30,
            test2: Number(fd.get("test2")) || 30,
            test3: Number(fd.get("test3")) || 30,
            exam:  Number(fd.get("exam"))  || 60
          }
        })
      });

      alert("Timings updated successfully");
      window.loadSubjects(classId);
    };

    wrapper.appendChild(timingForm);

    // ================= QUESTIONS =================
    const qContainer = document.createElement("div");
    qContainer.style.marginTop = "10px";

    ["test1", "test2", "test3", "exam"].forEach(type => {
      const qList = (subj.questions && subj.questions[type]) || [];
      const qBlock = document.createElement("div");
      qBlock.style.marginTop = "8px";

      const title = document.createElement("h4");
      title.textContent = type.toUpperCase() + " QUESTIONS";
      title.style.color = "#004080";
      qBlock.appendChild(title);

      if (!qList.length) {
        const none = document.createElement("div");
        none.textContent = "(No questions yet)";
        none.style.color = "#666";
        qBlock.appendChild(none);
      } else {
        qList.forEach(q => {
          const qRow = document.createElement("div");
          qRow.style.cssText =
            "border-bottom:1px solid #ddd;padding:5px 0";

          qRow.innerHTML = `
            <div><b>${q.qid}:</b> ${q.text}</div>
            ${q.image ? `<img src="${q.image}" style="max-width:200px;margin:5px 0">` : ""}
            <div><i>Options:</i> ${Array.isArray(q.options) ? q.options.join(", ") : q.options}</div>
            <div><i>Answer:</i> ${q.answer}</div>
            <div><i>Marks:</i> ${q.marks}</div>
          `;

          const delQBtn = document.createElement("button");
          delQBtn.textContent = "Delete Question";
          delQBtn.onclick = async () => {
            if (!confirm(`Delete question ${q.qid}?`)) return;
            await fetch(
              `/api/admin/question/${subj.id}/${q.qid}/${subj.classId}`,
              { method: "DELETE", credentials: "include" }
            );
            window.loadSubjects(classId);
          };

          qRow.appendChild(delQBtn);
          qBlock.appendChild(qRow);
        });
      }

      qContainer.appendChild(qBlock);
    });

    wrapper.appendChild(qContainer);
    sDiv.appendChild(wrapper);
 

    // ================= ADD QUESTION =================
    const qForm = document.createElement("form");
    qForm.enctype = "multipart/form-data";
    qForm.innerHTML = `
      <hr><b>Add New Question</b><br>
      <select name="type" required>
        <option value="">Select Type</option>
        <option value="test1">Test 1</option>
        <option value="test2">Test 2</option>
        <option value="test3">Test 3</option>
        <option value="exam">Exam</option>
      </select>
      <input name="qid" placeholder="Question ID" required>
      <input name="text" placeholder="Question Text" required>
      <input name="options" placeholder="Options (comma separated)" required>
      <input name="answer" placeholder="Answer" required>
      <input name="marks" type="number" value="1">
      <input type="file" name="image" accept="image/*">
      <button type="submit">Add Question</button>
    `;

    qForm.onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(qForm);
      fd.append("subjectId", subj.id);
      fd.append("classId", subj.classId);
      fd.set("type", String(fd.get("type")).toLowerCase());

      await fetch("/api/admin/question", {
        method: "POST",
        body: fd,
        credentials: "include"
      });

      window.loadSubjects(classId);
    };

    wrapper.appendChild(qForm);

    // ================= BULK UPLOAD QUESTIONS (CSV/Excel + optional images) =================
    const csvForm = document.createElement("form");
    csvForm.enctype = "multipart/form-data";
    csvForm.innerHTML = `
      <hr><b>Bulk Upload Questions (CSV, TSV, or Excel)</b><br>
      <input type="file" name="csv" accept=".csv,.tsv,.txt,.xlsx,.xls" required>
      <div style="font-size:12px;color:#555;margin-top:4px;">
        Columns: Type, QuestionID, QuestionText, Options, Answer, Mark, and optionally Image (a filename, e.g. "q5_diagram.png").
      </div>
      <label style="display:block;margin-top:8px;">Pictures for this batch (optional, pick as many as you need at once):</label>
      <input type="file" name="images" accept="image/*" multiple>
      <div style="font-size:12px;color:#555;margin-top:4px;">
        Each picture's filename must exactly match what you typed in the sheet's "Image" column for that question.
      </div>
      <button type="submit" style="margin-top:8px;">Upload</button>
      <div id="bulkUploadStatus_${subj.id}_${subj.classId}" style="font-size:13px;margin-top:6px;"></div>
    `;

    csvForm.onsubmit = async e => {
      e.preventDefault();
      const statusEl = csvForm.querySelector(`#bulkUploadStatus_${subj.id}_${subj.classId}`);
      const fd = new FormData(csvForm);
      fd.append("subjectId", subj.id);
      fd.append("classId", subj.classId);

      if (statusEl) { statusEl.style.color = "#555"; statusEl.textContent = "Uploading…"; }

      try {
        const res = await fetch("/api/admin/questions/bulk-upload", {
          method: "POST",
          body: fd,
          credentials: "include"
        });

        const out = await res.json();

        if (out.success) {
          let msg = `✅ ${out.added} question(s) added`;
          if (out.skipped) msg += `, ${out.skipped} skipped`;
          if (out.imagesAttached) msg += `, ${out.imagesAttached} picture(s) attached`;
          if (out.unmatchedImages && out.unmatchedImages.length) {
            msg += `. ⚠ These uploaded pictures didn't match any row's Image column: ${out.unmatchedImages.join(", ")}`;
          }
          if (statusEl) { statusEl.style.color = "green"; statusEl.textContent = msg; }
        } else {
          if (statusEl) { statusEl.style.color = "red"; statusEl.textContent = "❌ " + (out.error || "Upload failed"); }
        }
      } catch (err) {
        if (statusEl) { statusEl.style.color = "red"; statusEl.textContent = "❌ Network error during upload."; }
      }

      window.loadSubjects(classId);
    };

    wrapper.appendChild(csvForm);

    // ================= ACTION BUTTONS =================
    const pdfBtn = document.createElement("button");
    pdfBtn.type = "button";
    pdfBtn.textContent = "Generate Question PDF";
    pdfBtn.onclick = async () => {
      let type = prompt("Enter type (test1/test2/test3/exam)");
      if (!type) return;
      type = type.toLowerCase();

      const r = await fetch(
        `/api/admin/questions/pdf?classId=${subj.classId}&subjectId=${subj.id}&type=${type}`,
        { credentials: "include" }
      );

      const j = await r.json();
      if (j.file) window.open(j.file, "_blank");
      else alert(j.error || "Failed to generate PDF");
    };

    const forwardBtn = document.createElement("button");
    forwardBtn.type = "button";
    forwardBtn.textContent = "Forward Questions";
    forwardBtn.onclick = async () => {
      const toClass = prompt("Enter target class ID");
      if (!toClass) return;

      await fetch("/api/admin/questions/forward", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          fromClass: subj.classId,
          toClass,
          subjectId: subj.id
        })
      });

      alert("Questions forwarded");
      window.loadSubjects(classId);
    };

    wrapper.appendChild(pdfBtn);
    wrapper.appendChild(forwardBtn);

    // ================= FINAL APPEND =================
    sDiv.appendChild(wrapper);
  });
};


//////////////////////
// ADD SUBJECT (class-wise)
//////////////////////
document.addEventListener("DOMContentLoaded", () => {
  const addSubjectForm = document.getElementById("addSubjectForm");
  const classSelectorEl = document.getElementById("classSelector");

  if (!addSubjectForm) {
    console.warn("addSubjectForm not found");
    return;
  }

  addSubjectForm.addEventListener("submit", async e => {
    e.preventDefault(); // 🚫 stop page refresh

    const fd = new FormData(addSubjectForm);
    const classIdVal = classSelectorEl?.value;

    if (!classIdVal) {
      alert("Please select a class first");
      return;
    }

    try {
      const res = await fetch("/api/admin/subject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          id: fd.get("id"),
          name: fd.get("name"),
          classId: classIdVal
        })
      });

      const j = await res.json();

      if (j && j.success) {
        addSubjectForm.reset();
        window.loadSubjects(classIdVal); // 🔁 refresh subject list
      } else {
        alert(j.error || "Failed to add subject");
      }
    } catch (err) {
      console.error("Add subject error:", err);
      alert("Network error while adding subject");
    }
  });
});


//////////////////////
// STUDENTS (unchanged)
//////////////////////
window.allStudentsCache = []; // [{cls, students}] — cached so search can filter instantly without re-fetching

window.loadStudents = async function () {
  const r = await fetch('/api/admin/classes', { credentials: 'include' });
  if (!r.ok) return;
  const j = await r.json();
  window.allStudentsCache = [];

  for (const cls of (j.classes || [])) {
    const r2 = await fetch(`/api/admin/class/${cls.id}/students`, { credentials: 'include' });
    if (!r2.ok) continue;
    const j2 = await r2.json();
    window.allStudentsCache.push({ cls, students: j2.students || [] });
  }

  renderStudentList();
};

function renderStudentList() {
  const query = (document.getElementById('studentSearchInput')?.value || '').trim().toLowerCase();
  const sDiv = document.getElementById('studentList');
  if (!sDiv) return;
  sDiv.innerHTML = '';

  for (const { cls, students } of window.allStudentsCache) {
    const filtered = query
      ? students.filter(st =>
          (st.name || '').toLowerCase().includes(query) ||
          (st.id || '').toLowerCase().includes(query))
      : students;

    if (query && !filtered.length) continue; // hide empty classes while searching

    const block = document.createElement('div');
    block.innerHTML = `<h4>${cls.name} (${cls.id})</h4>`;

    filtered.forEach(st => {
      const row = document.createElement('div');
      row.className = 'list-item';
      row.innerHTML = `<div>${st.name} (${st.id})</div>`;

      // ✅ Single ID card button (unchanged)
      const idBtn = document.createElement('button');
      idBtn.textContent = "Generate ID Card";
      idBtn.addEventListener("click", async () => {
        try {
          const res = await fetch(`/api/admin/idcard/${st.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: 'include'
          });
          if (!res.ok) {
            const errText = await res.text();
            console.error("❌ Server error:", errText);
            alert("Failed to generate ID card: " + errText);
            return;
          }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${st.id}_idcard.pdf`;
          a.click();
          URL.revokeObjectURL(url);
        } catch (err) {
          console.error("❌ Frontend Error:", err);
          alert("Error generating ID card");
        }
      });

      const delBtn = document.createElement('button');
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => deleteStudent(st.id));

      row.appendChild(idBtn);
      row.appendChild(delBtn);
      block.appendChild(row);
    });
    sDiv.appendChild(block);
  }
}

document.getElementById('studentSearchInput')?.addEventListener('input', renderStudentList);

const deleteAllStudentsBtn = document.getElementById('deleteAllStudentsBtn');
if (deleteAllStudentsBtn) {
  deleteAllStudentsBtn.onclick = async () => {
    if (!confirm("This deletes EVERY student in the school, from every class. This cannot be undone. Continue?")) return;
    if (!confirm("Are you absolutely sure? Click OK only if you really want to delete all students now.")) return;

    try {
      const res = await fetch('/api/admin/students/all', { method: 'DELETE', credentials: 'include' });
      const j = await res.json();
      if (j.success) {
        alert(`✅ Deleted ${j.deleted} students.`);
        window.loadStudents();
      } else {
        alert("❌ " + (j.error || "Failed to delete students."));
      }
    } catch {
      alert("❌ Network error while deleting students.");
    }
  };
}

document.getElementById('addStudentForm').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(addStudentForm);
  const res = await fetch('/api/admin/student', { method: 'POST', body: fd, credentials: 'include' });
  const j = await res.json();

  if (j.success && j.generatedPassword) {
    const studentId = fd.get('id');
    if (confirm(
      `Student added.\n\nLogin password: ${j.generatedPassword}\n\n` +
      `Write this down now, it can't be shown again later.\n\n` +
      `Generate this student's ID card now?`
    )) {
      const cardRes = await fetch(`/api/admin/idcard/${encodeURIComponent(studentId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ plainPassword: j.generatedPassword })
      });
      const cardJ = await cardRes.json();
      if (cardJ.file) window.open(cardJ.file, '_blank');
    }
  }

  window.loadStudents();
};

//////////////////////
// BULK UPLOAD STUDENTS (CSV/Excel + optional photos)
//////////////////////
document.getElementById('bulkStudentForm').onsubmit = async (e) => {
  e.preventDefault();
  const form = e.target;
  const statusEl = document.getElementById('bulkStudentStatus');
  const fd = new FormData(form);

  if (statusEl) { statusEl.style.color = '#555'; statusEl.textContent = 'Uploading…'; }

  try {
    const res = await fetch('/api/admin/students/bulk-upload', {
      method: 'POST',
      body: fd,
      credentials: 'include'
    });
    const j = await res.json();

    if (j.success) {
      let msg = `✅ ${j.added} student(s) added`;
      if (j.skipped) msg += `, ${j.skipped} skipped`;
      if (j.imagesAttached) msg += `, ${j.imagesAttached} photo(s) attached`;
      if (statusEl) { statusEl.style.color = 'green'; statusEl.textContent = msg; }

      if (j.unmatchedImages && j.unmatchedImages.length) {
        alert(`These uploaded photos didn't match any row's Image column: ${j.unmatchedImages.join(', ')}`);
      }
      if (j.skipReasons && j.skipReasons.length) {
        alert(j.skipReasons.join('\n'));
      }
      if (j.credentials && j.credentials.length) {
        const lines = j.credentials.map(c => `${c.name} (${c.id}): ${c.password}`).join('\n');
        alert(`Write these down now, they won't be shown again:\n\n${lines}`);
      }

      form.reset();
      window.loadStudents();
    } else {
      if (statusEl) { statusEl.style.color = 'red'; statusEl.textContent = '❌ ' + (j.error || 'Upload failed'); }
    }
  } catch {
    if (statusEl) { statusEl.style.color = 'red'; statusEl.textContent = '❌ Network error during upload.'; }
  }
};

//////////////////////
// Delete helpers
//////////////////////
async function deleteSubject(id, classId = '') {
  if (!confirm('Delete subject ' + id + '?')) return;
  const url = classId 
    ? `/api/admin/subject/${encodeURIComponent(id)}?classId=${encodeURIComponent(classId)}` 
    : `/api/admin/subject/${encodeURIComponent(id)}`;
  await fetch(url, { method: 'DELETE', credentials: 'include' });
  const sel = classSelectorEl ? classSelectorEl.value : null;
  window.loadSubjects(sel || null);
}

async function deleteClass(id) {
  if (!confirm('Delete class ' + id + '? This will also remove its students.')) return;
  await fetch('/api/admin/class/' + id, { method: 'DELETE', credentials: 'include' });
  window.loadClasses();
  window.loadStudents();
}

async function deleteStudent(id) {
  if (!confirm('Delete student ' + id + '?')) return;
  await fetch('/api/admin/student/' + id, { method: 'DELETE', credentials: 'include' });
  window.loadStudents();
}

////////////////////////////////////////////////
// ✅ BULK ID CARD SECTION — FIXED
////////////////////////////////////////////////

// ❌ REMOVE the auto-load on page load
// window.addEventListener("DOMContentLoaded", loadClassesForBulkID);

// ✅ Call this AFTER login when admin dashboard shows
async function loadClassesForBulkID() {
  try {
    const res = await fetch('/api/admin/classes', { credentials: 'include' });

    if (!res.ok) {
      console.warn("⚠️ Admin not logged in — bulk ID classes not loaded yet");
      return;
    }

    const data = await res.json();
    const classes = data.classes || [];

    const classSelect = document.getElementById("bulkClassSelect");
    if (!classSelect) return;

    classSelect.innerHTML = `<option value="">-- Select Class --</option>`;

    classes.forEach(c => {
      const opt = document.createElement("option");
      opt.value = c.id.trim();
      opt.textContent = `${c.id} — ${c.name}`;
      classSelect.appendChild(opt);
    });

    console.log("✅ Bulk ID classes loaded:", classes);

  } catch (err) {
    console.error("❌ Load bulk ID classes failed", err);
  }
}


// ✅ Bulk ID Generate Click Handler (FIXED VERSION)
const bulkBtn = document.getElementById("bulkIdGenerateBtn");

if (bulkBtn) {
  bulkBtn.addEventListener("click", async (e) => {
    e.preventDefault();

    const classId = document.getElementById("bulkClassSelect").value;
    const statusBar = document.getElementById("bulkIdStatus");

    if (!classId) {
      statusBar.style.background = "#ffdddd";
      statusBar.textContent = "⚠️ Select a class first.";
      return;
    }

    statusBar.style.background = "#fff3cd";
    statusBar.textContent = "⏳ Generating ID cards...";

    try {
      const res = await fetch(
        `/api/admin/idcards/class/${encodeURIComponent(classId)}`,
        {
          method: "POST",
          credentials: "include"
        }
      );

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(errorText);
      }

      // 🔥 IMPORTANT: get as BLOB (PDF file)
      const blob = await res.blob();

      // Create download link
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Bulk_ID_Cards_${classId}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

      statusBar.style.background = "#d4edda";
      statusBar.textContent = `✅ ID cards downloaded successfully for ${classId}`;

    } catch (err) {
      console.error("Bulk ID card error:", err);
      statusBar.style.background = "#ffdddd";
      statusBar.textContent = "❌ Failed to generate ID cards.";
    }
  });
}

//////////////////////
// LOGIN (unchanged)
//////////////////////
document.getElementById('adminLogin').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(adminLogin);
  const r = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') })
  });
  const j = await safeJson(r);
  if (j && j.success) {
    document.getElementById('loginArea').style.display = 'none';
    document.getElementById('adminArea').style.display = 'block';
    window.loadToggles();
    window.loadPdfs();
    await window.loadClasses();      // populate classes & selector
    // If a class is selected in the selector, load subjects for it
    if (classSelectorEl) {
      classSelectorEl.addEventListener('change', () => {
        const val = classSelectorEl.value || null;
        window.loadSubjects(val);
      });
    }
    // load subjects for currently selected class if any
    const selected = classSelectorEl ? classSelectorEl.value : null;
    window.loadSubjects(selected || null);
    window.loadStudents();
  } else alert((j && j.error) || 'Login failed');
};

//////////////////////
// small preview for the global add question form (if present)
//////////////////////
const globalImgInput = document.querySelector('#addQuestionForm input[name="image"]');
const globalPreview = document.getElementById('questionPreview');
if (globalImgInput && globalPreview) {
  globalImgInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        globalPreview.src = ev.target.result;
        globalPreview.style.display = 'block';
      };
      reader.readAsDataURL(file);
    } else {
      globalPreview.style.display = 'none';
    }
  });
}
//////////////////////
// CLASSES (SINGLE SOURCE OF TRUTH)
//////////////////////

window.loadClasses = async function () {
  const r = await fetch('/api/admin/classes', { credentials: 'include' });

  if (r.status === 401) {
    alert('Session expired — please login again');
    document.getElementById('loginArea').style.display = 'block';
    document.getElementById('adminArea').style.display = 'none';
    return;
  }

  if (!r.ok) {
    console.error('Failed loading classes:', r.status);
    return;
  }

  const { classes } = await r.json();

  // ===== Admin class list =====
  const cDiv = document.getElementById('classList');
  if (cDiv) cDiv.innerHTML = '';

  // ===== Shared selectors =====
  const selectors = [
    document.getElementById('classSelector'),
    document.getElementById('analyticsClass'),
    document.getElementById('attendanceClassSelect'),
    document.getElementById('bulkClassSelect'),
     document.getElementById('receiptClassSelect')
  ].filter(Boolean);

  selectors.forEach(sel => {
    sel.innerHTML = `<option value="">-- Select Class --</option>`;
  });

  classes.forEach(c => {
    // --------- CLASS LIST ----------
    if (cDiv) {
      const row = document.createElement('div');
      row.className = 'list-item';

      const name = document.createElement('div');
      name.textContent = `${c.name} (${c.id})`;

      const delBtn = document.createElement('button');
      delBtn.textContent = "Delete";
      delBtn.onclick = () => deleteClass(c.id);

      const lockBtn = document.createElement('button');
      lockBtn.textContent = c.locked ? "🔒 Unlock" : "🔓 Lock";
      lockBtn.style.marginLeft = "6px";
      lockBtn.onclick = async () => {
        await fetch(`/api/admin/class/${encodeURIComponent(c.id)}/lock`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ locked: !c.locked })
        });
        window.loadClasses();
      };

      row.append(name, delBtn, lockBtn);
      cDiv.appendChild(row);
    }

    // --------- ALL SELECTORS ----------
    selectors.forEach(sel => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name} (${c.id})`;
      sel.appendChild(opt);
    });
  });

  console.log("✅ Classes loaded & synchronized:", classes.length);
};

window.bulkPromoteStudents = async function () {
  const fromClass = prompt("Enter SOURCE class ID");
  if (!fromClass) return;

  const toClass = prompt("Enter TARGET class ID");
  if (!toClass) return;

  if (!confirm(`Promote ALL students from ${fromClass} to ${toClass}?`)) return;

  const res = await fetch("/api/admin/students/promote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ fromClass, toClass })
  });

  const j = await res.json();

  if (!res.ok) {
    alert(j.error || "Promotion failed");
    return;
  }

  alert(`${j.count} students promoted successfully`);
  window.loadStudents();
};

// ================= SOFTWARE MANAGEMENT =================

// SYSTEM STATUS (future Mega Server hook)
async function loadSystemStatus() {
  try {
    const res = await fetch("/api/system/status");
    if (!res.ok) return;

    const j = await res.json();
    const el = document.getElementById("systemStatus");
    if (el) {
      el.textContent = j.locked ? "LOCKED" : "ACTIVE";
      el.style.color = j.locked ? "red" : "green";
    }
  } catch {
    // silent fail
  }
}

// DOWNLOAD STUDENT STATS
const statsBtn = document.getElementById("downloadStudentStatsBtn");
if (statsBtn) {
  statsBtn.addEventListener("click", () => {
    window.open("/api/admin/student-stats-pdf", "_blank");
  });
}

// LOAD STATUS ON PAGE LOAD
loadSystemStatus();

// ===============================
// SAVE SCHOOL INFO (SAFE)
// ===============================
const saveSchoolBtn = document.getElementById("saveSchoolInfo");
if (saveSchoolBtn) {
  // Pre-fill with the school's current values so this is a real edit
  // form, not a blank box that overwrites everything every time.
  (async () => {
    try {
      const res = await fetch("/api/meta", { credentials: "include" });
      const { meta } = await res.json();
      if (meta) {
        if (document.getElementById("school_name")) document.getElementById("school_name").value = meta.schoolName || "";
        if (document.getElementById("school_address")) document.getElementById("school_address").value = meta.address || "";
        if (document.getElementById("school_phone")) document.getElementById("school_phone").value = meta.phone || "";
        if (document.getElementById("school_motto")) document.getElementById("school_motto").value = meta.motto || "";
        if (document.getElementById("report_term")) document.getElementById("report_term").value = meta.term || "";
        if (document.getElementById("report_session")) document.getElementById("report_session").value = meta.session || "";
        if (document.getElementById("report_next_term")) document.getElementById("report_next_term").value = meta.nextTermBegins || "";
      }
    } catch (err) {
      console.error("Failed to load current school info:", err);
    }
  })();

  saveSchoolBtn.onclick = async () => {
    const status = document.getElementById("schoolInfoStatus");
    const payload = {
      name: document.getElementById("school_name")?.value || "",
      address: document.getElementById("school_address")?.value || "",
      phone: document.getElementById("school_phone")?.value || "",
      motto: document.getElementById("school_motto")?.value || ""
    };

    try {
      const res = await fetch("/api/admin/school", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload)
      });
      const j = await res.json();
      if (j.success) {
        if (status) { status.style.color = "var(--green)"; status.textContent = "✅ School information updated."; }
      } else {
        if (status) { status.style.color = "var(--danger)"; status.textContent = "❌ " + (j.error || "Failed to save."); }
      }
    } catch (err) {
      if (status) { status.style.color = "var(--danger)"; status.textContent = "❌ Network error while saving."; }
    }
  };
}

// ===============================
// REPORT SHEET SETTINGS (term/session/next-term) + delete-all
// ===============================
const saveReportBtn = document.getElementById("saveReportSettings");
if (saveReportBtn) {
  saveReportBtn.onclick = async () => {
    const status = document.getElementById("reportSettingsStatus");
    const payload = {
      term: document.getElementById("report_term")?.value || "",
      session: document.getElementById("report_session")?.value || "",
      nextTermBegins: document.getElementById("report_next_term")?.value || ""
    };
    try {
      const res = await fetch("/api/admin/school", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload)
      });
      const j = await res.json();
      if (status) {
        status.style.color = j.success ? "var(--green)" : "var(--danger)";
        status.textContent = j.success ? "✅ Report sheet settings saved." : "❌ " + (j.error || "Failed to save.");
      }
    } catch {
      if (status) { status.style.color = "var(--danger)"; status.textContent = "❌ Network error while saving."; }
    }
  };
}

const deleteAllReportsBtn = document.getElementById("deleteAllReportsBtn");
if (deleteAllReportsBtn) {
  deleteAllReportsBtn.onclick = async () => {
    if (!confirm("This clears every student's scores school-wide. This cannot be undone. Continue?")) return;
    if (!confirm("Are you absolutely sure? Click OK only if you really want to wipe all report data now.")) return;

    try {
      const res = await fetch("/api/admin/reports/all", { method: "DELETE", credentials: "include" });
      const j = await res.json();
      if (j.success) {
        alert(`✅ Cleared ${j.resultsCleared} result records and ${j.filesDeleted} PDF files.`);
      } else {
        alert("❌ " + (j.error || "Failed to delete report data."));
      }
    } catch {
      alert("❌ Network error while deleting report data.");
    }
  };
}

// ===============================
// OFFLINE ADMIN SYNC
// ===============================
async function syncAdminQueue() {
  if (!navigator.onLine || typeof adminDB === "undefined" || !adminDB) return;

  const tx = adminDB.transaction("queue", "readwrite");
  const store = tx.objectStore("queue");

  store.getAll().onsuccess = async e => {
    const pending = e.target.result.filter(x => !x.synced);
    if (pending.length === 0) return;

    try {
      const res = await fetch("/offline-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pending)
      });

      if (!res.ok) return;

      pending.forEach(item => {
        item.synced = true;
        store.put(item);
      });

      console.log("Admin offline actions synced:", pending.length);
    } catch {
      // silent
    }
  };
}
// Load students when class is selected
const receiptClassSelect = document.getElementById("receiptClassSelect");
const receiptStudentSelect = document.getElementById("receiptStudentSelect");

if (receiptClassSelect) {
  receiptClassSelect.addEventListener("change", async () => {
    const classId = receiptClassSelect.value;

    receiptStudentSelect.innerHTML = "";

    if (!classId) return;

    try {
      const res = await fetch(`/api/admin/students/class/${encodeURIComponent(classId)}`, {
        credentials: "include"
      });

      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "Failed to load students");

      data.students.forEach(student => {
        const option = document.createElement("option");
        option.value = student._id;
        option.textContent = student.name;
        receiptStudentSelect.appendChild(option);
      });

    } catch (err) {
      console.error(err);
    }
  });
}
const generateReceiptBtn = document.getElementById("generateReceiptBtn");

if (generateReceiptBtn) {
  generateReceiptBtn.addEventListener("click", async () => {

    const classId = receiptClassSelect.value;
    const term = document.getElementById("receiptTermSelect").value;
    const amount = document.getElementById("receiptAmount").value;
    const status = document.getElementById("receiptStatus");

    const selectedStudents = Array.from(receiptStudentSelect.selectedOptions)
      .map(opt => ({
        id: opt.value,
        name: opt.textContent
      }));

    if (!classId || !term || !amount || selectedStudents.length === 0) {
      status.innerHTML = "⚠️ Please complete all fields";
      return;
    }

    try {
      const res = await fetch("/api/admin/receipts/bulk", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classId,
          term,
          amount,
          students: selectedStudents
        })
      });

      if (!res.ok) throw new Error("Failed to generate receipt");

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = `receipts_${Date.now()}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();

      status.innerHTML = "✅ Receipt downloaded successfully";

    } catch (err) {
      console.error(err);
      status.innerHTML = "❌ Error generating receipt";
    }

  });
}
// ================= TEACHER MANAGEMENT =================
function initTeacherManagement() {
  const form = document.getElementById("addTeacherForm");
  const list = document.getElementById("teacherList");
  const jet = document.getElementById("attendanceJet"); // reuse jet indicator

  if (!form || !list) return;

  // ----------------- Jet helpers -----------------
  function showJet(text = "🚀 Sending…") {
    if (!jet) return;
    jet.textContent = text;
    jet.classList.remove("hidden");
  }

  function hideJet(text = "🚀 Sending…", delay = 1000) {
    if (!jet) return;
    setTimeout(() => {
      jet.classList.add("hidden");
      jet.textContent = text;
    }, delay);
  }
  // -----------------------------------------------

  async function loadTeachers() {
    const res = await fetch("/api/admin/teachers", {
      credentials: "include"
    });
    if (!res.ok) return;

    const { teachers } = await res.json();
    list.innerHTML = "";

    teachers.forEach(t => {
      const div = document.createElement("div");
      div.style.border = "1px solid #ddd";
      div.style.padding = "8px";
      div.style.marginBottom = "6px";
      div.style.borderRadius = "6px";

      div.innerHTML = `
        <strong>${t.name}</strong> (${t.id})<br>
        Status:
        <b style="color:${t.blocked ? "red" : "green"}">
          ${t.blocked ? "Blocked" : "Active"}
        </b><br>
        <button data-toggle="${t.id}">
          ${t.blocked ? "Unblock" : "Block"}
        </button>
        <button data-idcard="${t.id}">
          📄 Download ID Card
        </button>
        <button data-delete="${t.id}" style="background:#b00020;color:#fff;">
          Delete
        </button>
      `;

      list.appendChild(div);
    });

    // -------- Download teacher ID card --------
    list.querySelectorAll("[data-idcard]").forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.idcard;
        try {
          const res = await fetch(`/api/admin/teacher/${encodeURIComponent(id)}/idcard`, {
            method: "POST",
            credentials: "include"
          });
          if (!res.ok) {
            const errText = await res.text();
            alert("Failed to generate ID card: " + errText);
            return;
          }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `teacher_${id}_idcard.pdf`;
          a.click();
          URL.revokeObjectURL(url);
        } catch (err) {
          console.error("Teacher ID card error:", err);
          alert("Error generating ID card");
        }
      };
    });

    // -------- Toggle teacher --------
    list.querySelectorAll("[data-toggle]").forEach(btn => {
      btn.onclick = async () => {
        const id = encodeURIComponent(btn.dataset.toggle);

        showJet("🚀 Updating status…");

        try {
          await fetch(`/api/admin/teacher/${id}/toggle`, {
            method: "PUT",
            credentials: "include"
          });

          showJet("✅ Status updated");
          loadTeachers();
          hideJet();
        } catch {
          showJet("❌ Failed");
          hideJet("🚀 Sending…", 1500);
        }
      };
    });

    // -------- Delete teacher --------
    list.querySelectorAll("[data-delete]").forEach(btn => {
      btn.onclick = async () => {
        if (!confirm("Delete this teacher?")) return;

        const id = encodeURIComponent(btn.dataset.delete);
        showJet("🚀 Deleting teacher…");

        try {
          await fetch(`/api/admin/teacher/${id}`, {
            method: "DELETE",
            credentials: "include"
          });

          showJet("✅ Teacher deleted");
          loadTeachers();
          hideJet();
        } catch {
          showJet("❌ Failed");
          hideJet("🚀 Sending…", 1500);
        }
      };
    });
  }

  // -------- Delete ALL staff at once --------
  const deleteAllTeachersBtn = document.getElementById("deleteAllTeachersBtn");
  if (deleteAllTeachersBtn) {
    deleteAllTeachersBtn.onclick = async () => {
      if (!confirm("This deletes EVERY teacher in the school. This cannot be undone. Continue?")) return;
      if (!confirm("Are you absolutely sure? Click OK only if you really want to delete all staff now.")) return;

      showJet("🚀 Deleting all staff…");
      try {
        const res = await fetch("/api/admin/teachers/all", {
          method: "DELETE",
          credentials: "include"
        });
        const j = await res.json();
        if (j.success) {
          showJet(`✅ Deleted ${j.deleted} teachers`);
          loadTeachers();
        } else {
          showJet("❌ Failed");
          alert(j.error || "Failed to delete all staff.");
        }
        hideJet();
      } catch {
        showJet("❌ Failed");
        hideJet("🚀 Sending…", 1500);
      }
    };
  }

  // -------- Add teacher --------
  form.onsubmit = async e => {
    e.preventDefault();

    const fd = new FormData(form);
    showJet("🚀 Adding teacher…");

    try {
      const res = await fetch("/api/admin/teacher", {
        method: "POST",
        credentials: "include",
        body: fd
      });

      if (!res.ok) {
        const err = await res.json();
        showJet("❌ Failed");
        hideJet("🚀 Sending…", 1500);
        return alert(err.error || "Failed");
      }

      const j = await res.json();
      showJet("✅ Teacher added");

      if (j.generatedPassword) {
        const teacherId = fd.get('id');
        if (confirm(
          `Teacher added.\n\nLogin password: ${j.generatedPassword}\n\n` +
          `Write this down now, it can't be shown again later.\n\n` +
          `Generate this teacher's ID card now?`
        )) {
          const cardRes = await fetch(`/api/admin/teacher/${encodeURIComponent(teacherId)}/idcard`, {
            method: 'POST',
            credentials: 'include'
          });
          if (cardRes.ok) {
            const blob = await cardRes.blob();
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
          }
        }
      }

      form.reset();
      loadTeachers();
      hideJet();
    } catch {
      showJet("❌ Failed");
      hideJet("🚀 Sending…", 1500);
    }
  };

  loadTeachers();
}



 // ================= ATTENDANCE REPORTS =================
(async function initAttendanceReports() {
  const sel = document.getElementById('attendanceClassSelect');
  const btn = document.getElementById('loadAttendanceBtn');
  const delBtn = document.getElementById('deleteAttendanceBtn');
  const viewer = document.getElementById('attendanceViewer');
 if (!sel || !viewer || !btn) return;
  // Load classes
  const res = await fetch('/api/admin/classes', { credentials: 'include' });
  if (!res.ok) return;

  const { classes } = await res.json();
  sel.innerHTML = '<option value="">Select Class</option>';

  classes.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.name} (${c.id})`;
    sel.appendChild(opt);
  });

  // Load attendance
  btn.onclick = async () => {
    if (!sel.value) return alert('Select class');

    const r = await fetch(`/api/admin/attendance/${sel.value}`, {
      credentials: 'include'
    });

    const j = await r.json();
    viewer.textContent = JSON.stringify(j.attendance, null, 2);
  };

  // 🔥 DELETE ATTENDANCE
  delBtn.onclick = async () => {
    if (!sel.value) return alert('Select class');

    const ok = confirm(
      `⚠️ This will permanently delete ALL attendance for class ${sel.value}.\n\nContinue?`
    );

    if (!ok) return;

    const r = await fetch(`/api/admin/attendance/${sel.value}`, {
      method: 'DELETE',
      credentials: 'include'
    });

    const j = await r.json();

    if (!r.ok) {
      alert(j.error || 'Delete failed');
      return;
    }

    viewer.textContent = '';
    alert('✅ Attendance deleted permanently');
  };
})();

function getDateRange(mode) {
  const today = new Date();
  let from, to;

  if (mode === "weekly") {
    const day = today.getDay() || 7;
    today.setDate(today.getDate() - day + 1);
    from = today.toISOString().slice(0, 10);
    today.setDate(today.getDate() + 4);
    to = today.toISOString().slice(0, 10);
  }

  if (mode === "monthly") {
    from = new Date(today.getFullYear(), today.getMonth(), 1)
      .toISOString()
      .slice(0, 10);
    to = new Date(today.getFullYear(), today.getMonth() + 1, 0)
      .toISOString()
      .slice(0, 10);
  }

  return { from, to };
}

function downloadClassAttendance(mode = "monthly") {
  const cls = prompt("Enter Class ID");
  if (!cls) return;

  const { from, to } = getDateRange(mode);

  fetch(`/api/admin/attendance/class/${cls}/pdf?from=${from}&to=${to}`)
    .then(r => r.json())
    .then(j => window.open(j.file, "_blank"));
}

function downloadTeacherAttendance(mode = "monthly") {
  const { from, to } = getDateRange(mode);

  fetch(`/api/admin/attendance/teachers/pdf?from=${from}&to=${to}`)
    .then(r => r.json())
    .then(j => window.open(j.file, "_blank"));
}

async function loadResultAnalytics() {
  const classId = document.getElementById("analyticsClass")?.value;
  const summary = document.getElementById("analyticsSummary");
  const canvas = document.getElementById("analyticsCanvas");
  if (canvas) canvas.style.display = "none"; // no chart anymore, names only

  if (!classId || !summary) {
    if (summary) summary.textContent = "Select a class to view analytics.";
    return;
  }

  summary.textContent = "Loading top 5…";

  const res = await fetch(`/api/admin/results/top5?classId=${classId}`, { credentials: "include" });
  const { top5 } = await res.json();

  if (!top5 || !top5.length) {
    summary.textContent = "No result data available for this class.";
    return;
  }

  summary.innerHTML = `<b>🏆 Top 5 Students</b><ol style="margin-top:6px;">` +
    top5.map(s => `<li>${s.name}</li>`).join("") +
    `</ol>`;
}

document
  .getElementById("loadAnalyticsBtn")
  ?.addEventListener("click", loadResultAnalytics);

// ================= INIT =================
document.addEventListener("DOMContentLoaded", initTeacherManagement);

// ===============================
// CONTACT DEVELOPER — plays a short alert sound before WhatsApp opens
// ===============================
const contactDevBtn = document.getElementById("contactDeveloperBtn");
if (contactDevBtn) {
  contactDevBtn.addEventListener("click", () => {
    try {
      const sound = new Audio("/public/sounds/alert.mp3");
      sound.play().catch(() => {});
    } catch {}
    // link's own href/target handles the actual WhatsApp navigation
  });
}

// ===============================
// PRINCIPAL SIGNATURE UPLOAD
// ===============================
// ===============================
// FREEZE / UNFREEZE SYSTEM (replaces old destructive Reset All Data)
// ===============================
const freezeBtn = document.getElementById("resetDataBtn");
if (freezeBtn) {
  async function refreshFreezeLabel() {
    try {
      const res = await fetch("/api/system/status");
      const j = await res.json();
      freezeBtn.textContent = j.locked ? "🔓 Unfreeze Data Display" : "🔒 Freeze Data Display";
      freezeBtn.dataset.locked = j.locked ? "true" : "false";
    } catch {}
  }

  freezeBtn.addEventListener("click", async () => {
    const isLocked = freezeBtn.dataset.locked === "true";

    if (!isLocked) {
      if (!confirm("Freeze the system? Admin screens will show as unavailable until you unfreeze.")) return;
      await fetch("/api/system/lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Frozen by administrator" })
      });
    } else {
      await fetch("/api/system/unlock", { method: "POST" });
    }
    refreshFreezeLabel();
  });

  refreshFreezeLabel();
}

// ===============================
// FACTORY RESET
// ===============================
const FACTORY_RESET_PHRASE = "RESET SCHOOL DATA";
const factoryResetConfirmInput = document.getElementById("factoryResetConfirmText");
const factoryResetBtn = document.getElementById("factoryResetBtn");
const factoryResetStatus = document.getElementById("factoryResetStatus");

if (factoryResetConfirmInput && factoryResetBtn) {
  // The button only ever becomes clickable once the phrase matches
  // exactly — the same safety pattern the new admin panel uses.
  factoryResetConfirmInput.addEventListener("input", () => {
    factoryResetBtn.disabled = factoryResetConfirmInput.value !== FACTORY_RESET_PHRASE;
  });

  factoryResetBtn.addEventListener("click", async () => {
    if (factoryResetConfirmInput.value !== FACTORY_RESET_PHRASE) return;

    // A second, explicit confirmation on top of the typed phrase —
    // this is genuinely irreversible, so it deserves two deliberate
    // steps, not one.
    const firstConfirm = confirm(
      "This permanently erases every class, teacher, student, subject, question, result, and attendance record in the entire school. Your own admin login stays intact so you aren't locked out. This cannot be undone. Continue?"
    );
    if (!firstConfirm) return;

    const secondConfirm = confirm(
      "Are you absolutely certain? Every score for every student in every class will be erased right now. Click OK only if you really mean to do this."
    );
    if (!secondConfirm) return;

    factoryResetBtn.disabled = true;
    factoryResetStatus.style.color = "#555";
    factoryResetStatus.textContent = "Resetting…";

    try {
      const res = await fetch("/api/admin/factory-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: factoryResetConfirmInput.value })
      });
      const j = await res.json();

      if (j.success) {
        factoryResetStatus.style.color = "green";
        factoryResetStatus.textContent = "✅ Factory reset complete. Every piece of school data has been cleared.";
        factoryResetConfirmInput.value = "";
        // Reload shortly after so every screen reflects the now-empty school
        setTimeout(() => location.reload(), 1800);
      } else {
        factoryResetStatus.style.color = "red";
        factoryResetStatus.textContent = "❌ " + (j.error || "Factory reset failed.");
        factoryResetBtn.disabled = factoryResetConfirmInput.value !== FACTORY_RESET_PHRASE;
      }
    } catch {
      factoryResetStatus.style.color = "red";
      factoryResetStatus.textContent = "❌ Network error during factory reset.";
      factoryResetBtn.disabled = factoryResetConfirmInput.value !== FACTORY_RESET_PHRASE;
    }
  });
}

// ===============================
// CHANGE ADMIN'S OWN LOGIN PASSWORD
// ===============================
const changeAdminPasswordBtn = document.getElementById("changeAdminPasswordBtn");
if (changeAdminPasswordBtn) {
  changeAdminPasswordBtn.onclick = async () => {
    const status = document.getElementById("changeAdminPasswordStatus");
    const currentPassword = document.getElementById("admin_current_password")?.value;
    const newPassword = document.getElementById("admin_new_password")?.value;

    if (!currentPassword || !newPassword) {
      if (status) { status.style.color = "var(--danger)"; status.textContent = "❌ Fill in both fields."; }
      return;
    }

    try {
      const res = await fetch("/api/admin/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ currentPassword, newPassword })
      });
      const j = await res.json();
      if (status) {
        status.style.color = j.success ? "var(--green)" : "var(--danger)";
        status.textContent = j.success ? "✅ Password changed." : "❌ " + (j.error || "Failed to change password.");
      }
      if (j.success) {
        document.getElementById("admin_current_password").value = "";
        document.getElementById("admin_new_password").value = "";
      }
    } catch {
      if (status) { status.style.color = "var(--danger)"; status.textContent = "❌ Network error."; }
    }
  };
}

// ===============================
// SET / CHANGE UNLOCK PASSWORD
// ===============================
const setUnlockPasswordBtn = document.getElementById("setUnlockPasswordBtn");
if (setUnlockPasswordBtn) {
  setUnlockPasswordBtn.onclick = async () => {
    const status = document.getElementById("setUnlockPasswordStatus");
    const newUnlockPassword = document.getElementById("new_unlock_password")?.value;

    if (!newUnlockPassword) {
      if (status) { status.style.color = "var(--danger)"; status.textContent = "❌ Enter a password first."; }
      return;
    }

    try {
      const res = await fetch("/api/admin/set-unlock-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ newUnlockPassword })
      });
      const j = await res.json();
      if (status) {
        status.style.color = j.success ? "var(--green)" : "var(--danger)";
        status.textContent = j.success ? "✅ Unlock password set." : "❌ " + (j.error || "Failed to set unlock password.");
      }
      if (j.success) document.getElementById("new_unlock_password").value = "";
    } catch {
      if (status) { status.style.color = "var(--danger)"; status.textContent = "❌ Network error."; }
    }
  };
}
