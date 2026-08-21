// public/broadcast.js
//
// Shared "send to everyone" overlay. Loaded by every portal page
// (exam, parent, teacher, attendance, admin) so there is exactly ONE
// copy of this behavior to maintain, instead of five duplicated ones.
// Same look and interaction as before: centered dark-blue card, gold
// border, pulse animation, alert sound, blocks the rest of the page
// while it's showing, auto-dismisses after the duration the admin set.

document.addEventListener("DOMContentLoaded", () => {
  let overlay = document.getElementById("broadcast-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "broadcast-overlay";

    const countdownSpan = document.createElement("div");
    countdownSpan.id = "broadcast-countdown";
    countdownSpan.style.fontSize = "0.5em";
    countdownSpan.style.marginTop = "15px";
    countdownSpan.style.opacity = "0.9";
    countdownSpan.style.fontWeight = "600";
    overlay.appendChild(countdownSpan);

    document.body.appendChild(overlay);

    Object.assign(overlay.style, {
      position: "fixed",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      width: "85%",
      maxWidth: "700px",
      minHeight: "120px",
      backgroundColor: "rgba(0, 45, 105, 0.95)",
      color: "#ffd700",
      display: "none",
      zIndex: "999999",
      fontSize: "60px",
      fontWeight: "900",
      textAlign: "center",
      justifyContent: "center",
      alignItems: "center",
      padding: "20px",
      boxSizing: "border-box",
      textShadow: "0 0 20px #000",
      borderRadius: "18px",
      border: "6px solid #ffcc00",
      wordWrap: "break-word",
      wordBreak: "break-word",
      overflowWrap: "break-word",
      flexDirection: "column",
      cursor: "not-allowed",
      userSelect: "none",
      pointerEvents: "all",
      animation: "pulseOverlay 1s infinite alternate"
    });

    const style = document.createElement("style");
    style.innerHTML = `
      @keyframes pulseOverlay {
        0% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
        50% { transform: translate(-50%, -50%) scale(1.05); opacity: 0.9; }
        100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
      }
      @media(max-width:1024px) { #broadcast-overlay { font-size: 50px; } }
      @media(max-width:768px)  { #broadcast-overlay { font-size: 40px; } }
      @media(max-width:480px)  { #broadcast-overlay { font-size: 28px; } }
      @media(max-width:360px)  { #broadcast-overlay { font-size: 24px; } }
    `;
    document.head.appendChild(style);
  }

  const broadcastSound = new Audio("/public/sounds/alert.mp3");
  broadcastSound.preload = "auto";
  let activeInterval = null;

  async function checkBroadcast() {
    try {
      const res = await fetch("/api/broadcast");
      const data = await res.json();
      const countdown = document.getElementById("broadcast-countdown");

      if (data.text) {
        // Already showing this exact message? Don't restart its countdown.
        if (overlay.dataset.currentText === data.text && overlay.style.display === "flex") {
          return;
        }
        overlay.dataset.currentText = data.text;

        overlay.innerHTML = `<div>${data.text}</div>`;
        overlay.appendChild(countdown);
        overlay.style.display = "flex";

        const maxCharsPerLine = Math.floor(window.innerWidth / 15);
        overlay.style.fontSize = data.text.length > maxCharsPerLine
          ? `${Math.max(18, Math.floor(60 * maxCharsPerLine / data.text.length))}px`
          : "60px";

        document.body.style.pointerEvents = "none";
        overlay.style.pointerEvents = "all";

        broadcastSound.pause();
        broadcastSound.currentTime = 0;
        broadcastSound.play().catch(e => console.warn("Audio play blocked:", e));

        let remaining = data.durationSeconds || 30;
        countdown.textContent = `Will disappear in ${remaining}s`;

        if (activeInterval) clearInterval(activeInterval);
        activeInterval = setInterval(() => {
          remaining--;
          countdown.textContent = `Will disappear in ${remaining}s`;
          if (remaining <= 0) {
            clearInterval(activeInterval);
            overlay.style.display = "none";
            overlay.dataset.currentText = "";
            document.body.style.pointerEvents = "auto";
          }
        }, 1000);

      } else {
        overlay.style.display = "none";
        overlay.dataset.currentText = "";
        document.body.style.pointerEvents = "auto";
      }
    } catch (err) {
      console.error("Broadcast fetch failed:", err);
    }
  }

  checkBroadcast();
  setInterval(checkBroadcast, 2000);
});
