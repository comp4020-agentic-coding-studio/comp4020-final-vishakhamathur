// No audio files ship with the app, so tension sounds are synthesized with
// the Web Audio API rather than fetched — nothing to fail loading mid-demo.
// Browsers block audio before a user gesture, so the context is created
// lazily on first click/keydown rather than at page load.
const audio = {
  ctx: null,
};

function unlockAudio() {
  if (audio.ctx) return;
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return;
  audio.ctx = new AudioContextCtor();
}
document.addEventListener("click", unlockAudio, { once: true });
document.addEventListener("keydown", unlockAudio, { once: true });

function playTone({ frequency, duration, type = "sine", gain = 0.2, delay = 0 }) {
  if (!audio.ctx) return;
  const startAt = audio.ctx.currentTime + delay;
  const oscillator = audio.ctx.createOscillator();
  const gainNode = audio.ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, startAt);
  gainNode.gain.setValueAtTime(gain, startAt);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gainNode).connect(audio.ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration);
}

function playTick() {
  playTone({ frequency: 880, duration: 0.08, type: "square", gain: 0.15 });
}

function playConsensusDing() {
  playTone({ frequency: 880, duration: 0.15, type: "sine", gain: 0.25 });
  playTone({ frequency: 1320, duration: 0.25, type: "sine", gain: 0.2, delay: 0.1 });
}

function playBreachBuzzer() {
  playTone({ frequency: 110, duration: 0.5, type: "sawtooth", gain: 0.3 });
  playTone({ frequency: 100, duration: 0.5, type: "sawtooth", gain: 0.3, delay: 0.15 });
}

function playEjectBuzzer() {
  playTone({ frequency: 90, duration: 0.6, type: "sawtooth", gain: 0.35 });
  playTone({ frequency: 70, duration: 0.7, type: "sawtooth", gain: 0.3, delay: 0.2 });
}

const THREAT_DURATION_MS = 20_000;
const AUDIT_DURATION_MS = 30_000;
const CRITICAL_THRESHOLD_MS = 5_000;

const state = {
  me: null,
  phase: "lobby",
  role: "ANALYST",
  players: [],
  readyToStart: false,
  active: null,
  threatIndex: 0,
  totalThreats: 3,
  deadline: 0,
  auditCandidates: [],
  auditTally: {},
  myAuditVote: null,
  result: null,
};

const el = {
  me: document.getElementById("me"),
  roleBanner: document.getElementById("role-banner"),
  lobbySection: document.getElementById("lobby"),
  lobbyStatus: document.getElementById("lobby-status"),
  lobbyPlayers: document.getElementById("lobby-players"),
  startShift: document.getElementById("start-shift"),
  activeSection: document.getElementById("active-threat"),
  threatProgress: document.getElementById("threat-progress"),
  activeCard: document.getElementById("active-card"),
  countdown: document.getElementById("countdown"),
  countdownNumber: document.getElementById("countdown-number"),
  countdownFill: document.getElementById("countdown-fill"),
  auditSection: document.getElementById("audit"),
  auditCountdown: document.getElementById("audit-countdown"),
  auditCountdownNumber: document.getElementById("audit-countdown-number"),
  auditCountdownFill: document.getElementById("audit-countdown-fill"),
  auditCandidates: document.getElementById("audit-candidates"),
  resultsSection: document.getElementById("results"),
  resultsBody: document.getElementById("results-body"),
  playAgain: document.getElementById("play-again"),
  revokedOverlay: document.getElementById("revoked-overlay"),
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// A 10x10 risk matrix: severity (1-10) on the vertical axis, likelihood
// (1-10) on the horizontal axis. The cell grid is identical every render, so
// it's built once and reused.
const GRID_CELLS_HTML = Array.from({ length: 100 }, () => '<div class="cell"></div>').join("");

function toLeftPct(likelihood) {
  return (likelihood - 0.5) * 10;
}

function toTopPct(severity) {
  return (10 - severity + 0.5) * 10;
}

function riskMatrixHtml(incident, mySeverity, myLikelihood) {
  const others = incident.votes.filter((v) => v.analystId !== state.me?.id);
  const dots = others
    .map(
      (v) =>
        `<div class="dot" style="left:${toLeftPct(v.likelihood)}%; top:${toTopPct(v.severity)}%;" title="${escapeHtml(v.codename)}: severity ${v.severity}, likelihood ${v.likelihood}"></div>`,
    )
    .join("");
  return `
    <div class="risk-matrix" role="img" aria-label="Risk matrix: severity on the vertical axis, likelihood on the horizontal axis">
      <div class="risk-matrix-grid">${GRID_CELLS_HTML}</div>
      <div class="risk-matrix-dots">
        ${dots}
        <div class="dot dot-mine" id="my-dot" style="left:${toLeftPct(myLikelihood)}%; top:${toTopPct(mySeverity)}%;" title="Your position"></div>
      </div>
    </div>
    <p class="matrix-caption muted">severity &uarr; &middot; likelihood &rarr;</p>`;
}

function renderMe() {
  el.me.textContent = state.me ? `You are: ${state.me.codename}` : "connecting…";
}

// The role is secret per-round flavor: it never changes what the server will
// accept from this analyst, only what's shown to them.
function renderRole() {
  if (state.phase === "lobby") {
    el.roleBanner.hidden = true;
    return;
  }
  el.roleBanner.hidden = false;
  if (state.role === "INSIDER_THREAT") {
    el.roleBanner.textContent = "SECRET ROLE: INSIDER THREAT — Blend in. Drag the room off target.";
    el.roleBanner.className = "role-banner saboteur";
  } else {
    el.roleBanner.textContent = "ROLE: ANALYST";
    el.roleBanner.className = "role-banner analyst";
  }
}

function renderSections() {
  el.lobbySection.hidden = state.phase !== "lobby";
  el.activeSection.hidden = state.phase !== "threat";
  el.auditSection.hidden = state.phase !== "audit";
  el.resultsSection.hidden = state.phase !== "resolved";
}

function renderLobby() {
  if (state.phase !== "lobby") return;
  el.lobbyStatus.textContent = state.readyToStart
    ? `${state.players.length} analysts connected. Ready to start.`
    : `${state.players.length} analyst${state.players.length === 1 ? "" : "s"} connected — need at least 3 to start a shift.`;
  el.lobbyPlayers.innerHTML = state.players
    .map((p) => `<li>${escapeHtml(p.codename)}${p.id === state.me?.id ? " (you)" : ""}</li>`)
    .join("");
  el.startShift.disabled = !state.readyToStart;
}

function activeCardHtml(incident) {
  const myVote = incident.votes.find((v) => v.analystId === state.me?.id);
  const severity = myVote?.severity ?? 5;
  const likelihood = myVote?.likelihood ?? 5;
  // One vote per analyst per threat is enforced server-side; a second
  // attempt gets rejected, not applied as an update. Disabling the controls
  // once a vote exists keeps the UI from inviting an action the server will
  // refuse — this is convenience, not the actual enforcement.
  const locked = !!myVote;
  return `
    <article class="threat">
      <div class="threat-info">
        <h3>${escapeHtml(incident.title)}</h3>
        <p>${escapeHtml(incident.description)}</p>
        <p class="hint">${escapeHtml(incident.hint)}</p>
        <p class="meta">${incident.category} · ${incident.votes.length} vote${incident.votes.length === 1 ? "" : "s"}</p>
      </div>
      <div class="vote-controls">
        ${riskMatrixHtml(incident, severity, likelihood)}
        <label>Severity <span data-sev-out>${severity}</span>
          <input type="range" min="1" max="10" value="${severity}" data-sev ${locked ? "disabled" : ""} />
        </label>
        <label>Likelihood <span data-like-out>${likelihood}</span>
          <input type="range" min="1" max="10" value="${likelihood}" data-like ${locked ? "disabled" : ""} />
        </label>
        <button type="button" data-vote ${locked ? "disabled" : ""}>${locked ? "Vote locked in" : "Cast vote"}</button>
      </div>
    </article>`;
}

function renderActive() {
  if (state.phase !== "threat" || !state.active) return;
  el.threatProgress.textContent = `(${state.threatIndex + 1} of ${state.totalThreats})`;
  el.activeCard.innerHTML = activeCardHtml(state.active);

  const sevInput = el.activeCard.querySelector("[data-sev]");
  const likeInput = el.activeCard.querySelector("[data-like]");
  const sevOut = el.activeCard.querySelector("[data-sev-out]");
  const likeOut = el.activeCard.querySelector("[data-like-out]");
  const myDot = el.activeCard.querySelector("#my-dot");

  const updateMyDot = () => {
    myDot.style.left = `${toLeftPct(Number(likeInput.value))}%`;
    myDot.style.top = `${toTopPct(Number(sevInput.value))}%`;
  };
  sevInput.addEventListener("input", () => {
    sevOut.textContent = sevInput.value;
    updateMyDot();
  });
  likeInput.addEventListener("input", () => {
    likeOut.textContent = likeInput.value;
    updateMyDot();
  });
  el.activeCard.querySelector("[data-vote]").addEventListener("click", () => {
    send({
      type: "vote",
      incidentId: state.active.id,
      severity: Number(sevInput.value),
      likelihood: Number(likeInput.value),
    });
  });
}

function renderAuditCandidates() {
  if (state.phase !== "audit") return;
  el.auditCandidates.innerHTML = state.auditCandidates
    .map((p) => {
      const count = state.auditTally[p.id] ?? 0;
      const isMe = p.id === state.me?.id;
      const votedForThem = state.myAuditVote === p.id;
      return `
        <li>
          <button type="button" class="audit-candidate${votedForThem ? " voted" : ""}" data-target="${p.id}" ${state.myAuditVote ? "disabled" : ""}>
            <span class="audit-codename">${escapeHtml(p.codename)}${isMe ? " (you)" : ""}</span>
            <span class="audit-votes">${count} vote${count === 1 ? "" : "s"}</span>
          </button>
        </li>`;
    })
    .join("");

  el.auditCandidates.querySelectorAll("[data-target]").forEach((btn) => {
    btn.addEventListener("click", () => {
      send({ type: "audit:vote", targetId: btn.dataset.target });
    });
  });
}

function renderResults() {
  if (state.phase !== "resolved" || !state.result) return;
  const r = state.result;
  const ejectedLine = r.ejectedCodename
    ? `<p><strong>${escapeHtml(r.ejectedCodename)}</strong> was ejected. They <strong>${r.wasInsider ? "WERE" : "WERE NOT"}</strong> the Insider Threat.</p>`
    : `<p>No majority was reached — nobody was ejected.</p>`;
  el.resultsBody.innerHTML = `
    ${ejectedLine}
    <p>The Insider Threat was <strong>${escapeHtml(r.insiderCodename)}</strong>.</p>
    <p class="winner-line">${r.winner === "ANALYSTS" ? "ANALYSTS WIN" : "INSIDER THREAT WINS"}</p>
  `;
}

function renderRevokedOverlay() {
  const revoked = state.phase === "resolved" && state.result?.youWereRevoked;
  el.revokedOverlay.hidden = !revoked;
}

let countdownTimer = null;
let lastTickedSecond = null;

function renderCountdown() {
  clearInterval(countdownTimer);
  lastTickedSecond = null;
  if (state.phase !== "threat") {
    el.countdown.classList.remove("critical");
    return;
  }

  const tick = () => {
    const remainingMs = Math.max(0, state.deadline - Date.now());
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    el.countdownNumber.textContent = String(remainingSeconds);
    el.countdownFill.style.width = `${(remainingMs / THREAT_DURATION_MS) * 100}%`;
    el.countdown.classList.toggle("critical", remainingMs > 0 && remainingMs <= CRITICAL_THRESHOLD_MS);

    if (remainingSeconds <= 5 && remainingSeconds >= 1 && remainingSeconds !== lastTickedSecond) {
      lastTickedSecond = remainingSeconds;
      playTick();
    }
    if (remainingMs <= 0) clearInterval(countdownTimer);
  };
  tick();
  countdownTimer = setInterval(tick, 200);
}

let auditCountdownTimer = null;
let lastAuditTickedSecond = null;

function renderAuditCountdown() {
  clearInterval(auditCountdownTimer);
  lastAuditTickedSecond = null;
  if (state.phase !== "audit") return;

  const tick = () => {
    const remainingMs = Math.max(0, state.deadline - Date.now());
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    el.auditCountdownNumber.textContent = String(remainingSeconds);
    el.auditCountdownFill.style.width = `${(remainingMs / AUDIT_DURATION_MS) * 100}%`;
    el.auditCountdown.classList.toggle("critical", remainingMs > 0 && remainingMs <= CRITICAL_THRESHOLD_MS);

    if (remainingSeconds <= 5 && remainingSeconds >= 1 && remainingSeconds !== lastAuditTickedSecond) {
      lastAuditTickedSecond = remainingSeconds;
      playTick();
    }
    if (remainingMs <= 0) clearInterval(auditCountdownTimer);
  };
  tick();
  auditCountdownTimer = setInterval(tick, 200);
}

function renderAll() {
  renderMe();
  renderRole();
  renderSections();
  renderLobby();
  renderActive();
  renderCountdown();
  renderAuditCandidates();
  renderAuditCountdown();
  renderResults();
  renderRevokedOverlay();
}

function applySnapshot(snapshot) {
  state.phase = snapshot.phase;
  if (snapshot.phase === "lobby") {
    state.players = snapshot.players;
    state.readyToStart = snapshot.readyToStart;
  } else if (snapshot.phase === "threat") {
    state.role = snapshot.role;
    state.active = snapshot.active;
    state.threatIndex = snapshot.threatIndex;
    state.totalThreats = snapshot.totalThreats;
    state.deadline = snapshot.deadline;
  } else if (snapshot.phase === "audit") {
    state.role = snapshot.role;
    state.deadline = snapshot.deadline;
    state.auditCandidates = snapshot.candidates;
    state.auditTally = snapshot.tally;
    state.myAuditVote = null;
  } else if (snapshot.phase === "resolved") {
    state.role = snapshot.role;
    state.result = {
      ejectedId: snapshot.ejectedId,
      ejectedCodename: snapshot.ejectedCodename,
      wasInsider: snapshot.wasInsider,
      winner: snapshot.winner,
      insiderCodename: snapshot.insiderCodename,
      youWereRevoked: snapshot.youWereRevoked,
    };
  }
}

function applyHello(msg) {
  state.me = msg.me;
  applySnapshot(msg);
  renderAll();
}

function applyMessage(msg) {
  switch (msg.type) {
    case "hello":
      applyHello(msg);
      break;
    case "lobby:update":
      state.phase = "lobby";
      state.players = msg.players;
      state.readyToStart = msg.readyToStart;
      renderAll();
      break;
    case "game:role":
      state.role = msg.role;
      renderRole();
      break;
    case "threat:new":
      state.phase = "threat";
      state.active = msg.incident;
      state.threatIndex = msg.threatIndex;
      state.totalThreats = msg.totalThreats;
      state.deadline = msg.deadline;
      renderAll();
      break;
    case "vote:cast": {
      if (state.active?.id !== msg.incidentId) break;
      const existing = state.active.votes.find((v) => v.analystId === msg.analystId);
      if (existing) {
        existing.severity = msg.severity;
        existing.likelihood = msg.likelihood;
      } else {
        state.active.votes.push({
          analystId: msg.analystId,
          codename: msg.codename,
          severity: msg.severity,
          likelihood: msg.likelihood,
        });
      }
      renderActive();
      break;
    }
    case "threat:resolved":
      if (msg.incident.outcome !== "ignored") {
        if ((msg.incident.consensusScore ?? 0) >= 60) playConsensusDing();
        else playBreachBuzzer();
      }
      break;
    case "audit:start":
      state.phase = "audit";
      state.deadline = msg.deadline;
      state.auditCandidates = msg.candidates;
      state.auditTally = {};
      state.myAuditVote = null;
      renderAll();
      break;
    case "audit:tally":
      state.auditTally = msg.tally;
      if (msg.voterId === state.me?.id) state.myAuditVote = msg.targetId;
      renderAuditCandidates();
      break;
    case "game:ejected":
      state.phase = "resolved";
      state.result = {
        ejectedId: msg.ejectedId,
        ejectedCodename: msg.ejectedCodename,
        wasInsider: msg.wasInsider,
        winner: msg.winner,
        insiderCodename: msg.insiderCodename,
        youWereRevoked: msg.ejectedId === state.me?.id,
      };
      renderAll();
      if (msg.wasInsider) playConsensusDing();
      else playEjectBuzzer();
      break;
    case "game:revoked":
      renderRevokedOverlay();
      break;
    case "game:reset":
      state.phase = "lobby";
      state.role = "ANALYST";
      state.active = null;
      state.threatIndex = 0;
      state.result = null;
      state.myAuditVote = null;
      renderAll();
      break;
  }
}

let socket;
let reconnectDelay = 500;

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.addEventListener("open", () => (reconnectDelay = 500));
  socket.addEventListener("message", (event) => applyMessage(JSON.parse(event.data)));
  socket.addEventListener("close", () => {
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
  });
}

el.startShift.addEventListener("click", () => {
  send({ type: "game:start" });
});

el.playAgain.addEventListener("click", () => {
  send({ type: "game:play-again" });
});

// Hitting `/` first (a normal page load) is what sets the identity cookie
// the WS upgrade relies on, so no separate bootstrap fetch is needed here.
connect();
