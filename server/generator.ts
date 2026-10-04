import type { IncidentCategory } from "./types.ts";

interface Template {
  category: IncidentCategory;
  title: string;
  description: string;
}

const TEMPLATES: Template[] = [
  {
    category: "login",
    title: "Suspicious login spike for {{user}}",
    description: "{{count}} failed login attempts for {{user}} from {{ip}} in the last 5 minutes, mostly from {{country}}.",
  },
  {
    category: "login",
    title: "Impossible travel detected for {{user}}",
    description: "{{user}} authenticated from {{country}} nine minutes after a successful login from a different continent.",
  },
  {
    category: "exfiltration",
    title: "Unusual outbound transfer from {{asset}}",
    description: "{{asset}} sent {{size}}GB to an external host ({{ip}}) outside business hours.",
  },
  {
    category: "exfiltration",
    title: "Large archive staged on {{asset}}",
    description: "A {{size}}GB compressed archive was created on {{asset}} and accessed by {{user}} shortly before the connection to {{ip}} opened.",
  },
  {
    category: "malware",
    title: "Unsigned binary executed on {{asset}}",
    description: "{{asset}} ran an unsigned binary that immediately opened a connection to {{ip}}.",
  },
  {
    category: "malware",
    title: "Endpoint protection disabled on {{asset}}",
    description: "Endpoint protection was disabled on {{asset}} by {{user}} minutes before {{count}} files were modified.",
  },
  {
    category: "network",
    title: "Port scan originating from {{ip}}",
    description: "{{ip}} probed {{count}} ports across the internal network in under a minute, consistent with reconnaissance from {{country}}.",
  },
  {
    category: "network",
    title: "DNS tunneling indicators on {{asset}}",
    description: "{{asset}} issued an unusually high volume of DNS queries to a domain registered in {{country}}.",
  },
  {
    category: "insider",
    title: "Off-hours bulk download by {{user}}",
    description: "{{user}} downloaded {{count}} records from a restricted system at an unusual hour from {{ip}}.",
  },
  {
    category: "insider",
    title: "Privilege escalation request from {{user}}",
    description: "{{user}} requested elevated access to {{asset}} shortly after a performance review, flagged by HR correlation.",
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

function fill(text: string): string {
  return text
    .replace(/\{\{user\}\}/g, pick(USERS))
    .replace(/\{\{country\}\}/g, pick(COUNTRIES))
    .replace(/\{\{asset\}\}/g, pick(ASSETS))
    .replace(/\{\{ip\}\}/g, randomIp())
    .replace(/\{\{count\}\}/g, String(10 + Math.floor(Math.random() * 490)))
    .replace(/\{\{size\}\}/g, (Math.random() * 20 + 0.5).toFixed(1));
}

export function generateThreat(): { title: string; description: string; category: IncidentCategory } {
  const template = pick(TEMPLATES);
  return { title: fill(template.title), description: fill(template.description), category: template.category };
}

export const INCIDENT_CATEGORIES: IncidentCategory[] = ["login", "exfiltration", "malware", "network", "insider"];
