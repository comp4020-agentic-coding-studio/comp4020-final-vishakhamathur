# syntax = docker/dockerfile:1

# Node runs the server's .ts files directly (built-in type stripping on this
# pinned version — see PROCESS.md), so there's no build/compile stage here.
FROM node:24.21.0-alpine

WORKDIR /app
RUN npm install -g pnpm@11.9.0

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY server/ server/
COPY public/ public/
COPY README.md ./

ENV PORT=8080 DATA_DIR=/data
EXPOSE 8080

CMD ["node", "server/index.ts"]
