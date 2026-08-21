// public/assets/js/admin-ui.js
document.addEventListener("DOMContentLoaded", () => {
  const headers = document.querySelectorAll(".card-header");

  headers.forEach(header => {
    header.addEventListener("click", (e) => {
      // ✅ Only toggle if the actual header is clicked, not its children buttons/links
      if (e.target.tagName === "BUTTON" || e.target.tagName === "A") {
        return; // don’t toggle when clicking a button/link inside the header
      }

      const cardBody = header.nextElementSibling;
      const icon = header.querySelector(".toggle-icon");

      if (cardBody.classList.contains("active")) {
        // collapse
        cardBody.style.maxHeight = cardBody.scrollHeight + "px"; // set current height
        requestAnimationFrame(() => {
          cardBody.style.maxHeight = "0px";
        });
        cardBody.classList.remove("active");
        icon.textContent = "+";
      } else {
        // expand
        cardBody.classList.add("active");
        cardBody.style.maxHeight = cardBody.scrollHeight + "px";
        icon.textContent = "−";

        // reset to auto after animation completes
        cardBody.addEventListener(
          "transitionend",
          () => {
            if (cardBody.classList.contains("active")) {
              cardBody.style.maxHeight = "none";
            }
          },
          { once: true }
        );
      }
    });
  });
});
