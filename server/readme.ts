import { readFileSync } from "node:fs";
import { marked } from "marked";

export function renderReadmePage(): string {
  const markdown = readFileSync("README.md", "utf8");
  const body = marked.parse(markdown, { async: false });
  return `<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>About — Cyber Threat Consensus Board</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <main class="readme">
      ${body}
    </main>
  </body>
</html>`;
}
