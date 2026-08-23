#!/usr/bin/env bash
# ModelPulseX — local dev (macOS/Linux)
# Usage: ./run.sh [--remote]
set -e
cd "$(dirname "$0")"
echo "[ModelPulseX] installing deps..."
npm install --legacy-peer-deps
echo "[ModelPulseX] D1 migrations (local)..."
npx wrangler d1 migrations apply DB --local
echo "[ModelPulseX] build frontend..."
npm run build
echo "[ModelPulseX] wrangler dev --local :8789"
if [[ "$1" == "--remote" ]]; then
  exec npx wrangler dev --remote --port 8789
else
  exec npx wrangler dev --local --port 8789
fi
