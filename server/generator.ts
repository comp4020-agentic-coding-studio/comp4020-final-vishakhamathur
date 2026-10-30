import type { IncidentCategory } from "./types.ts";

interface Template {
  category: IncidentCategory;
  title: string;
  description: string;
  // Plain-language gloss of what the jargon above actually means, shown
  // under the description so a player with no security background still
  // has something to reason about — it explains the scenario, not what to
  // vote, so the judgment call (and the social deduction it drives) is
  // still the player's own.
  hint: string;
}

const TEMPLATES: Template[] = [
  {
    category: "login",
    title: "Suspicious login spike for {{user}}",
    description: "{{count}} failed login attempts for {{user}} from {{ip}} in the last 5 minutes, mostly from {{country}}.",
    hint: "Plain English: someone tried {{user}}'s password a lot of times very fast. Could be {{user}} forgetting their password, or someone else trying to guess it.",
  },
  {
    category: "login",
    title: "Impossible travel detected for {{user}}",
    description: "{{user}} authenticated from {{country}} nine minutes after a successful login from a different continent.",
    hint: "Plain English: {{user}}'s account logged in from two places too far apart to be the same person in 9 minutes. Either their password leaked, or there's a tracking/VPN glitch.",
  },
  {
    category: "exfiltration",
    title: "Unusual outbound transfer from {{asset}}",
    description: "{{asset}} sent {{size}}GB to an external host ({{ip}}) outside business hours.",
    hint: "Plain English: a server sent a chunk of data outside the company, at a weird hour. Could be a scheduled backup job, or data being stolen.",
  },
  {
    category: "exfiltration",
    title: "Large archive staged on {{asset}}",
    description: "A {{size}}GB compressed archive was created on {{asset}} and accessed by {{user}} shortly before the connection to {{ip}} opened.",
    hint: "Plain English: someone zipped up a big pile of files right before data left the building. Could be routine packaging, or prep for stealing data.",
  },
  {
    category: "malware",
    title: "Unsigned binary executed on {{asset}}",
    description: "{{asset}} ran an unsigned binary that immediately opened a connection to {{ip}}.",
    hint: "Plain English: a program with no verified source ran on a server and immediately called out to the internet — a classic malware pattern, but could also be an internal tool nobody signed properly.",
  },
  {
    category: "malware",
    title: "Endpoint protection disabled on {{asset}}",
    description: "Endpoint protection was disabled on {{asset}} by {{user}} minutes before {{count}} files were modified.",
    hint: "Plain English: the antivirus/security software got turned off right before a bunch of files changed. Could be IT doing maintenance, or someone covering their tracks.",
  },
  {
    category: "network",
    title: "Port scan originating from {{ip}}",
    description: "{{ip}} probed {{count}} ports across the internal network in under a minute, consistent with reconnaissance from {{country}}.",
    hint: "Plain English: something is systematically checking which doors (network ports) are open on the internal network — the kind of first step an attacker takes before trying to break in.",
  },
  {
    category: "network",
    title: "DNS tunneling indicators on {{asset}}",
    description: "{{asset}} issued an unusually high volume of DNS queries to a domain registered in {{country}}.",
    hint: "Plain English: a server is sending way more 'lookup this address' requests than normal to one outside domain — a technique sometimes used to sneak data out through a channel that's rarely monitored.",
  },
  {
    category: "insider",
    title: "Off-hours bulk download by {{user}}",
    description: "{{user}} downloaded {{count}} records from a restricted system at an unusual hour from {{ip}}.",
    hint: "Plain English: an employee grabbed a lot of records from a sensitive system late at night. Could be catching up on work, or taking data they shouldn't.",
  },
  {
    category: "insider",
    title: "Privilege escalation request from {{user}}",
    description: "{{user}} requested elevated access to {{asset}} shortly after a performance review, flagged by HR correlation.",
    hint: "Plain English: an employee asked for more access rights right after a performance review. Could be a legitimate role change, or someone disgruntled trying to get access before they leave.",
  },
];

const USERS = ["j.santos", "a.okafor", "m.lindqvist", "r.patel", "t.nakamura", "s.oconnor"];
const COUNTRIES = ["Belarus", "Moldova", "Vietnam", "Nigeria", "Romania", "Kazakhstan"];
const ASSETS = ["db-prod-03", "fileshare-02", "vpn-gateway-1", "build-runner-7", "hr-portal", "backup-nas-2"];

function pick<T>(xs: T[]): T {
  return xs[Math.floor(Math.random() * xs.length)]!;
}

function randomIp(): string {
  return `${1 + Math.floor(Math.random() * 223)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

interface PlaceholderValues {
  user: string;
  country: string;
  asset: string;
  ip: string;
  count: string;
  size: string;
}

function randomValues(): PlaceholderValues {
  return {
    user: pick(USERS),
    country: pick(COUNTRIES),
    asset: pick(ASSETS),
    ip: randomIp(),
    count: String(10 + Math.floor(Math.random() * 490)),
    size: (Math.random() * 20 + 0.5).toFixed(1),
  };
}

function fill(text: string, values: PlaceholderValues): string {
  return text
    .replace(/\{\{user\}\}/g, values.user)
    .replace(/\{\{country\}\}/g, values.country)
    .replace(/\{\{asset\}\}/g, values.asset)
    .replace(/\{\{ip\}\}/g, values.ip)
    .replace(/\{\{count\}\}/g, values.count)
    .replace(/\{\{size\}\}/g, values.size);
}

export function generateThreat(): { title: string; description: string; category: IncidentCategory; hint: string } {
  const template = pick(TEMPLATES);
  const values = randomValues();
  return {
    title: fill(template.title, values),
    description: fill(template.description, values),
    category: template.category,
    hint: fill(template.hint, values),
  };
}

export const INCIDENT_CATEGORIES: IncidentCategory[] = ["login", "exfiltration", "malware", "network", "insider"];
