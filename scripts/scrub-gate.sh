#!/usr/bin/env bash
#
# Proprietary-hosted scrub gate for the public OSS repo.
#
# Fails if any reference to the *proprietary hosted product* slips into the
# public repository. Generic ClickHouse / Postgres / Docker (the OSS self-host
# scale tier) are ALLOWED — only hosted-SaaS-specific tokens are forbidden.
#
# Run locally: bash scripts/scrub-gate.sh
set -euo pipefail

# Forbidden tokens (extended regex, case-insensitive).
PATTERN='@uptimizr/(hosted-api|hosted-web|scale-store|tenancy|auth)|hosted/apps|hosted/packages|HOSTED_API|app\.uptimizr\.com|multi-tenant saas|phase-2-hosted'

matches=$(grep -rEnI -i \
  --exclude-dir=node_modules \
  --exclude-dir=.git \
  --exclude-dir=dist \
  --exclude-dir=build \
  --exclude-dir=.next \
  --exclude-dir=.turbo \
  --exclude-dir=.astro \
  --exclude=pnpm-lock.yaml \
  --exclude=scrub-gate.sh \
  "$PATTERN" . || true)

if [ -n "$matches" ]; then
  echo "ERROR: proprietary-hosted scrub gate FAILED — forbidden tokens found:"
  echo "$matches"
  exit 1
fi

echo "OK: scrub gate passed — no proprietary hosted-product tokens found."
