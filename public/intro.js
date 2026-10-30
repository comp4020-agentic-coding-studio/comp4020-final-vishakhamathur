// Standalone briefing overlay, deliberately separate from app.js: it only
// touches the DOM and sessionStorage, never the WS/game state, so it can't
// interfere with the triage loop regardless of load order.
const SEEN_KEY = "soc-briefing-seen";

const overlay = document.getElementById("intro-overlay");
const checkbox = document.getElementById("intro-ack-checkbox");
const startButton = document.getElementById("intro-start");

if (sessionStorage.getItem(SEEN_KEY) === "1") {
  overlay.hidden = true;
} else {
  checkbox.addEventListener("change", () => {
    startButton.disabled = !checkbox.checked;
  });

  startButton.addEventListener("click", () => {
    sessionStorage.setItem(SEEN_KEY, "1");
    overlay.hidden = true;
  });
}
