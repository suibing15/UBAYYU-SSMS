// public/assets/js/exam.js

let currentStudent = null;
let currentClass = null;
let activeTimer = null;
let timeLeft = 0;
let EXAM_IN_PROGRESS = false;
let EXAM_COMPLETED = false;

// ---------------- LOAD CLASSES ----------------
async function loadClasses() {
  const res = await fetch("/api/classes");
  if (!res.ok) {
    console.error("Failed to load classes:", await safeGetText(res));
    return alert("Failed to load classes");
  }
  const j = await res.json();
  const list = document.getElementById("classList");
  list.innerHTML = "";

  (j.classes || []).forEach((c) => {
    const row = document.createElement("div");
    row.className = "list-item";

    const info = document.createElement("div");
    info.textContent = `${c.name} (${c.id})`;

    const btn = document.createElement("button");
    btn.textContent = "Open";
    btn.addEventListener("click", () => openClass(c.id));

    row.appendChild(info);
    row.appendChild(btn);
    list.appendChild(row);
  });

  document.getElementById("classSelect").style.display = "block";
}

// ---------------- OPEN CLASS → SHOW STUDENTS ----------------
async function openClass(classId) {
  const res = await fetch(`/api/class/${classId}/students`);
  if (!res.ok) {
    console.error("Failed to fetch students:", await safeGetText(res));
    return alert("Failed to fetch students");
  }
  const j = await res.json();
  window.students = j.students || [];

  const list = document.getElementById("studentsList");
  list.innerHTML = "";
  window.students.forEach((s) => {
    const row = document.createElement("div");
    row.className = "list-item";

    const info = document.createElement("div");
    info.textContent = `${s.name} (${s.id})`;

    const btn = document.createElement("button");
    btn.textContent = "Login";
    btn.addEventListener("click", () => loginStudent(s.id, classId));

    row.appendChild(info);
    row.appendChild(btn);
    list.appendChild(row);
  });

  document.getElementById("studentSelect").style.display = "block";
}

// ---------------- STUDENT LOGIN ----------------
async function loginStudent(studentId, classId) {
  const pass = prompt("Enter your student password");
  if (!pass) return;

  const student = window.students.find((st) => st.id === studentId);
  if (!student) return alert("Invalid student password");

  try {
    const res = await fetch("/api/exam/student/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId, password: pass })
    });
    const j = await res.json();
    if (!j.success) return alert(j.error || "Invalid student password");
  } catch (err) {
    console.error("Password verification failed:", err);
    return alert("Network error while checking your password. Please try again.");
  }

  currentStudent = studentId;
  currentClass = classId;

  document.getElementById("classSelect").style.display = "none";
  document.getElementById("studentSelect").style.display = "none";
  document.getElementById("examArea").style.display = "block";
  document.getElementById(
    "examTitle"
  ).textContent = `Student: ${student.name} (${studentId}) - Class: ${classId}`;

  const tb = document.getElementById("testsButtons");
  tb.innerHTML = "";
  ["test1", "test2", "test3", "exam"].forEach((type) => {
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = type.toUpperCase();
    btn.addEventListener("click", () => showInstructions(type));
    tb.appendChild(btn);
  });
}

// ---------------- SHOW EXAM INSTRUCTIONS ----------------
function showInstructions(type) {
  const qArea = document.getElementById("questionArea");
  qArea.innerHTML = `
    <div style="padding:10px; border:1px solid #ccc; margin-bottom:1rem;">
      <h3>Exam Instructions</h3>
      <ul>
        <li>Be calm while writing the examination.</li>
        <li>Read the questions carefully.</li>
        <li>Choose the correct option based on your understanding.</li>
        <li>Report any problem immediately.</li>
      </ul>
      <button id="startExamBtn" class="primary">Start ${type.toUpperCase()}</button>
    </div>
  `;
  document.getElementById("startExamBtn").addEventListener("click", () => startTest(type));
}

// Lock browser navigation immediately
history.pushState({ exam: true }, "", location.href);

// ================= START A TEST =================
async function startTest(type) {
  const subId = prompt("Enter subject ID (e.g. ENG, MATH)");
  if (!subId) return;

  const examKey = `${currentStudent}_${currentClass}_${subId}_${type}`;

   EXAM_IN_PROGRESS = true;
  EXAM_COMPLETED = false;

  let r;
  try {
    r = await fetch(
      `/api/exam/questions?subjectId=${encodeURIComponent(subId)}&type=${encodeURIComponent(type)}&classId=${encodeURIComponent(currentClass)}`
    );
  } catch (err) {
    alert("Network error fetching questions");
    EXAM_IN_PROGRESS = false;
    return;
  }

  const j = await r.json();
  const qArea = document.getElementById("questionArea");
  qArea.innerHTML = "";

  if (!r.ok || !j.items || j.items.length === 0) {
    qArea.innerHTML = `<p style="color:red;">${j.error || "No questions available."}</p>`;
    EXAM_IN_PROGRESS = false;
    return;
  }

  // ================= TIMER =================
  if (activeTimer) clearInterval(activeTimer);
  timeLeft = j.duration ? j.duration * 60 : 1800;

  // Distinguishes a genuine timeout from a manual submit click — a
  // real timeout must still submit whatever's been answered so far,
  // the "every question must be answered" rule below only applies to
  // a student actively clicking Submit themselves.
  let isTimeoutSubmit = false;

  const timerEl = document.createElement("div");
  timerEl.style.fontWeight = "bold";
  timerEl.style.marginBottom = "1rem";
  qArea.appendChild(timerEl);

  function updateTimer() {
    const min = Math.floor(timeLeft / 60);
    const sec = timeLeft % 60;
    timerEl.textContent = `⏳ Time Left: ${min}:${sec.toString().padStart(2, "0")}`;

    if (timeLeft <= 0) {
      clearInterval(activeTimer);
      activeTimer = null;
      isTimeoutSubmit = true;
      form.requestSubmit();
    }
    timeLeft--;
  }

  updateTimer();
  activeTimer = setInterval(updateTimer, 1000);

 // ===== CALCULATOR BUTTON =====
const calcBtn = document.createElement("button");
calcBtn.type = "button";
calcBtn.className = "primary";
calcBtn.textContent = "Calculator";
calcBtn.style.marginBottom = "1rem";

calcBtn.onclick = () => {
  const calc = document.getElementById("cbt-calculator");
  calc.style.display = calc.style.display === "none" ? "block" : "none";
};

qArea.appendChild(calcBtn);
  // ================= PROGRESS TRACKER =================
  const progressEl = document.createElement("div");
  progressEl.style.marginBottom = "1rem";
  progressEl.style.fontWeight = "bold";
  progressEl.textContent = `Answered: 0 / ${j.items.length}`;
  qArea.appendChild(progressEl);

  // ================= FORM =================
  const form = document.createElement("form");
  form.noValidate = true;

  const studentAnswers = {};

  j.items.forEach((it, idx) => {
    const div = document.createElement("div");
    div.className = "question-block"; // ✅ Use your existing CSS class
    div.id = "qblock-" + it.qid; // used to scroll to / highlight this question if left unanswered
    div.innerHTML = `<p class="question-text"><strong>Q${idx + 1}:</strong> ${it.text}</p>`;

    if (it.image) {
      const img = document.createElement("img");
      img.src = it.image;
      img.className = "question-img";
      div.appendChild(img);
    }

    it.options.forEach((opt) => {
      const label = document.createElement("label");
      label.className = "option"; // ✅ Use your existing CSS for left-aligned options

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = it.qid;
      radio.value = opt;
      radio.required = true;

      radio.onchange = () => {
        studentAnswers[it.qid] = opt;
        // Update progress
        const answeredCount = Object.keys(studentAnswers).length;
        progressEl.textContent = `Answered: ${answeredCount} / ${j.items.length}`;
      };

      label.appendChild(radio);
      label.appendChild(document.createTextNode(opt));
      div.appendChild(label);
    });

    form.appendChild(div);
  });

  // ================= SUBMIT =================
  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "primary";
  submitBtn.textContent = "Submit Answers";
  form.appendChild(submitBtn);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (!isTimeoutSubmit) {
      // Every question must be answered before submission is allowed
      // — this used to only show a progress counter and let an
      // incomplete exam through regardless. Unanswered questions are
      // cleared of any previous highlight first, so re-checking after
      // answering some of them doesn't leave stale red borders behind.
      document.querySelectorAll(".question-block.unanswered").forEach((el) => {
        el.classList.remove("unanswered");
      });

      const unanswered = j.items.filter((it) => !studentAnswers[it.qid]);
      if (unanswered.length > 0) {
        unanswered.forEach((it) => {
          const block = document.getElementById("qblock-" + it.qid);
          if (block) {
            block.classList.add("unanswered");
            block.style.border = "2px solid #c0392b";
            block.style.borderRadius = "8px";
            block.style.padding = "10px";
          }
        });
        alert(
          `You have ${unanswered.length} unanswered question(s). Every question must be answered before you can submit — they're highlighted in red below.`
        );
        const firstBlock = document.getElementById("qblock-" + unanswered[0].qid);
        if (firstBlock) firstBlock.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }

      if (!confirm("Are you sure you want to submit your exam? You cannot change answers after submission.")) {
        return;
      }
    }
    // A genuine timeout skips both the completeness check and the
    // confirmation dialog above — time's up means time's up, whatever
    // has been answered so far is submitted automatically.

    if (activeTimer) clearInterval(activeTimer);

    try {
      const resp = await fetch("/api/exam/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: currentStudent,
          classId: currentClass,
          subjectId: subId,
          type,
          answers: studentAnswers,
        }),
      });

      const result = await resp.json();

      if (resp.ok) {
        EXAM_IN_PROGRESS = false;
        EXAM_COMPLETED = true;

        sessionStorage.setItem("exam_done_" + examKey, "1");

        qArea.innerHTML = `
          <div style="text-align:center;">
            <h3>Exam Submitted Successfully</h3>
            <p><b>Score:</b> ${result.score} / ${result.total}</p>
            <p><b>Percentage:</b> ${result.percentage}%</p>
            <p><a href="${result.pdf}" target="_blank">View Result PDF</a></p>
            <p style="margin-top:10px;">Returning to class selection in 5 seconds...</p>
          </div>
        `;

        setTimeout(() => {
          document.getElementById("examArea").style.display = "none";
          document.getElementById("classSelect").style.display = "block";
          document.getElementById("studentSelect").style.display = "block";
          qArea.innerHTML = "";
        }, 5000);
      } else {
        alert(result.error || "Submission failed");
      }
    } catch (err) {
      alert("Network error submitting exam");
    }
  });

  qArea.appendChild(form);
}


// ================= NAVIGATION & REFRESH CONTROL =================
window.addEventListener("popstate", function () {
  if (EXAM_IN_PROGRESS) {
    history.pushState({ exam: true }, "", location.href);
    alert("Exam is in progress. You cannot go back.");
  }
});

window.addEventListener("beforeunload", function (e) {
  if (EXAM_IN_PROGRESS) {
    e.preventDefault();
    e.returnValue = "Exam is in progress. You cannot leave or refresh the page.";
    return "Exam is in progress. You cannot leave or refresh the page.";
  }
});

// ================= GLOBAL EXPORTS =================
window.loginStudent = loginStudent;
window.startTest = startTest;
window.showInstructions = showInstructions;

