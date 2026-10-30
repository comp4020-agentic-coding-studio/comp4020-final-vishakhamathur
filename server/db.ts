import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import type { Analyst, Incident, IncidentCategory, IncidentOutcome, IncidentView, Vote, VoteView } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS analysts (
  id         TEXT PRIMARY KEY,
  codename   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
  id                    TEXT PRIMARY KEY,
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL,
  category              TEXT NOT NULL,
  source                TEXT NOT NULL,
  created_by            TEXT,
  created_at            INTEGER NOT NULL,
  status                TEXT NOT NULL,
  resolved_at           INTEGER,
  consensus_severity    REAL,
  consensus_likelihood  REAL,
  consensus_score       REAL,
  outcome               TEXT
);

CREATE TABLE IF NOT EXISTS votes (
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  analyst_id  TEXT NOT NULL REFERENCES analysts(id),
  severity    INTEGER NOT NULL,
  likelihood  INTEGER NOT NULL,
  cast_at     INTEGER NOT NULL,
  PRIMARY KEY (incident_id, analyst_id)
);

CREATE INDEX IF NOT EXISTS idx_votes_incident ON votes(incident_id);

CREATE TABLE IF NOT EXISTS action_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  analyst_id  TEXT NOT NULL,
  codename    TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail      TEXT,
  at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_action_log_at ON action_log(at);
`;

interface AnalystRow {
  id: string;
  codename: string;
  created_at: number;
}

interface IncidentRow {
  id: string;
  title: string;
  description: string;
  category: string;
  source: string;
  created_by: string | null;
  created_at: number;
  status: string;
  resolved_at: number | null;
  consensus_severity: number | null;
  consensus_likelihood: number | null;
  consensus_score: number | null;
  outcome: string | null;
}

interface VoteRow {
  incident_id: string;
  analyst_id: string;
  severity: number;
  likelihood: number;
  cast_at: number;
}

function analystFromRow(row: AnalystRow): Analyst {
  return { id: row.id, codename: row.codename, createdAt: row.created_at, votesCast: 0 };
}

function incidentFromRow(row: IncidentRow): Incident {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category as IncidentCategory,
    source: row.source as Incident["source"],
    createdBy: row.created_by,
    createdAt: row.created_at,
    status: row.status as Incident["status"],
    resolvedAt: row.resolved_at,
    consensusSeverity: row.consensus_severity,
    consensusLikelihood: row.consensus_likelihood,
    consensusScore: row.consensus_score,
    outcome: row.outcome as IncidentOutcome | null,
  };
}

function voteFromRow(row: VoteRow): Vote {
  return {
    incidentId: row.incident_id,
    analystId: row.analyst_id,
    severity: row.severity,
    likelihood: row.likelihood,
    castAt: row.cast_at,
  };
}

export class Db {
  private raw: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.raw = new DatabaseSync(`${dataDir}/app.db`);
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    this.raw.exec(SCHEMA);
  }

  getAnalyst(id: string): Analyst | undefined {
    const row = this.raw.prepare("SELECT id, codename, created_at FROM analysts WHERE id = ?").get(id) as unknown as
      | AnalystRow
      | undefined;
    return row ? analystFromRow(row) : undefined;
  }

  createAnalyst(id: string, codename: string): Analyst {
    const createdAt = Date.now();
    this.raw.prepare("INSERT INTO analysts (id, codename, created_at) VALUES (?, ?, ?)").run(id, codename, createdAt);
    return { id, codename, createdAt, votesCast: 0 };
  }

  // Persistence only — the durable, queryable record of who did what, for
  // the Week 11 authorization/logging requirement. Live, human-readable
  // narration for the in-class demo is a separate concern (`narrate` in
  // server/index.ts).
  logAction(analystId: string, codename: string, action: string, detail?: string): void {
    const at = Date.now();
    this.raw
      .prepare("INSERT INTO action_log (analyst_id, codename, action, detail, at) VALUES (?, ?, ?, ?, ?)")
      .run(analystId, codename, action, detail ?? null, at);
  }

  createIncident(input: { id: string; title: string; description: string; category: IncidentCategory }): Incident {
    const createdAt = Date.now();
    this.raw
      .prepare(
        `INSERT INTO incidents (id, title, description, category, source, created_by, created_at, status)
         VALUES (?, ?, ?, ?, 'generator', NULL, ?, 'open')`,
      )
      .run(input.id, input.title, input.description, input.category, createdAt);
    return {
      id: input.id,
      title: input.title,
      description: input.description,
      category: input.category,
      source: "generator",
      createdBy: null,
      createdAt,
      status: "open",
      resolvedAt: null,
      consensusSeverity: null,
      consensusLikelihood: null,
      consensusScore: null,
      outcome: null,
    };
  }

  getIncident(id: string): Incident | undefined {
    const row = this.raw.prepare("SELECT * FROM incidents WHERE id = ?").get(id) as unknown as IncidentRow | undefined;
    return row ? incidentFromRow(row) : undefined;
  }

  getVotes(incidentId: string): Vote[] {
    const rows = this.raw
      .prepare("SELECT * FROM votes WHERE incident_id = ? ORDER BY cast_at ASC")
      .all(incidentId) as unknown as VoteRow[];
    return rows.map(voteFromRow);
  }

  // Strict one-session-one-vote-per-threat: a (incident, analyst) row, once
  // inserted, can't be replaced — a second attempt is rejected outright
  // rather than treated as an update. Returns false if this analyst already
  // voted on this incident.
  insertVote(incidentId: string, analystId: string, severity: number, likelihood: number): boolean {
    const existing = this.raw
      .prepare("SELECT 1 FROM votes WHERE incident_id = ? AND analyst_id = ?")
      .get(incidentId, analystId);
    if (existing) return false;

    const castAt = Date.now();
    this.raw
      .prepare("INSERT INTO votes (incident_id, analyst_id, severity, likelihood, cast_at) VALUES (?, ?, ?, ?, ?)")
      .run(incidentId, analystId, severity, likelihood, castAt);
    return true;
  }

  resolveIncident(
    id: string,
    fields: {
      consensusSeverity: number | null;
      consensusLikelihood: number | null;
      consensusScore: number | null;
      outcome: IncidentOutcome;
    },
  ): Incident {
    const resolvedAt = Date.now();
    this.raw
      .prepare(
        `UPDATE incidents SET status = 'resolved', resolved_at = ?, consensus_severity = ?,
         consensus_likelihood = ?, consensus_score = ?, outcome = ? WHERE id = ?`,
      )
      .run(resolvedAt, fields.consensusSeverity, fields.consensusLikelihood, fields.consensusScore, fields.outcome, id);
    const incident = this.getIncident(id);
    if (!incident) throw new Error(`incident ${id} vanished during resolution`);
    return incident;
  }

  incidentView(incident: Incident): IncidentView {
    const rows = this.raw
      .prepare(
        `SELECT v.*, a.codename AS codename FROM votes v JOIN analysts a ON a.id = v.analyst_id
         WHERE v.incident_id = ? ORDER BY v.cast_at ASC`,
      )
      .all(incident.id) as unknown as (VoteRow & { codename: string })[];
    const votes: VoteView[] = rows.map((row) => ({
      analystId: row.analyst_id,
      codename: row.codename,
      severity: row.severity,
      likelihood: row.likelihood,
    }));
    return { ...incident, votes };
  }
}
