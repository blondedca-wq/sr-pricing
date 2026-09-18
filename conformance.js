'use strict';
// conformance.js — prove the pricing engine against the database, on the LIVE price list.
//   node conformance.js                 every tenant that has photo_to_quote switched on
//   node conformance.js --tenant <uuid> one tenant (works whether or not the machine is on)
//   node conformance.js --all           every tenant that has an active price list
//   node conformance.js --full          every service x every tier x every premium (slow, thorough)
//   node conformance.js --quiet         print only failures and the verdict
//
// For every case the engine prices it here and the database prices it there (sr_price_line), from
// the same rows, and the two results must be the SAME OBJECT — every cent, every flag, every word
// of every line description. Exit code 1 on any difference. The receipt is one pricing.conformance
// event per tenant, which is what the console's "engine last proved" reads.
//
// If this ever fails: THE DATABASE IS RIGHT. Fix pricing-engine.js. Never touch an expected value.

const path = require('path');
const E = require('./pricing-engine.js');
const L = require('./lib.js');

async function main() {
  L.loadEnv(path.join(__dirname, '.env'));
  const argv = process.argv.slice(2);
  const val = k => { const i = argv.indexOf(k); return i === -1 ? null : argv[i + 1]; };
  const db = L.api(L.restTransport(process.env));
  const on = val('--on') || new Date().toISOString().slice(0, 10);
  const full = argv.includes('--full'), quiet = argv.includes('--quiet');

  let tenants;
  if (val('--tenant')) tenants = [val('--tenant')];
  else if (argv.includes('--all')) tenants = Array.from(new Set((await db.transport.get('rate_cards?status=eq.active&select=tenant_id')).map(r => r.tenant_id)));
  else { const mid = await db.machineId(); tenants = (await db.tenants(mid, null)).map(t => t.tenant_id); }
  if (!tenants.length) { console.log('no tenants to check (use --all or --tenant <uuid>)'); return; }

  console.log(E.ENGINE_NAME + ' ' + E.ENGINE_VERSION + ' vs public.sr_price_line · pricing date ' + on + (full ? ' · FULL matrix' : ''));
  let totalPass = 0, totalFail = 0;
  for (const tenant of tenants) {
    const book = await db.book(tenant);
    const r = await L.runConformance(E, db, tenant, book, on, full);
    totalPass += r.pass; totalFail += r.fail;
    console.log((r.fail ? 'FAIL ' : 'PASS ') + tenant + '  ' + r.pass + '/' + r.total + ' identical  (' + (book.counts ? book.counts.items + ' services, ' + book.counts.tiers + ' zones, ' + book.counts.premiums + ' premiums' : 'no price list') + ')');
    r.bad.slice(0, quiet ? 3 : 10).forEach(b => {
      console.log('   ✗ ' + b.id + '  ' + JSON.stringify(b.args));
      console.log('       database: ' + JSON.stringify(b.database).slice(0, 600));
      console.log('       engine  : ' + JSON.stringify(b.engine).slice(0, 600));
    });
    if (!argv.includes('--no-log')) {
      await db.logConformance(tenant, r.pass, r.fail, { engine: E.ENGINE_NAME, engine_version: E.ENGINE_VERSION, book_stamp: book.stamp, book_counts: book.counts, on, runner: 'conformance.js', full, first_bad: r.bad.slice(0, 3) })
        .catch(e => console.error('   (could not write the receipt event: ' + e.message + ')'));
    }
  }
  console.log((totalFail ? 'DRIFT — ' + totalFail + ' case(s) disagree. The database is right; fix the engine.' : 'CONFORMANT — ' + totalPass + '/' + totalPass + ' identical across ' + tenants.length + ' tenant(s).'));
  process.exit(totalFail ? 1 : 0);
}

main().catch(e => { console.error('conformance fatal: ' + e.message); process.exit(2); });
