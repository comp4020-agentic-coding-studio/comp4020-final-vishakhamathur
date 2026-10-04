import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";

const COOKIE_NAME = "analyst_id";

const ADJECTIVES = [
  "Cobalt",
  "Crimson",
  "Silent",
  "Rogue",
  "Night",
  "Quiet",
  "Iron",
  "Ghost",
  "Shadow",
  "Amber",
];

const NOUNS = ["Falcon", "Cipher", "Hawk", "Wolf", "Raven", "Fox", "Viper", "Owl", "Lynx", "Kite"];

export function generateCodename(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const n = Math.floor(Math.random() * 90) + 10;
  return `Agent ${adjective} ${noun}-${n}`;
}

export class IdentitySigner {
  private secret: Buffer;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    const secretPath = `${dataDir}/.secret`;
    if (existsSync(secretPath)) {
      this.secret = readFileSync(secretPath);
    } else {
      this.secret = randomBytes(32);
      writeFileSync(secretPath, this.secret);
    }
  }

  sign(id: string): string {
    const hmac = createHmac("sha256", this.secret).update(id).digest("hex");
    return `${id}.${hmac}`;
  }

  verify(token: string): string | undefined {
    const dot = token.lastIndexOf(".");
    if (dot === -1) return undefined;
    const id = token.slice(0, dot);
    const hmac = token.slice(dot + 1);
    const expected = createHmac("sha256", this.secret).update(id).digest("hex");
    if (hmac.length !== expected.length) return undefined;
    const match = Buffer.from(hmac).equals(Buffer.from(expected));
    return match ? id : undefined;
  }

  mint(): { id: string; cookie: string } {
    const id = randomUUID();
    return { id, cookie: this.sign(id) };
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export function readAnalystCookie(req: IncomingMessage): string | undefined {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[COOKIE_NAME];
}

export function analystCookieHeader(cookieValue: string): string {
  const maxAge = 365 * 24 * 60 * 60;
  return `${COOKIE_NAME}=${encodeURIComponent(cookieValue)}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}; Path=/`;
}
