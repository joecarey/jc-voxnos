#!/usr/bin/env bash
# Fetch recent FreeClimb call logs and render a human-readable timeline.
# Usage:
#   ./scripts/logs.sh              # most recent call
#   ./scripts/logs.sh <callId>     # specific call
#   ./scripts/logs.sh --raw        # raw JSON (pipe to jq)
#   ./scripts/logs.sh --tail       # live Cloudflare Worker console logs (ctrl-c to stop)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Read ADMIN_API_KEY from .dev.vars
API_KEY=$(grep '^ADMIN_API_KEY=' "$ROOT_DIR/.dev.vars" | sed 's/^ADMIN_API_KEY=//')
BASE_URL="https://jc-voxnos.cloudflare-5cf.workers.dev"

if [[ "${1:-}" == "--tail" ]]; then
  echo "Starting live Worker console logs (ctrl-c to stop)..."
  cd "$ROOT_DIR" && npx wrangler tail --format pretty
  exit 0
fi

if [[ "${1:-}" == "--raw" ]]; then
  curl -s -H "Authorization: Bearer $API_KEY" "$BASE_URL/logs"
  exit 0
fi

CALL_ID="${1:-}"
curl -s -H "Authorization: Bearer $API_KEY" "$BASE_URL/logs" | python3 "$SCRIPT_DIR/parse_logs.py" $CALL_ID
