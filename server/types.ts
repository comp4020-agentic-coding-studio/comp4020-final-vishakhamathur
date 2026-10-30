export type IncidentCategory = "login" | "exfiltration" | "malware" | "network" | "insider";
export type IncidentSource = "generator" | "analyst";
export type IncidentStatus = "queued" | "open" | "resolved";
export type IncidentOutcome = "true_positive" | "false_positive" | "unresolved" | "ignored";

export interface Analyst {
  id: string;
  codename: string;
  createdAt: number;
  votesCast: number;
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
  // A plain-language gloss of the jargon in `description`, shown to
  // players so judging severity/likelihood doesn't require a security
  // background — see server/generator.ts.
  hint: string;
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

// --- Among Us-style round game: lobby -> threat x3 -> audit -> resolved ---

export type GamePhase = "lobby" | "threat" | "audit" | "resolved";
export type GameRole = "ANALYST" | "INSIDER_THREAT";

export interface PlayerInfo {
  id: string;
  codename: string;
}

export type GameSnapshot =
  | { phase: "lobby"; players: PlayerInfo[]; readyToStart: boolean }
  | { phase: "threat"; role: GameRole; threatIndex: number; totalThreats: number; deadline: number; active: IncidentView }
  | { phase: "audit"; role: GameRole; deadline: number; candidates: PlayerInfo[]; tally: Record<string, number> }
  | {
      phase: "resolved";
      role: GameRole;
      ejectedId: string | null;
      ejectedCodename: string | null;
      wasInsider: boolean;
      winner: "ANALYSTS" | "INSIDER";
      insiderCodename: string;
      youWereRevoked: boolean;
    };

export type ServerMessage =
  | ({ type: "hello"; me: { id: string; codename: string } } & GameSnapshot)
  | { type: "lobby:update"; players: PlayerInfo[]; readyToStart: boolean }
  | { type: "game:role"; role: GameRole }
  | { type: "threat:new"; incident: IncidentView; threatIndex: number; totalThreats: number; deadline: number }
  | { type: "vote:cast"; incidentId: string; analystId: string; codename: string; severity: number; likelihood: number }
  | { type: "threat:resolved"; incident: Incident; threatIndex: number }
  | { type: "audit:start"; deadline: number; candidates: PlayerInfo[] }
  | {
      type: "audit:tally";
      voterId: string;
      voterCodename: string;
      targetId: string;
      targetCodename: string;
      tally: Record<string, number>;
    }
  | {
      type: "game:ejected";
      ejectedId: string | null;
      ejectedCodename: string | null;
      wasInsider: boolean;
      winner: "ANALYSTS" | "INSIDER";
      insiderCodename: string;
    }
  | { type: "game:revoked" }
  | { type: "game:reset" };

export type ClientMessage =
  | { type: "game:start" }
  | { type: "vote"; incidentId: string; severity: number; likelihood: number }
  | { type: "audit:vote"; targetId: string }
  | { type: "game:play-again" };
