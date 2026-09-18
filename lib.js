'use strict';
// lib.js — the only file in sr-pricing that talks to anything. Two transports, one interface:
//   rest  : Supabase PostgREST with the service key (what the droplet uses)
//   psql  : a local Postgres via the psql binary (dev only: dev/e2e-local.js) — never the live project
// Everything above this file is pure.

const MACHINE_KEY = 'photo_to_quote';

function restTransport(env) {
  const URL_ = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const KEY = env.SUPABASE_SERVICE_KEY || '';
  if (!URL_ || !KEY) throw new Error('missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
  const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  async function get(p) {
    const res = await fetch(URL_ + '/rest/v1/' + p, { headers: H });
    if (!res.ok) throw new Error('GET ' + p.split('?')[0] + ' -> ' + res.status + ' ' + (await res.text()).slice(0, 200));
    return res.json();
  }
  async function rpc(fn, args) {
    const res = await fetch(URL_ + '/rest/v1/rpc/' + fn, { method: 'POST', headers: H, body: JSON.stringify(args || {}) });
    const t = await res.text();
    if (!res.ok) throw new Error('RPC ' + fn + ' -> ' + res.status + ' ' + t.slice(0, 300));
    try { return JSON.parse(t); } catch (e) { return t; }
  }
  return { kind: 'rest', get, rpc };
}

// ---------------------------------------------------------------- data access
function api(t) {
  const enc = encodeURIComponent;
  return {
    transport: t,
    async machineId() {
      const r = await t.get('machines?key=eq.' + MACHINE_KEY + '&select=id&limit=1');
      return r.length ? r[0].id : null;
    },
    // tenants where the machine is installed and switched on (Watch counts: it still has to look)
    async tenants(machineId, only) {
      const rows = await t.get('tenant_machines?machine_id=eq.' + machineId + '&enabled=is.true&mode=in.(approval_required,autonomous,observe)&select=tenant_id,mode');
      return rows.filter(r => !only || only.indexOf(r.tenant_id) !== -1);
    },
    mode(tenant) { return t.rpc('sr_mode', { p_tenant: tenant, p_machine_key: MACHINE_KEY }); },
    quoteReady(tenant) { return t.rpc('sr_tenant_quote_ready', { p_tenant: tenant }); },
    async book(tenant) {
      const cards = await t.get('rate_cards?tenant_id=eq.' + tenant + '&select=id,tenant_id,name,currency,tax_label,tax_rate_pct,prices_include_tax,min_charge_cents,effective_from,effective_to,status,updated_at');
      const ids = cards.map(c => c.id);
      if (!ids.length) return { rate_cards: [], items: [], tiers: [], premiums: [], stamp: null };
      const inl = 'in.(' + ids.join(',') + ')';
      const [items, tiers, premiums] = await Promise.all([
        t.get('rate_card_items?rate_card_id=' + inl + '&select=id,rate_card_id,code,name,aliases,unit,pricing_model,base_price_cents,low_price_cents,high_price_cents,min_price_cents,taxable,emergency_eligible,requires_site_visit,ai_quotable,sort,active,updated_at&limit=5000'),
        t.get('pricing_tiers?rate_card_id=' + inl + '&select=id,rate_card_id,tier_no,name,cities,travel_fee_cents,uplift_pct,active,updated_at&limit=200'),
        t.get('pricing_premiums?rate_card_id=' + inl + '&select=id,rate_card_id,code,name,stack_group,pct,flat_cents,requires_emergency_eligible,active,updated_at&limit=500')
      ]);
      // "has the price list changed since it was last proved?" — newest edit across all four tables
      let stamp = '';
      [cards, items, tiers, premiums].forEach(list => list.forEach(r => { if (r.updated_at && r.updated_at > stamp) stamp = r.updated_at; }));
      return { rate_cards: cards, items, tiers, premiums, stamp: stamp || null, counts: { cards: cards.length, items: items.length, tiers: tiers.length, premiums: premiums.length } };
    },
    async configs(tenant, machineId) {
      const rows = await t.get('machine_configs?tenant_id=eq.' + tenant + '&or=(machine_id.eq.' + machineId + ',machine_id.is.null)&select=machine_id,key,value');
      const machine = {}, tenantLevel = {};
      rows.forEach(r => { (r.machine_id ? machine : tenantLevel)[r.key] = r.value; });
      return { machine, tenantLevel };
    },
    unpricedDrafts(tenant) {
      return t.get('scope_drafts?tenant_id=eq.' + tenant + '&usable=is.true&priced_at=is.null&status=eq.draft&select=id,file_id,job_id,contact_id,item_type,ai_model,ai_confidence,scope,created_at&order=created_at.asc&limit=200');
    },
    async jobs(tenant, ids) {
      if (!ids.length) return {};
      const rows = await t.get('jobs?tenant_id=eq.' + tenant + '&id=in.(' + ids.join(',') + ')&select=id,contact_id,address,description');
      const out = {}; rows.forEach(r => { out[r.id] = r; }); return out;
    },
    priceLineDb(tenant, a) {
      return t.rpc('sr_price_line', { p_tenant: tenant, p_service: a.service, p_tier: a.tier, p_premiums: a.premiums || [], p_qty: a.qty === undefined ? 1 : a.qty, p_variance_pct: a.variance_pct === undefined ? 10 : a.variance_pct, p_on: a.on });
    },
    saveQuote(tenant, payload) { return t.rpc('sr_save_priced_quote', { p_tenant: tenant, p_payload: payload }); },
    applyDecision(approvalId) { return t.rpc('sr_quote_apply_decision', { p_approval: approvalId }); },
    logConformance(tenant, pass, fail, detail) { return t.rpc('sr_pricing_conformance_log', { p_tenant: tenant, p_pass: pass, p_fail: fail, p_detail: detail || {} }); },
    async lastProof(tenant) {
      const r = await t.get('events?tenant_id=eq.' + tenant + '&event_type=eq.pricing.conformance&select=created_at,guardrail_pass,payload&order=created_at.desc&limit=1');
      return r.length ? r[0] : null;
    },
    // approvals the owner has decided whose quote is still waiting
    async decidedQuoteApprovals(tenant) {
      const q = await t.get('quotes?tenant_id=eq.' + tenant + '&status=eq.pending_approval&approval_id=not.is.null&select=id,approval_id&limit=500');
      if (!q.length) return [];
      const a = await t.get('approvals?id=in.(' + q.map(x => x.approval_id).join(',') + ')&status=neq.pending&select=id,status');
      return a;
    },
    log(tenant, type, summary, payload, severity) {
      return t.rpc('sr_log', { p_tenant: tenant, p_machine_key: MACHINE_KEY, p_event_type: type, p_summary: summary, p_payload: payload || {}, p_subject_type: 'pricing_run', p_subject_id: null, p_severity: severity || 'info', p_autonomous: true });
    }
  };
}

// ---------------------------------------------------------------- the matrix
// A deterministic set of cases built from the tenant's OWN live price list. Same list both sides see.
function conformanceCases(E, book, tenant, on, full) {
  const card = E.activeRateCard(book, tenant, on);
  if (!card) return [{ id: 'no-card', args: { service: 'anything', tier: 1, premiums: [], qty: 1, variance_pct: 10, on } }];
  const items = book.items.filter(i => i.rate_card_id === card.id).sort((a, b) => (a.sort - b.sort) || (a.code < b.code ? -1 : 1));
  const tiers = book.tiers.filter(x => x.rate_card_id === card.id).map(x => x.tier_no).sort();
  const prem = book.premiums.filter(x => x.rate_card_id === card.id).map(x => x.code).sort();
  const cases = [];
  const add = (id, a) => cases.push({ id, args: Object.assign({ tier: 1, premiums: [], qty: 1, variance_pct: 10, on }, a) });
  items.forEach(i => add('code:' + i.code, { service: i.code }));                         // every service, by its code
  items.forEach(i => (i.aliases || []).slice(0, 1).forEach(a => add('alias:' + i.code, { service: a })));   // and by what a customer calls it
  const probe = items.filter(i => i.active).slice(0, full ? items.length : 6);
  probe.forEach(i => {
    tiers.forEach(tn => add('tier' + tn + ':' + i.code, { service: i.code, tier: tn }));
    prem.forEach(pc => add('prem:' + pc + ':' + i.code, { service: i.code, tier: tiers[tiers.length - 1] || 1, premiums: [pc] }));
    if (prem.length > 1) add('stack:' + i.code, { service: i.code, tier: tiers[1] || 1, premiums: prem.slice() });   // everything at once: who wins the stack group
    add('qty2.5:' + i.code, { service: i.code, qty: 2.5, tier: tiers[1] || 1, premiums: prem.slice(0, 1) });
    add('qty0.333:' + i.code, { service: i.code, qty: 0.333 });                                                       // forces the minimum charge
    add('var7.5:' + i.code, { service: i.code, variance_pct: 7.5 });
  });
  add('fuzzy:replacement', { service: 'replacement' });                                   // the tie the Sep 18 fix closed
  add('fuzzy:repair', { service: 'repair' });
  add('name-contains', { service: (items[0] ? items[0].name.slice(0, Math.max(4, Math.floor(items[0].name.length / 2))) : 'xxxx') });
  add('no-match', { service: 'zzzz nothing like this' });
  add('too-short', { service: 'ab' });
  add('unknown-tier', { service: items[0] ? items[0].code : 'x', tier: 9 });
  add('unknown-premium', { service: items[0] ? items[0].code : 'x', premiums: ['not_a_real_premium'] });
  add('expired-date', { service: items[0] ? items[0].code : 'x', on: '2001-01-01' });
  return cases;
}

// canonical JSON (sorted keys) so two objects compare by value, not by key order
function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}

async function runConformance(E, db, tenant, book, on, full) {
  const cases = conformanceCases(E, book, tenant, on, full);
  const bad = [];
  let pass = 0;
  for (const c of cases) {
    const mine = E.priceLine(book, Object.assign({ tenant }, c.args));
    const theirs = await db.priceLineDb(tenant, c.args);
    if (canon(mine) === canon(theirs)) pass++;
    else bad.push({ id: c.id, args: c.args, engine: mine, database: theirs });
  }
  return { pass, fail: bad.length, total: cases.length, bad };
}

function loadEnv(file) {
  const fs = require('fs');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) return;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  });
}

module.exports = { MACHINE_KEY, restTransport, api, conformanceCases, runConformance, canon, loadEnv };
