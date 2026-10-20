#!/usr/bin/env bash
# Deploy the public open-pixel Edge Function.
# Prerequisites: supabase login (or SUPABASE_ACCESS_TOKEN), and migration applied.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${ROOT}/.bin/supabase"
if [[ ! -x "$CLI" ]]; then
  CLI="$(command -v supabase || true)"
fi
if [[ -z "$CLI" ]]; then
  echo "Install the Supabase CLI, or place it at .bin/supabase" >&2
  exit 1
fi
PROJECT_REF="${SUPABASE_PROJECT_REF:-desemifklpeifqbzicnu}"
cd "$ROOT"
"$CLI" functions deploy open-pixel --project-ref "$PROJECT_REF" --no-verify-jwt
echo "Deployed. PUBLIC_OPEN_PIXEL_URL=https://${PROJECT_REF}.supabase.co/functions/v1/open-pixel"
