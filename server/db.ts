import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import type {
  Analyst,
  Incident,
  IncidentCategory,
  IncidentOutcome,
  IncidentSource,
  IncidentView,
  LeaderboardEntry,
  Vote,
  VoteView,
} from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS analysts (
  id              TEXT PRIMARY KEY,
  codename        TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  votes_cast      INTEGER NOT NULL DEFAULT 0,
  agreement_sum   REAL    NOT NULL DEFAULT 0,
  agreement_count INTEGER NOT NULL DEFAULT 0,
  insider_flags   INTEGER NOT NULL DEFAULT 0
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
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status, created_at);
`;

interface AnalystRow {
  id: string;
  codename: string;
  created_at: number;
  votes_cast: number;
  agreement_sum: number;
  agreement_count: number;
  insider_flags: number;
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
  return {
    id: row.id,
    codename: row.codename,
    createdAt: row.created_at,
    votesCast: row.votes_cast,
    agreementSum: row.agreement_sum,
    agreementCount: row.agreement_count,
    insiderFlags: row.insider_flags,
  };
}

function incidentFromRow(row: IncidentRow): Incident {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category as IncidentCategory,
    source: row.source as IncidentSource,
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
    const row = this.raw.prepare("SELECT * FROM analysts WHERE id = ?").get(id) as unknown as AnalystRow | undefined;
    return row ? analystFromRow(row) : undefined;
  }

  createAnalyst(id: string, codename: string): Analyst {
    const createdAt = Date.now();
    this.raw
      .prepare("INSERT INTO analysts (id, codename, created_at) VALUES (?, ?, ?)")
      .run(id, codename, createdAt);
    return { id, codename, createdAt, votesCast: 0, agreementSum: 0, agreementCount: 0, insiderFlags: 0 };
  }

  createIncident(input: {
    id: string;
    title: string;
    description: string;
    category: IncidentCategory;
    source: IncidentSource;
    createdBy: string | null;
  }): Incident {
    const createdAt = Date.now();
    this.raw
      .prepare(
        `INSERT INTO incidents (id, title, description, category, source, created_by, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
      )
      .run(input.id, input.title, input.description, input.category, input.source, input.createdBy, createdAt);
    return {
      id: input.id,
      title: input.title,
      description: input.description,
      category: input.category,
      source: input.source,
      createdBy: input.createdBy,
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

  getOpenIncidents(): Incident[] {
    const rows = this.raw
      .prepare("SELECT * FROM incidents WHERE status = 'open' ORDER BY created_at ASC")
      .all() as unknown as IncidentRow[];
    return rows.map(incidentFromRow);
  }

  getResolvedIncidents(limit: number): Incident[] {
    const rows = this.raw
      .prepare("SELECT * FROM incidents WHERE status = 'resolved' ORDER BY resolved_at DESC LIMIT ?")
      .all(limit) as unknown as IncidentRow[];
    return rows.map(incidentFromRow);
  }

  openIncidentCount(): number {
    const row = this.raw.prepare("SELECT COUNT(*) AS n FROM incidents WHERE status = 'open'").get() as { n: number };
    return row.n;
  }

  getVotes(incidentId: string): Vote[] {
    const rows = this.raw
      .prepare("SELECT * FROM votes WHERE incident_id = ? ORDER BY cast_at ASC")
      .all(incidentId) as unknown as VoteRow[];
    return rows.map(voteFromRow);
  }

  getVoteCount(incidentId: string): number {
    const row = this.raw
      .prepare("SELECT COUNT(*) AS n FROM votes WHERE incident_id = ?")
      .get(incidentId) as { n: number };
    return row.n;
  }

  upsertVote(incidentId: string, analystId: string, severity: number, likelihood: number): void {
    const castAt = Date.now();
    const existing = this.raw
      .prepare("SELECT 1 FROM votes WHERE incident_id = ? AND analyst_id = ?")
      .get(incidentId, analystId);
    if (existing) {
      this.raw
        .prepare("UPDATE votes SET severity = ?, likelihood = ?, cast_at = ? WHERE incident_id = ? AND analyst_id = ?")
        .run(severity, likelihood, castAt, incidentId, analystId);
    } else {
      this.raw
        .prepare("INSERT INTO votes (incident_id, analyst_id, severity, likelihood, cast_at) VALUES (?, ?, ?, ?, ?)")
        .run(incidentId, analystId, severity, likelihood, castAt);
      this.raw.prepare("UPDATE analysts SET votes_cast = votes_cast + 1 WHERE id = ?").run(analystId);
    }
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

  recordAnalystOutcome(analystId: string, agreement: number, isInsiderOutlier: boolean): LeaderboardEntry {
    this.raw
      .prepare(
        `UPDATE analysts SET agreement_sum = agreement_sum + ?, agreement_count = agreement_count + 1,
         insider_flags = insider_flags + ? WHERE id = ?`,
      )
      .run(agreement, isInsiderOutlier ? 1 : 0, analystId);
    const analyst = this.getAnalyst(analystId);
    if (!analyst) throw new Error(`analyst ${analystId} vanished during stats update`);
    return leaderboardEntry(analyst);
  }

  getLeaderboard(): LeaderboardEntry[] {
    const rows = this.raw.prepare("SELECT * FROM analysts ORDER BY codename ASC").all() as unknown as AnalystRow[];
    return rows.map(analystFromRow).map(leaderboardEntry);
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

function leaderboardEntry(analyst: Analyst): LeaderboardEntry {
  const agreementRate = analyst.agreementCount > 0 ? analyst.agreementSum / analyst.agreementCount : null;
  const insiderFlagged = analyst.agreementCount >= 3 && analyst.insiderFlags / analyst.agreementCount > 0.4;
  return {
    id: analyst.id,
    codename: analyst.codename,
    votesCast: analyst.votesCast,
    agreementRate,
    insiderFlags: analyst.insiderFlags,
    insiderFlagged,
  };
}
