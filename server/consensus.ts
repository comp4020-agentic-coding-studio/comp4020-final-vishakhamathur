import type { IncidentOutcome, Vote } from "./types.ts";

function mean(xs: number[]): number {
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

function stdev(xs: number[], avg: number): number {
  return Math.sqrt(mean(xs.map((x) => (x - avg) ** 2)));
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export interface Resolution {
  consensusSeverity: number;
  consensusLikelihood: number;
  consensusScore: number;
  agreement: number;
  outcome: IncidentOutcome;
}

// Max stdev on a 1..5 scale (votes split at the extremes) is 2.0, so that's
// the divisor that maps spread onto a 0..1 agreement score.
const MAX_STDEV = 2;

export function resolveConsensus(votes: Vote[]): Resolution {
  const severities = votes.map((v) => v.severity);
  const likelihoods = votes.map((v) => v.likelihood);
  const consensusSeverity = mean(severities);
  const consensusLikelihood = mean(likelihoods);
  const spread = (stdev(severities, consensusSeverity) + stdev(likelihoods, consensusLikelihood)) / 2;
  const agreement = clamp(1 - spread / MAX_STDEV, 0, 1);
  const consensusScore = Math.round(agreement * 100);

  let outcome: IncidentOutcome;
  if (agreement < 0.6) {
    outcome = "unresolved";
  } else if (consensusSeverity * consensusLikelihood >= 9) {
    outcome = "true_positive";
  } else {
    outcome = "false_positive";
  }

  return { consensusSeverity, consensusLikelihood, consensusScore, agreement, outcome };
}

// Max per-vote deviation from the mean on a 1..5 scale, on both axes at once.
const MAX_DEVIATION = 4;

export interface AnalystOutcome {
  analystId: string;
  agreement: number;
  isInsiderOutlier: boolean;
}

export function analystAgreements(votes: Vote[], consensusSeverity: number, consensusLikelihood: number): AnalystOutcome[] {
  return votes.map((v) => {
    const deviation = Math.sqrt(((v.severity - consensusSeverity) ** 2 + (v.likelihood - consensusLikelihood) ** 2) / 2);
    const agreement = clamp(1 - deviation / MAX_DEVIATION, 0, 1);
    return { analystId: v.analystId, agreement, isInsiderOutlier: agreement < 0.3 };
  });
}
