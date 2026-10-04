const state = {
  me: null,
  openIncidents: new Map(),
  resolvedHistory: [],
  leaderboard: new Map(),
};

const el = {
  me: document.getElementById("me"),
  incidentList: document.getElementById("incident-list"),
  noIncidents: document.getElementById("no-incidents"),
  historyList: document.getElementById("history-list"),
  leaderboardBody: document.getElementById("leaderboard-body"),
  reportForm: document.getElementById("report-form"),
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function riskMatrixSvg(votes) {
  const toX = (severity) => 10 + (severity - 1) * 20;
  const toY = (likelihood) => 90 - (likelihood - 1) * 20;
  const dots = votes
    .map(
      (v) =>
        `<circle cx="${toX(v.severity)}" cy="${toY(v.likelihood)}" r="3.5" fill="#4fd1c5" fill-opacity="0.85"><title>${escapeHtml(v.codename)}: severity ${v.severity}, likelihood ${v.likelihood}</title></circle>`,
    )
    .join("");
  return `<svg class="risk-matrix" viewBox="0 0 100 100" width="140" height="140" role="img" aria-label="Risk matrix: severity vs likelihood">
    <line x1="10" y1="90" x2="90" y2="90" stroke="#233040" />
    <line x1="10" y1="10" x2="10" y2="90" stroke="#233040" />
    <text x="50" y="99" font-size="6" fill="#7d8da1" text-anchor="middle">severity</text>
    <text x="3" y="50" font-size="6" fill="#7d8da1" text-anchor="middle" transform="rotate(-90 3 50)">likelihood</text>
    ${dots}
  </svg>`;
}

function renderMe() {
  el.me.textContent = state.me ? `You are: ${state.me.codename}` : "connecting…";
}

function incidentCard(incident) {
  const myVote = incident.votes.find((v) => v.analystId === state.me?.id);
  return `
    <article class="incident" data-id="${incident.id}">
      <div>
        <h3>${escapeHtml(incident.title)}</h3>
        <p>${escapeHtml(incident.description)}</p>
        <p class="meta">${incident.category} · ${incident.source === "analyst" ? "reported by an analyst" : "auto-detected"} · ${incident.votes.length} vote${incident.votes.length === 1 ? "" : "s"}</p>
      </div>
      <div class="vote-controls">
        ${riskMatrixSvg(incident.votes)}
        <label>Severity <span data-sev-out>${myVote?.severity ?? 3}</span>
          <input type="range" min="1" max="5" value="${myVote?.severity ?? 3}" data-sev />
        </label>
        <label>Likelihood <span data-like-out>${myVote?.likelihood ?? 3}</span>
          <input type="range" min="1" max="5" value="${myVote?.likelihood ?? 3}" data-like />
        </label>
        <button type="button" data-vote>${myVote ? "Update vote" : "Cast vote"}</button>
      </div>
    </article>`;
}

function renderIncidents() {
  const incidents = [...state.openIncidents.values()].sort((a, b) => a.createdAt - b.createdAt);
  el.noIncidents.hidden = incidents.length > 0;
  el.incidentList.innerHTML = incidents.map(incidentCard).join("");

  for (const article of el.incidentList.querySelectorAll(".incident")) {
    const id = article.dataset.id;
    const sevInput = article.querySelector("[data-sev]");
    const likeInput = article.querySelector("[data-like]");
    const sevOut = article.querySelector("[data-sev-out]");
    const likeOut = article.querySelector("[data-like-out]");
    sevInput.addEventListener("input", () => (sevOut.textContent = sevInput.value));
    likeInput.addEventListener("input", () => (likeOut.textContent = likeInput.value));
    article.querySelector("[data-vote]").addEventListener("click", () => {
      send({
        type: "vote",
        incidentId: id,
        severity: Number(sevInput.value),
        likelihood: Number(likeInput.value),
      });
    });
  }
}

function outcomeBadge(outcome) {
  const label = { true_positive: "true positive", false_positive: "false positive", unresolved: "unresolved" }[outcome];
  return `<span class="badge ${outcome}">${label}</span>`;
}

function renderHistory() {
  el.historyList.innerHTML = state.resolvedHistory
    .map(
      (incident) => `
      <article class="incident" style="grid-template-columns: 1fr;">
        <div>
          <h3>${escapeHtml(incident.title)} ${outcomeBadge(incident.outcome)}</h3>
          <p class="meta">consensus score ${incident.consensusScore} · severity ${incident.consensusSeverity?.toFixed(1)} · likelihood ${incident.consensusLikelihood?.toFixed(1)}</p>
        </div>
      </article>`,
    )
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
  state.openIncidents = new Map(msg.openIncidents.map((i) => [i.id, i]));
  state.resolvedHistory = msg.recentResolved;
  state.leaderboard = new Map(msg.leaderboard.map((e) => [e.id, e]));
  renderMe();
  renderIncidents();
  renderHistory();
  renderLeaderboard();
}

function applyMessage(msg) {
  switch (msg.type) {
    case "hello":
      applyHello(msg);
      break;
    case "incident:new":
      state.openIncidents.set(msg.incident.id, msg.incident);
      renderIncidents();
      break;
    case "vote:cast": {
      const incident = state.openIncidents.get(msg.incidentId);
      if (!incident) break;
      const existing = incident.votes.find((v) => v.analystId === msg.analystId);
      if (existing) {
        existing.severity = msg.severity;
        existing.likelihood = msg.likelihood;
      } else {
        incident.votes.push({ analystId: msg.analystId, codename: msg.codename, severity: msg.severity, likelihood: msg.likelihood });
      }
      renderIncidents();
      break;
    }
    case "incident:resolved":
      state.openIncidents.delete(msg.incident.id);
      state.resolvedHistory.unshift(msg.incident);
      state.resolvedHistory = state.resolvedHistory.slice(0, 20);
      renderIncidents();
      renderHistory();
      break;
    case "analyst:stats":
      state.leaderboard.set(msg.entry.id, msg.entry);
      renderLeaderboard();
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

el.reportForm.addEventListener("submit", (event) => {
  event.preventDefault();
  send({
    type: "incident:create",
    title: document.getElementById("report-title").value,
    description: document.getElementById("report-description").value,
    category: document.getElementById("report-category").value,
  });
  el.reportForm.reset();
});

// Hitting `/` first (a normal page load) is what sets the identity cookie
// the WS upgrade relies on, so no separate bootstrap fetch is needed here.
connect();
