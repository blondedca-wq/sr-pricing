#!/usr/bin/env bash
# One-shot install on the droplet. Run from /opt/sr-pricing:   bash install.sh
# No npm install (there are no dependencies). No secret is typed, printed or moved off this box.
set -euo pipefail
cd "$(dirname "$0")"

command -v node >/dev/null 2>&1 || { echo "node not found - install nodejs first"; exit 1; }
echo "node: $(node -v)"

if [ ! -f .env ]; then
  for f in /opt/sr-voice-bridge/.env /opt/sr-dm-bridge/.env /opt/sr-upsell/.env /opt/sr-reactivation/.env; do
    if [ -f "$f" ] && grep -q '^SUPABASE_SERVICE_KEY=' "$f" && grep -q '^SUPABASE_URL=' "$f"; then
      grep -E '^(SUPABASE_URL|SUPABASE_SERVICE_KEY)=' "$f" > .env
      chmod 600 .env
      echo ".env created from $f (2 lines copied, values not shown)"
      break
    fi
  done
fi
[ -f .env ] || { echo ">>> no runner .env found to copy from. Do: cp .env.example .env && nano .env"; exit 1; }

echo "--- 1/3 offline assertions (no network)"
node engine-tests.js | tail -1

echo "--- 2/3 conformance: engine vs the live database, every tenant with a price list"
node conformance.js --all --quiet

echo "--- 3/3 cron (idempotent). Times are Toronto if CRON_TZ=America/Toronto is at the top of the crontab."
PRICE='*/15 * * * * cd /opt/sr-pricing && /usr/bin/env node price.js >> /var/log/sr-pricing.log 2>&1'
PROOF='40 3 * * * cd /opt/sr-pricing && /usr/bin/env node conformance.js --all --quiet >> /var/log/sr-pricing.log 2>&1'
( crontab -l 2>/dev/null | grep -v '/opt/sr-pricing' ; echo "$PRICE" ; echo "$PROOF" ) | crontab -
crontab -l | grep sr-pricing
echo "Installed. Every 15 min: price new photo scopes + carry owner decisions. 03:40 nightly: re-prove the engine."
