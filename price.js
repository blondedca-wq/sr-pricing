'use strict';
// sr-pricing — Photo -> Quote AI II (Category B Day 3): the runner that wires the shared pricing
// engine to the quote tables.            node price.js [--tenant <uuid>] [--dry-run] [--force-proof]
//
// The welded rules, in order:
//   1. THE PRICE LIST IS THE ONLY SOURCE OF A NUMBER. The vision model's words are search text
//      against the contractor's own rate card. No match -> no number, and the owner is told.
//   2. THE ENGINE NEVER RUNS UNPROVED. Before pricing for a tenant, the engine is checked against
//      the database's own sr_price_line on that tenant's live price list — whenever the price list
//      changed, the engine version changed, or the last proof is a day old. One disagreement and
//      this run prices NOTHING for that tenant and logs a critical event.
//   3. THE DATABASE HAS THE LAST WORD. sr_save_priced_quote re-prices every line itself and refuses
//      the whole quote on a single cent of difference. What is stored is the database's arithmetic.
//   4. EVERYTHING GOES TO THE OWNER. Outside the rules -> approval queue, with the reasons in plain
//      English. Inside the rules -> approval queue anyway. There is no send in this machine at all.
//   5. THE NOTCH IS OBEYED TWICE: here (skip silently when Off) and inside the database function.
//
// PASS 1 prices new usable scope drafts. PASS 2 carries the owner's decisions onto the quotes.

const path = require('path');
const E = require('./pricing-engine.js');
const Q = require('./quote-rules.js');
const L = require('./lib.js');

const PROOF_MAX_AGE_MS = 24 * 3600e3;

function today() { return new Date().toISOString().slice(0, 10); }   // the DB session is UTC: this is CURRENT_DATE

async function ensureProved(db, tenant, book, on, force) {
  const last = await db.lastProof(tenant);
  const lp = last && last.payload ? last.payload : {};
  const fresh = last && last.guardrail_pass === true
    && lp.engine_version === E.ENGINE_VERSION
    && lp.book_stamp === book.stamp
    && (Date.now() - new Date(last.created_at).getTime()) < PROOF_MAX_AGE_MS;
  if (fresh && !force) return { proved: true, reused: true, at: last.created_at };
  const r = await L.runConformance(E, db, tenant, book, on, false);
  await db.logConformance(tenant, r.pass, r.fail, {
    engine: E.ENGINE_NAME, engine_version: E.ENGINE_VERSION, book_stamp: book.stamp, book_counts: book.counts,
    on, runner: 'price.js', first_bad: r.bad.slice(0, 3)
  });
  return { proved: r.fail === 0, reused: false, pass: r.pass, fail: r.fail, bad: r.bad };
}

async function runTenant(db, tenant, opts) {
  opts = opts || {};
  const out = { tenant, mode: null, priced: 0, not_priced: 0, held: 0, refused: 0, inside: 0, outside: 0, decisions: 0, errors: [] };
  const on = opts.on || today();

  out.mode = await db.mode(tenant);
  if (out.mode === 'paused' || out.mode === 'not_installed') return out;          // Off means off: not even a log line in the DB

  const ready = await db.quoteReady(tenant);
  if (!ready || ready.ready !== true) { out.skipped = (ready && ready.reason_code) || 'not_ready'; return out; }

  const drafts = await db.unpricedDrafts(tenant);
  const decided = await db.decidedQuoteApprovals(tenant);
  if (!drafts.length && !decided.length && !opts.forceProof) return out;       // nothing to do: stay silent

  const machineId = opts.machineId || await db.machineId();
  const [book, kv] = await Promise.all([db.book(tenant), db.configs(tenant, machineId)]);
  const cfg = Q.resolveConfig(kv.machine, kv.tenantLevel);

  // ---------- PASS 1: price ----------
  if (drafts.length || opts.forceProof) {
    const proof = await ensureProved(db, tenant, book, on, opts.forceProof);
    out.proof = proof.reused ? 'reused ' + proof.at : (proof.pass + '/' + (proof.pass + proof.fail));
    if (!proof.proved) {
      out.errors.push('ENGINE DRIFT — ' + proof.fail + ' case(s) disagree with the database; pricing stopped for this tenant');
      return out;
    }
  }
  if (drafts.length) {
    const groups = Q.groupDrafts(drafts);
    const jobs = await db.jobs(tenant, groups.map(g => g.job_id).filter(Boolean));
    for (const g of groups) {
      try {
        const job = g.job_id ? jobs[g.job_id] : null;
        const plan = Q.planGroup(book, tenant, g, job, cfg, on);
        const payload = {
          source: 'photo', scope_draft_ids: g.drafts.map(d => d.id),
          job_id: g.job_id, contact_id: g.contact_id || (job && job.contact_id) || null,
          engine: { name: E.ENGINE_NAME, version: E.ENGINE_VERSION },
          inputs: plan.inputs, engine_results: plan.engine_results, engine_totals: plan.engine_totals,
          rules: plan.rules, match: plan.match, what: plan.what,
          ai_model: g.drafts[0].ai_model || null, ai_confidence: plan.ai_confidence,
          scope_text: plan.scope_text, created_by: 'sr-pricing'
        };
        if (opts.dryRun) {
          console.log('[sr-pricing] DRY RUN', JSON.stringify({ drafts: payload.scope_draft_ids, inside: plan.rules.inside, reasons: plan.rules.reasons.map(r => r.code), totals: plan.engine_totals }));
          continue;
        }
        const r = await db.saveQuote(tenant, payload);
        if (r && r.ok && r.held) out.held++;
        else if (r && r.ok && r.priced) { out.priced++; if (r.inside_rules) out.inside++; else out.outside++; }
        else if (r && r.ok) { out.not_priced++; out.outside++; }
        else { out.refused++; out.errors.push((r && r.reason) || 'save_failed'); if (r && r.reason === 'engine_drift') break; }
      } catch (e) { out.errors.push(e.message); }
    }
  }

  // ---------- PASS 2: the owner's decisions ----------
  if (!opts.dryRun) {
    for (const a of decided) {
      try { const r = await db.applyDecision(a.id); if (r && r.applied) out.decisions++; }
      catch (e) { out.errors.push('decision ' + a.id + ': ' + e.message); }
    }
  }

  if (!opts.dryRun && (out.priced || out.not_priced || out.held || out.refused || out.decisions || out.errors.length)) {
    await db.log(tenant, 'quote_run_summary',
      'Photo quotes (' + out.mode + '): ' + out.priced + ' priced, ' + out.not_priced + ' could not be priced, ' + out.held + ' held in Watch, ' +
      out.refused + ' refused, ' + out.decisions + ' decisions applied' + (out.errors.length ? ' — ' + out.errors.length + ' problem(s)' : ''),
      out, out.errors.length ? 'warn' : 'info').catch(() => {});
  }
  return out;
}

async function main() {
  L.loadEnv(path.join(__dirname, '.env'));
  const argv = process.argv.slice(2);
  const opt = k => { const i = argv.indexOf(k); return i === -1 ? null : (argv[i + 1] || true); };
  const db = L.api(L.restTransport(process.env));
  const only = (opt('--tenant') && opt('--tenant') !== true ? String(opt('--tenant')) : (process.env.TENANT_IDS || '')).split(',').map(s => s.trim()).filter(Boolean);
  const machineId = await db.machineId();
  if (!machineId) { console.error('[sr-pricing] machines row photo_to_quote not found'); process.exit(1); }
  const tenants = await db.tenants(machineId, only.length ? only : null);
  if (!tenants.length) { console.log('[sr-pricing] photo_to_quote is not switched on for any tenant — nothing to do'); return; }
  let failed = false;
  for (const t of tenants) {
    try {
      const r = await runTenant(db, t.tenant_id, { machineId, dryRun: argv.includes('--dry-run'), forceProof: argv.includes('--force-proof') });
      console.log('[sr-pricing]', JSON.stringify(r));
      if (r.errors.length) failed = true;
    } catch (e) { failed = true; console.error('[sr-pricing] ' + t.tenant_id + ' fatal: ' + e.message); }
  }
  process.exit(failed ? 1 : 0);
}

module.exports = { runTenant, ensureProved };
if (require.main === module) main().catch(e => { console.error('[sr-pricing] fatal: ' + e.message); process.exit(1); });
