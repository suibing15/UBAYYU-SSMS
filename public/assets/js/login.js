// public/assets/js/login.js — unified login across portals
async function handleLogin(formId, url, onSuccess) {
  const form = document.getElementById(formId);
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const fd = new FormData(form);
    const body = {};
    fd.forEach((val, key) => (body[key] = val));

    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include"   // ✅ Keep session cookie
      });

      const j = await r.json();
      if (r.ok && j.success) {
        onSuccess(j);
      } else {
        alert(j.error || "Login failed");
      }
    } catch (err) {
      console.error(err);
      alert("Server error");
    }
  });
}



// ---------------- PORTALS ----------------

// ✅ Admin login
handleLogin("adminLogin", "/api/admin/login", () => {
  document.getElementById("loginArea").style.display = "none";
  document.getElementById("adminArea").style.display = "block";

  // Load admin panel features
  if (typeof window.loadToggles === "function") window.loadToggles();
  if (typeof window.loadPdfs === "function") window.loadPdfs();

  // ✅ Load classes ONLY AFTER LOGIN
  if (typeof window.loadClassesForBulkID === "function") window.loadClassesForBulkID();
});

// Teacher login
handleLogin("portalAuth", "/api/portal/teacher/auth", () => {
  document.getElementById("authSection").style.display = "none";
  document.getElementById("classesSection").style.display = "block";
  if (typeof window.loadClasses === "function") window.loadClasses();
});

// Exam login
handleLogin("authForm", "/api/portal/exam/auth", () => {
  document.getElementById("auth").style.display = "none";
  document.getElementById("classSelect").style.display = "block";
  if (typeof window.loadClasses === "function") window.loadClasses();
});

// Parent portal login
handleLogin("authFormParent", "/api/portal/parent/auth", () => {
  document.getElementById("auth").style.display = "none";
  document.getElementById("parentArea").style.display = "block";
  if (typeof window.loadSections === "function") window.loadSections();
});
