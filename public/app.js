const ACTIVE_DURATION_MS = 15_000;

const state = {
  me: null,
  active: null,
  queueLength: 0,
  resolvedHistory: [],
  leaderboard: new Map(),
};

const el = {
  me: document.getElementById("me"),
  activeCard: document.getElementById("active-card"),
  noActive: document.getElementById("no-active"),
  countdownNumber: document.getElementById("countdown-number"),
  countdownFill: document.getElementById("countdown-fill"),
  queueStatus: document.getElementById("queue-status"),
  historyList: document.getElementById("history-list"),
  leaderboardBody: document.getElementById("leaderboard-body"),
  reportForm: document.getElementById("report-form"),
  reportFeedback: document.getElementById("report-feedback"),
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

function activeCardHtml(incident) {
  const myVote = incident.votes.find((v) => v.analystId === state.me?.id);
  const severity = myVote?.severity ?? 5;
  const likelihood = myVote?.likelihood ?? 5;
  return `
    <article class="threat">
      <div class="threat-info">
        <h3>${escapeHtml(incident.title)}</h3>
        <p>${escapeHtml(incident.description)}</p>
        <p class="meta">${incident.category} · ${incident.source === "analyst" ? "reported by an analyst" : "auto-detected"} · ${incident.votes.length} vote${incident.votes.length === 1 ? "" : "s"}</p>
      </div>
      <div class="vote-controls">
        ${riskMatrixHtml(incident, severity, likelihood)}
        <label>Severity <span data-sev-out>${severity}</span>
          <input type="range" min="1" max="10" value="${severity}" data-sev />
        </label>
        <label>Likelihood <span data-like-out>${likelihood}</span>
          <input type="range" min="1" max="10" value="${likelihood}" data-like />
        </label>
        <button type="button" data-vote>${myVote ? "Update vote" : "Cast vote"}</button>
      </div>
    </article>`;
}

function renderActive() {
  const incident = state.active;
  el.noActive.hidden = !!incident;
  if (!incident) {
    el.activeCard.innerHTML = "";
    return;
  }

  el.activeCard.innerHTML = activeCardHtml(incident);

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
      incidentId: incident.id,
      severity: Number(sevInput.value),
      likelihood: Number(likeInput.value),
    });
  });
}

let countdownTimer = null;

function renderCountdown() {
  clearInterval(countdownTimer);
  if (!state.active) {
    el.countdownNumber.textContent = "–";
    el.countdownFill.style.width = "0%";
    return;
  }

  const deadline = state.active.createdAt + ACTIVE_DURATION_MS;
  const tick = () => {
    const remainingMs = Math.max(0, deadline - Date.now());
    el.countdownNumber.textContent = String(Math.ceil(remainingMs / 1000));
    el.countdownFill.style.width = `${(remainingMs / ACTIVE_DURATION_MS) * 100}%`;
    if (remainingMs <= 0) clearInterval(countdownTimer);
  };
  tick();
  countdownTimer = setInterval(tick, 200);
}

function renderQueueStatus() {
  el.queueStatus.textContent =
    state.queueLength > 0
      ? `${state.queueLength} report${state.queueLength === 1 ? "" : "s"} queued behind the current threat.`
      : "Your report will go live as soon as the current threat resolves.";
}

function outcomeBadge(outcome) {
  const label = { true_positive: "true positive", false_positive: "false positive", unresolved: "unresolved", ignored: "ignored" }[
    outcome
  ];
  return `<span class="badge ${outcome}">${label}</span>`;
}

function renderHistory() {
  el.historyList.innerHTML = state.resolvedHistory
    .map((incident) => {
      const stats =
        incident.outcome === "ignored"
          ? "no votes cast"
          : `consensus score ${incident.consensusScore} · severity ${incident.consensusSeverity?.toFixed(1)} · likelihood ${incident.consensusLikelihood?.toFixed(1)}`;
      return `
      <article class="incident" style="grid-template-columns: 1fr;">
        <div>
          <h3>${escapeHtml(incident.title)} ${outcomeBadge(incident.outcome)}</h3>
          <p class="meta">${stats}</p>
        </div>
      </article>`;
    })
    .join("");
}

function renderLeaderboard() {
  const rows = [...state.leaderboard.values()].sort((a, b) => b.votesCast - a.votesCast);
  el.leaderboardBody.innerHTML = rows
    .map(
      (entry) => `
      <tr>
        <td>${escapeHtml(entry.codename)}</td>
        <td>${entry.votesCast}</td>
        <td>${entry.agreementRate === null ? "—" : `${Math.round(entry.agreementRate * 100)}%`}</td>
        <td>${entry.insiderFlagged ? '<span class="badge insider">possible insider</span>' : ""}</td>
      </tr>`,
    )
    .join("");
}

function applyHello(msg) {
  state.me = msg.me;
  state.active = msg.active;
  state.queueLength = msg.queueLength;
  state.resolvedHistory = msg.recentResolved;
  state.leaderboard = new Map(msg.leaderboard.map((e) => [e.id, e]));
  renderMe();
  renderActive();
  renderCountdown();
  renderQueueStatus();
  renderHistory();
  renderLeaderboard();
}

function applyMessage(msg) {
  switch (msg.type) {
    case "hello":
      applyHello(msg);
      break;
    case "incident:new":
      state.active = msg.incident;
      renderActive();
      renderCountdown();
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
    case "incident:resolved":
      if (state.active?.id === msg.incident.id) state.active = null;
      state.resolvedHistory.unshift(msg.incident);
      state.resolvedHistory = state.resolvedHistory.slice(0, 20);
      renderActive();
      renderCountdown();
      renderHistory();
      break;
    case "analyst:stats":
      state.leaderboard.set(msg.entry.id, msg.entry);
      renderLeaderboard();
      break;
    case "queue:update":
      state.queueLength = msg.queueLength;
      renderQueueStatus();
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

let feedbackTimer = null;

el.reportForm.addEventListener("submit", (event) => {
  event.preventDefault();
  send({
    type: "incident:create",
    title: document.getElementById("report-title").value,
    description: document.getElementById("report-description").value,
    category: document.getElementById("report-category").value,
  });
  el.reportForm.reset();

  clearTimeout(feedbackTimer);
  el.reportFeedback.textContent = "Report queued — it'll go live once earlier threats resolve.";
  el.reportFeedback.hidden = false;
  feedbackTimer = setTimeout(() => (el.reportFeedback.hidden = true), 4000);
});

// Hitting `/` first (a normal page load) is what sets the identity cookie
// the WS upgrade relies on, so no separate bootstrap fetch is needed here.
connect();
