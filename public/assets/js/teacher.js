// public/assets/js/teacher.js
// Teacher Portal Logic — robust version with defensive checks
// Preserves original behaviour and improves safety to avoid null DOM errors.

// ---------------- Utility Helpers ----------------
function safeGet(id) {
  try {
    return document.getElementById(id) || null;
  } catch (e) {
    return null;
  }
}
function escapeHTML(str) {
  if (typeof str !== "string") return str;
  return str.replace(/[&<>"'`=\/]/g, (s) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
      "`": "&#x60",
      "=": "&#x3D",
      "/": "&#x2F",
    }[s])
  );
}

// ---------------- SAFE DOM-ID HELPER (Option A) ----------------
function safeId(str) {
  return String(str)
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "");
}

// ---------------- PORTAL AUTH ----------------
const portalForm = safeGet("portalAuth");
if (portalForm) {
  portalForm.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const pwd = fd.get("portalPassword");

    try {
      const r = await fetch("/api/portal/teacher/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portalPassword: pwd }),
      });

      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        alert(err.error || "Invalid portal password");
        return;
      }

      // fetch school meta (best-effort)
      try {
        const metaResp = await fetch("/api/meta");
        if (metaResp.ok) {
          const metaJson = await metaResp.json();
          if (metaJson?.meta?.schoolName) {
            const header = safeGet("dashboardTitle");
            if (header)
              header.textContent = `${metaJson.meta.schoolName} — Teacher Portal`;
          }
          // Set term name if available
          if (metaJson?.meta?.term) {
            const termEl = safeGet("termName");
            if (termEl) termEl.textContent = metaJson.meta.term;
          }
        }
      } catch (e) {
        console.warn("Meta fetch failed:", e);
      }

      const authSection = safeGet("authSection");
      const classesSection = safeGet("classesSection");
      if (authSection) authSection.style.display = "none";
      if (classesSection) classesSection.style.display = "block";

      await window.loadClasses();
    } catch (e) {
      console.error(e);
      alert("Network or server error.");
    }
  };
}

// ---------------- LOAD CLASSES ----------------
window.loadClasses = async function () {
  try {
    const r = await fetch("/api/classes");
    if (!r.ok) {
      alert("Failed to load classes");
      return;
    }
    const j = await r.json();

    const clDiv = safeGet("classesList");
    if (!clDiv) return;

    clDiv.innerHTML = "";

    (j.classes || []).forEach((c) => {
      const row = document.createElement("div");
      row.className = "list-item";

      const left = document.createElement("div");
      left.innerHTML = `<b>${escapeHTML(c.name)}</b> (${escapeHTML(c.id)})`;

      const right = document.createElement("div");
      const openBtn = document.createElement("button");
      openBtn.className = "primary";
      openBtn.textContent = "Open";
      openBtn.addEventListener("click", () => window.openClass(c.id));

      right.appendChild(openBtn);

      row.appendChild(left);
      row.appendChild(right);
      clDiv.appendChild(row);
    });

    if (!j.classes?.length) clDiv.innerHTML = "<p>No classes found.</p>";
  } catch (e) {
    console.error("loadClasses error:", e);
    alert("Failed to load classes.");
  }
};

// ---------------- OPEN CLASS ----------------
window.openClass = async function (classId) {
  try {
    const pass = prompt("Enter class password");
    if (!pass) return;

    const r = await fetch("/api/teacher/class/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classId, classPassword: pass }),
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert(err.error || "Wrong class password");
      return;
    }

    // Fetch students
    const s = await fetch(`/api/class/${encodeURIComponent(classId)}/students`);
    if (!s.ok) return alert("Failed to fetch students");

    const j = await s.json();
    window.students = j.students || [];

    // Fetch class info
    const classResp = await fetch(`/api/classes/${encodeURIComponent(classId)}`);
    const classInfo = classResp.ok ? await classResp.json() : { locked: false };
    window.currentClassLocked = !!classInfo.locked;

    const sl = safeGet("studentsList");
    if (!sl) return alert("Students container missing");
    sl.innerHTML = "";

    if (!window.students.length) {
      sl.innerHTML = "<p>No students in this class yet.</p>";
    } else {
      const header = document.createElement("h4");
      header.textContent = `Total Students in Class: ${window.students.length}`;
      sl.appendChild(header);

      window.students.forEach((st) => {
        const row = document.createElement("div");
        row.className = "list-item";

        const left = document.createElement("div");
        left.textContent = `${st.name} (${st.id})`;

        const right = document.createElement("div");

        const editBtn = document.createElement("button");
        editBtn.textContent = "Edit Report";
        editBtn.className = "primary";
        editBtn.disabled = window.currentClassLocked;
        editBtn.onclick = () => window.editReport(st.id, classId);

        const delBtn = document.createElement("button");
        delBtn.textContent = "Delete Report";
        delBtn.className = "danger";
        delBtn.disabled = window.currentClassLocked;
        delBtn.onclick = () => window.deleteReport(st.id);

        right.append(editBtn, delBtn);
        row.append(left, right);
        sl.appendChild(row);
      });
    }

    // ---------------- SIGNATURE UPLOAD ----------------
    const sid = safeId(classId);

    const existingUpload = safeGet(`teacherSignatureContainer_${sid}`);
    if (existingUpload) existingUpload.remove();

    const uploadSection = document.createElement("div");
    uploadSection.id = `teacherSignatureContainer_${sid}`;
    uploadSection.style.marginTop = "25px";
    uploadSection.innerHTML = `
      <h4>✍️ Upload Your Signature for Class <span style="color:#0073e6">${escapeHTML(classId)}</span></h4>
      <input type="file" id="teacherSignatureInput_${sid}" accept="image/png, image/jpeg" />
      <button id="uploadSignatureBtn_${sid}" class="primary">Upload Signature</button>
      <span id="signatureStatus_${sid}" style="margin-left:8px;"></span>
    `;
    sl.appendChild(uploadSection);

    const input = safeGet(`teacherSignatureInput_${sid}`);
    const uploadBtn = safeGet(`uploadSignatureBtn_${sid}`);
    const status = safeGet(`signatureStatus_${sid}`);

    if (uploadBtn) {
      uploadBtn.onclick = async () => {
        if (!input?.files?.length) return alert("Select a file");

        const fd = new FormData();
        fd.append("signature", input.files[0]);

        try {
          status.textContent = "Uploading...";
          const resp = await fetch(
            `/api/upload/teacher-signature/${encodeURIComponent(classId)}`,
            { method: "POST", body: fd }
          );

          const j = await resp.json();
          status.textContent = j.success ? "✅ Uploaded successfully" : "❌ Upload failed";
        } catch {
          status.textContent = "❌ Network error";
        }
      };
    }

    // ✅ SHOW BULK REPORT AREA ONLY AFTER CLASS OPENS
    const bulkArea = safeGet("bulkReportArea");
    if (bulkArea) bulkArea.style.display = "block";

    safeGet("studentsSection").style.display = "block";
    window.currentClassId = classId;

  } catch (e) {
    console.error("openClass error:", e);
    alert("Failed to open class.");
  }
};
// ---------------- DELETE REPORT ----------------
window.deleteReport = async function (studentId) {
  if (!confirm("Are you sure you want to delete this student's report?"))
    return;

  try {
    const r = await fetch(
      `/api/teacher/student/${encodeURIComponent(studentId)}/report`,
      { method: "DELETE" }
    );
    const j = await r.json();

    if (r.ok && j.success) {
      alert("🗑 Report deleted successfully.");
    } else {
      alert("❌ Failed to delete report: " + (j.error || "Unknown"));
    }
  } catch (err) {
    console.error("deleteReport error:", err);
    alert("Network or server error.");
  }
};

// ---------------- EDIT REPORT ----------------
window.editReport = async function (studentId, classId) {
  try {
    if (window.currentClassLocked) {
      return alert("⚠️ Cannot edit reports. This class is locked.");
    }

    // Find student
    const student = (window.students || []).find(s => s.id === studentId);
    if (!student) return alert("Student not found");

    // Display student name
    const studentNameEl = safeGet("studentName");
    if (studentNameEl) studentNameEl.textContent = student.name;

    const classResp = await fetch(`/api/classes/${encodeURIComponent(student.classId)}`);
    const classInfo = classResp.ok ? await classResp.json() : {};
    const subjects = classInfo.subjects || [];

    const resultsResp = await fetch(`/api/teacher/student/${encodeURIComponent(studentId)}/results`);
    const existingResults = resultsResp.ok ? (await resultsResp.json()).results || [] : [];

    const reportArea = safeGet("subjectsArea");
    if (!reportArea) return alert("Report area missing");
    reportArea.innerHTML = "";

    // Persistent selected subjects per student
    if (!window.selectedSubjects) window.selectedSubjects = {};
    const lastSelected = window.selectedSubjects[studentId] || subjects;

    // Create subject container
    const inputContainer = document.createElement("div");
    inputContainer.id = "inputsContainer";
    reportArea.appendChild(inputContainer);

    const renderInputs = () => {
      inputContainer.innerHTML = "";
      lastSelected.forEach(subj => {
        const res = existingResults.find(r => r.subject === subj) || {};

        const block = document.createElement("div");
        block.className = "subject-block";
        block.innerHTML = `
          <h4>${escapeHTML(subj)}</h4>
          <label>Test 1 <input type="number" min="0" max="10" name="${escapeHTML(subj)}_test1" value="${escapeHTML(String(res.test1 ?? 0))}" /></label>
          <label>Test 2 <input type="number" min="0" max="10" name="${escapeHTML(subj)}_test2" value="${escapeHTML(String(res.test2 ?? 0))}" /></label>
          <label>Test 3 <input type="number" min="0" max="10" name="${escapeHTML(subj)}_test3" value="${escapeHTML(String(res.test3 ?? 0))}" /></label>
          <label>Exam <input type="number" min="0" max="70" name="${escapeHTML(subj)}_exam" value="${escapeHTML(res.exam ?? "")}" placeholder="Enter exam score if missing" /></label>
          <hr/>
        `;
        inputContainer.appendChild(block);
      });
    };

    // Render inputs once immediately
    renderInputs();

    // Save current selection for persistence
    window.selectedSubjects[studentId] = lastSelected;

    // --- Form submit ---
    const form = safeGet("reportForm");
    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        if (window.currentClassLocked) return alert("⚠️ Cannot submit. This class is locked.");

        const fd = new FormData(form);
        const reports = {};

        lastSelected.forEach(subj => {
          const oldRes = existingResults.find(r => r.subject === subj) || {};

          reports[subj] = {
            test1: Number(fd.get(`${subj}_test1`) || 0),

            // ----------- FIXED TEST2 MERGE LOGIC -----------
            test2:
              fd.get(`${subj}_test2`) === ""     // empty → keep CBT value
                ? (oldRes.test2 ?? 0)
                : Number(fd.get(`${subj}_test2`)),

            test3: Number(fd.get(`${subj}_test3`) || 0),

            exam:
              fd.get(`${subj}_exam`) !== ""
                ? Number(fd.get(`${subj}_exam`))
                : undefined
          };
        });

        try {
          const r = await fetch(`/api/teacher/student/${encodeURIComponent(studentId)}/report`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reports, classId: window.currentClassId }),
          });
          const j = await r.json();
          if (j.success) alert("✅ Report updated. PDF generated.");
          else alert("❌ Error: " + (j.error || "Unknown"));
        } catch (err) {
          console.error("submit report error:", err);
          alert("Network error while saving report.");
        }
      };
    }

    const reportEdit = safeGet("reportEdit");
    if (reportEdit) reportEdit.style.display = "block";

  } catch (err) {
    console.error("editReport error:", err);
    alert("Failed to load report editor.");
  }
};

// ---------------- BULK REPORT GENERATION ----------------
(function bulkReports() {
  const bulkArea = safeGet("bulkReportArea");
  const bulkStatus = safeGet("bulkStatus");
  const bulkBtn = safeGet("generateAllBtn");
  const mergedBtn = safeGet("generateMergedBtn");

  if (!bulkArea || !bulkBtn || !mergedBtn || !bulkStatus) return;

  bulkArea.style.display = "none";

 
  // ---------- GENERATE MERGED ----------
  mergedBtn.onclick = async () => {
  try {
    bulkStatus.innerHTML = `
      <div style="
        padding:14px;
        border-radius:10px;
        background:#f1f3f5;
        color:#333;
        font-size:14px;
      ">
        Generating full class report… ⏳
      </div>
    `;

    const r = await fetch(
      `/api/teacher/class/${encodeURIComponent(
        window.currentClassId
      )}/combined-report`
    );

    const j = await r.json().catch(() => ({}));

    // 🔒 LICENSE BLOCK (INLINE – NO MODAL)
    if (r.status === 403) {
      bulkStatus.innerHTML = `
        <div style="
          border:1px solid #e53935;
          background:#fff5f5;
          padding:18px;
          border-radius:12px;
          color:#333;
          font-size:14px;
          line-height:1.6;
        ">
          <h3 style="margin-top:0;color:#c62828;">
            🚫 Report Generation Restricted
          </h3>

          <p>
            ⚠️ <strong>Access Temporarily Disabled</strong>
          </p>

          <p>
            ✏️🧍‍♂️ <em>We noticed you attempted to generate a class report.</em>
          </p>

          <p>
            📄 Report generation is currently
            <strong>restricted due to license status</strong>.
          </p>

          <p>
            🔐 <strong>Important:</strong><br>
            This license is <u>managed and regulated by an external licensing authority</u>,
            not the school system itself.
          </p>

          <p>
            😟🧍‍♀️ <em>Please do not panic — your data is safe.</em>
          </p>

          <p>
            📌 To restore access, kindly contact the licensing body for renewal or verification.
          </p>

          <a
            href="https://www.suibingitservices.com/schools/licensing"
            target="_blank"
            style="
              display:inline-block;
              margin-top:10px;
              padding:8px 14px;
              background:#c62828;
              color:#fff;
              border-radius:6px;
              text-decoration:none;
              font-weight:500;
            "
          >
            🔑 Resolve License Issue
          </a>
        </div>
      `;
      return;
    }

    // ✅ SUCCESS
    if (j.file) {
      window.open(j.file, "_blank");
      bulkStatus.innerHTML = `
        <div style="
          padding:12px;
          border-radius:8px;
          background:#e8f5e9;
          color:#2e7d32;
          font-weight:500;
        ">
          ✅ Full class report generated successfully.
        </div>
      `;
      setTimeout(() => (bulkStatus.innerHTML = ""), 4000);
    } else {
      bulkStatus.innerHTML = `
        <div style="color:#c62828;">❌ Report generation failed.</div>
      `;
    }
  } catch {
    bulkStatus.innerHTML = `
      <div style="color:#c62828;">❌ Network error.</div>
    `;
  }
};

})(); // ✅ THIS WAS MISSING / BROKEN BEFORE


// ---------------- FETCH SCHOOL META ----------------
(async function fetchSchoolMeta() {
  try {
    const r = await fetch("/api/meta");
    if (!r.ok) return;

    const d = await r.json();
    if (d.meta) {
      safeGet("schoolName").textContent =
        d.meta.schoolName || "";
      safeGet("termName").textContent =
        d.meta.term || "";
    }
  } catch (err) {
    console.warn("Failed to load school meta:", err);
  }
})();
