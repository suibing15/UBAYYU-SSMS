// public/branding.js
//
// Shared branding loader. Fetches the school's real logo, name,
// address, motto, and phone from /api/meta and applies them to
// whatever elements exist on the current page. Loaded by index.html,
// exam.html, parent.html, and the admin panel, so an admin's edit to
// school info or a fresh logo upload actually shows up everywhere,
// not just on generated PDFs.

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const res = await fetch("/api/meta");
    if (!res.ok) return;
    const { meta } = await res.json();
    if (!meta) return;

    // Logo — matches every variation of logo <img> used across pages
    if (meta.logo) {
      const cacheBusted = meta.logo + (meta.logo.includes("?") ? "&" : "?") + "v=" + Date.now();
      document.querySelectorAll(
        'img.school-logo, img[alt="School Logo"], img[alt="School logo"], .crest img'
      ).forEach(img => { img.src = cacheBusted; });
    }

    // Text fields — only touches elements that actually exist on this page
    const setText = (selector, value) => {
      if (!value) return;
      document.querySelectorAll(selector).forEach(el => { el.textContent = value; });
    };
    setText("#schoolName, .school-name", meta.schoolName);
    setText(".address, #schoolAddressDisplay", meta.address);
    setText(".motto, #schoolMottoDisplay", meta.motto ? `"${meta.motto}"` : "");

    // Phone numbers can be a comma-separated list; if the page has a
    // dedicated container, render one link per number like index.html did.
    const phoneContainer = document.getElementById("schoolPhoneDisplay");
    if (phoneContainer && meta.phone) {
      phoneContainer.innerHTML = "";
      meta.phone.split(",").map(p => p.trim()).filter(Boolean).forEach(num => {
        const a = document.createElement("a");
        a.href = `tel:${num}`;
        a.textContent = num;
        phoneContainer.appendChild(a);
      });
    }
  } catch (err) {
    console.error("Branding load failed:", err);
  }
});
