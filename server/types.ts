export type IncidentCategory = "login" | "exfiltration" | "malware" | "network" | "insider";
export type IncidentSource = "generator" | "analyst";
export type IncidentStatus = "open" | "resolved";
export type IncidentOutcome = "true_positive" | "false_positive" | "unresolved";

export interface Analyst {
  id: string;
  codename: string;
  createdAt: number;
  votesCast: number;
  agreementSum: number;
  agreementCount: number;
  insiderFlags: number;
}

export interface Vote {
  incidentId: string;
  analystId: string;
  severity: number;
  likelihood: number;
  castAt: number;
}

export interface VoteView {
  analystId: string;
  codename: string;
  severity: number;
  likelihood: number;
}

export interface Incident {
  id: string;
  title: string;
  description: string;
  category: IncidentCategory;
  source: IncidentSource;
  createdBy: string | null;
  createdAt: number;
  status: IncidentStatus;
  resolvedAt: number | null;
  consensusSeverity: number | null;
  consensusLikelihood: number | null;
  consensusScore: number | null;
  outcome: IncidentOutcome | null;
}

export interface IncidentView extends Incident {
  votes: VoteView[];
}

export interface LeaderboardEntry {
  id: string;
  codename: string;
  votesCast: number;
  agreementRate: number | null;
  insiderFlags: number;
  insiderFlagged: boolean;
}

export type ServerMessage =
  | { type: "hello"; me: { id: string; codename: string }; openIncidents: IncidentView[]; recentResolved: Incident[]; leaderboard: LeaderboardEntry[] }
  | { type: "incident:new"; incident: IncidentView }
  | { type: "vote:cast"; incidentId: string; analystId: string; codename: string; severity: number; likelihood: number }
  | { type: "incident:resolved"; incident: Incident }
  | { type: "analyst:stats"; entry: LeaderboardEntry };

export type ClientMessage =
  | { type: "vote"; incidentId: string; severity: number; likelihood: number }
  | { type: "incident:create"; title: string; description: string; category: IncidentCategory };
