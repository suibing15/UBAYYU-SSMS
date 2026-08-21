// public/assets/js/exam-init.js
document.addEventListener("DOMContentLoaded", () => {
  handleLogin("authForm", "/api/portal/exam/auth", () => {
    document.getElementById("auth").style.display = "none";
    document.getElementById("classSelect").style.display = "block";
    if (typeof loadClasses === "function") loadClasses();
  });
});
