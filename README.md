# sr-pricing

The SecondRing **shared pricing engine** and the runner that wires it to the quote tables
(Category B · Day 3 — *Photo → Quote AI II*). Photo Quote, Blueprint AI and Change Orders all price
through this one file, untouched.

**It contains no AI.** It is arithmetic on the contractor's own price list: integer cents, exact
percentages, Postgres rounding. The vision model's words are only ever *search text* against that
price list. No match → no number.

## The five welded rules

1. **The price list is the only source of a number.** Never a guess, never a "typical" price.
2. **The engine never runs unproved.** Before pricing for a tenant it is checked against the
   database's own `sr_price_line` on that tenant's live price list — whenever the price list changed,
   the engine version changed, or the last proof is a day old. One disagreement → nothing is priced
   and a `pricing.conformance` event goes out at severity `critical`.
3. **The database has the last word.** `sr_save_priced_quote()` re-prices every line itself and refuses
   the whole quote on a single cent or a single character of difference (`engine_drift`). What is
   stored is always the database's arithmetic.
4. **Everything goes to the owner.** Outside the rules → approval queue, with the reasons in plain
   trade English. Inside the rules → approval queue anyway. There is no send in this machine.
5. **The notch is obeyed twice** — in the runner, and again inside the database function.

> If this engine and the database ever disagree, **the database is right**. Fix `pricing-engine.js`.
> Never edit an expected value to make a test pass.

## Files

| File | What it is |
|---|---|
| `pricing-engine.js` | The engine. Pure, deterministic, no dependencies; Node and browser. Mirrors `sr_price_line`, `sr_find_rate_item`, `sr_active_rate_card`, `sr_quote_recalc`. |
| `quote-rules.js` | Scope draft → search texts → price-list line; zone from the job address; **inside / outside the rules** with plain-English reasons. Pure. |
| `price.js` | The runner (cron, every 15 min). PASS 1 prices new usable scope drafts. PASS 2 carries the owner's decisions onto the quotes. |
| `conformance.js` | Engine vs database on the live price list, whole-object equality. Exit 1 on drift. Nightly cron + on demand. |
| `engine-tests.js` | 162 offline assertions. No database, no network. |
| `lib.js` | The only file that talks to anything (Supabase REST with the service key). |
| `sql/b3-sql-determinism-fix-2.sql` | Three latent bugs the conformance matrix found in the live functions. No existing number changes. |
| `sql/b3-pricing-wiring.sql` | `sr_save_priced_quote`, `sr_quote_apply_decision`, `sr_pricing_conformance_log`, two console views, two columns on `scope_drafts`. Additive. |
| `dev/` *(not in this repo)* | Differential fuzz and end-to-end tests against a throwaway local Postgres. Kept out of the public repo on purpose: they ship with a stub of the production schema. They live in the SecondRing Vault (`Day 19/sr-pricing/dev/`). Sep 18 2026 results: 34,000/34,000 identical · 63/63 end to end. |
| `fixtures/` | The two **demo** price lists (Fennwick, Grand River — fictional, MODELLED) and the eight Day 2 stand-in scopes. |

## Inside / outside the rules

A priced draft is **inside the rules** only when every one of these holds — otherwise each failure is
listed on the approval card in words a contractor would use:

| Code | The card says |
|---|---|
| `no_rate_card_match` | nothing on your price list matches — *no number is produced* |
| `not_ai_quotable` | you marked this service as never quoted from a photo — *no number is produced* |
| `fuzzy_match` | closest line on your price list is "…" — confirm it is the right service |
| `ambiguous_match` | the photo could be more than one service |
| `requires_site_visit` | you marked this as site-visit work — treat the number as a ballpark |
| `over_limit` | over your self-approve limit (`max_autonomous_quote_cents`) |
| `low_confidence` | the photo read is below your confidence floor |
| `tier_assumed` | no job address — priced at home-zone rates with no travel |
| `emergency_hint` | looks urgent — **no** emergency rate was added, that is your call |

Settings read (all from `machine_configs`, never hard-coded): `owner_approval_required`,
`quote_as_range`, `max_variance_pct` (clamped to 10 — Ontario CPA s.10), `max_autonomous_quote_cents`
→ tenant-level `max_autonomous_value_cents` → 75000, and `min_scope_confidence` → tenant-level
`ai_confidence_floor` → 0.7.

`owner_approval_required = false` is read and **ignored, out loud**: a person approves every AI quote,
and the table refuses a sent quote with no `approved_at` regardless.

## Install on the droplet

```bash
cd /opt && git clone https://github.com/blondedca-wq/sr-pricing.git && cd sr-pricing && bash install.sh
```

`install.sh` copies `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` from a runner that already has them
(values never shown), runs the offline assertions, proves the engine against the live database, and
adds two cron lines. There is no `npm install` — there are no dependencies.

Update later: `cd /opt/sr-pricing && git pull && node engine-tests.js | tail -1 && node conformance.js --all`.

## Check it yourself

```bash
node engine-tests.js                  # PASSED — 162/162
node conformance.js --all             # CONFORMANT — n/n identical across k tenant(s)
node conformance.js --all --full      # every service × every zone × every premium
node price.js --dry-run               # what it WOULD draft, writes nothing
tail -f /var/log/sr-pricing.log
```

In the database: `select * from v_console_photo_quote;` · `select * from v_console_quotes;` ·
`select created_at, severity, summary from events where event_type like 'pricing.%' order by id desc limit 10;`

## What this machine does NOT do (yet)

It does not write the quote document, send anything to a customer, or create a job — that is
Category B Day 4. Until then every quote it makes stops at `pending_approval` → `approved`.
