/* quote-rules.js — from a scope draft to a priced line, and whether it is "inside the rules".
 * Pure and deterministic like the engine: no AI, no network, no clock. The vision model's words
 * are only ever used as SEARCH TEXT against the contractor's own price list — never as a price.
 *
 * Day 3 contract (roadmap B·3):   outside the rules -> approval queue
 *                                 inside the rules  -> STILL approval, by default
 * There is no third branch. "AI estimates never auto-become final quotes" is a platform guardrail,
 * so owner_approval_required=false does not open a path to the customer here — it is recorded and
 * ignored, and the database would refuse a sent quote with no approved_at anyway.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pricing-engine.js'));
  else root.SRQuoteRules = factory(root.SRPricing);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  var DEFAULTS = {                     // registry defaults (onboarding.html MACHINES.photo_to_quote) + tenant-level fallbacks
    owner_approval_required: true,
    quote_as_range: true,
    max_variance_pct: 10,              // Ontario CPA s.10 — the table refuses more
    max_autonomous_quote_cents: 75000,
    ai_confidence_floor: 0.7
  };

  function money(cents) {
    var neg = cents < 0, a = Math.abs(cents), s = Math.floor(a / 100).toString(), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (neg ? '-' : '') + '$' + s + out + '.' + ('0' + (a % 100)).slice(-2);
  }
  function humanize(t) { return String(t).replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').replace(/^ +| +$/g, ''); }
  function truthy(v, dflt) { if (v === undefined || v === null) return dflt; if (typeof v === 'string') return v === 'true'; return !!v; }
  function numberOr(v, dflt) { var n = Number(v); return (v === undefined || v === null || v === '' || !isFinite(n)) ? dflt : n; }

  // machine config beats tenant-level config beats the registry default
  function resolveConfig(machineKv, tenantKv) {
    machineKv = machineKv || {}; tenantKv = tenantKv || {};
    var cfg = {
      owner_approval_required: truthy(machineKv.owner_approval_required, DEFAULTS.owner_approval_required),
      quote_as_range: truthy(machineKv.quote_as_range, DEFAULTS.quote_as_range),
      max_variance_pct: Math.min(numberOr(machineKv.max_variance_pct, DEFAULTS.max_variance_pct), 10),
      max_autonomous_quote_cents: numberOr(machineKv.max_autonomous_quote_cents, numberOr(tenantKv.max_autonomous_value_cents, DEFAULTS.max_autonomous_quote_cents)),
      ai_confidence_floor: numberOr(machineKv.min_scope_confidence, numberOr(tenantKv.ai_confidence_floor, DEFAULTS.ai_confidence_floor))
    };
    if (cfg.max_variance_pct < 0) cfg.max_variance_pct = 0;
    return cfg;
  }

  // The search texts a scope offers, in the order they are trusted.
  function candidatesFor(scope) {
    var out = [], seen = {};
    function add(source, text) {
      if (text === null || text === undefined) return;
      var t = String(text).replace(/^ +| +$/g, '');
      if (!t) return;
      [t, humanize(t)].forEach(function (v, i) {
        var key = v.toLowerCase();
        if (seen[key]) return; seen[key] = true;
        out.push({ source: source, text: v, variant: i === 0 ? 'as_given' : 'humanized' });
      });
    }
    var hints = scope && scope.quote_hints && Array.isArray(scope.quote_hints.likely_line_items) ? scope.quote_hints.likely_line_items : [];
    hints.forEach(function (h) { add('likely_line_item', h); });
    add('category_hint', scope && scope.category_hint);
    add('item_type', scope && scope.item_type);
    return out;
  }

  // Try every candidate against the price list. First hit wins; every hit is kept so an
  // ambiguous photo (two different services) is visible to the owner instead of hidden.
  function matchScope(book, tenant, scope, on) {
    var tried = [], chosen = null, distinct = [], names = [];
    candidatesFor(scope).forEach(function (c) {
      var f = E.findRateItem(book, tenant, c.text, on);
      var row = { source: c.source, text: c.text, variant: c.variant, item_code: f ? f.item.code : null, match_kind: f ? f.match_kind : null };
      tried.push(row);
      if (!f) return;
      if (distinct.indexOf(f.item.code) === -1) { distinct.push(f.item.code); names.push(f.item.name); }
      if (!chosen) chosen = { item: f.item, match_kind: f.match_kind, text: c.text, source: c.source, variant: c.variant };
    });
    return { chosen: chosen, tried: tried, distinct_items: distinct, distinct_names: names };
  }

  // Quantity only ever comes from a count the photo shows, and only for per-each / per-foot services.
  function qtyFor(scope, item) {
    if (!scope || !item) return 1;
    if (item.unit === 'each') {
      var q = Number(scope.quantity);
      if (isFinite(q) && q >= 1 && q <= 50 && Math.floor(q) === q) return q;
    }
    if (item.unit === 'ft' && scope.dimensions && isFinite(Number(scope.dimensions.length_ft)) && Number(scope.dimensions.length_ft) > 0) {
      return Math.round(Number(scope.dimensions.length_ft) * 100) / 100;
    }
    return 1;
  }

  // Which travel zone? Only a job address can say. No address -> home zone, and the owner is told.
  function pickTier(book, tenant, job, on) {
    var card = E.activeRateCard(book, tenant, on);
    var addr = job && job.address ? String(job.address).toLowerCase() : '';
    if (!card || !addr) return { tier_no: 1, assumed: true, why: 'no_address' };
    var tiers = (book.tiers || []).filter(function (t) { return t.rate_card_id === card.id && t.active; })
      .sort(function (a, b) { return a.tier_no - b.tier_no; });
    for (var i = 0; i < tiers.length; i++) {
      var cities = tiers[i].cities || [];
      for (var j = 0; j < cities.length; j++) {
        var c = String(cities[j]).toLowerCase();
        if (c && addr.indexOf(c) !== -1) return { tier_no: tiers[i].tier_no, assumed: false, city: cities[j] };
      }
    }
    return { tier_no: 1, assumed: true, why: 'address_not_in_any_zone' };
  }

  // ctx: { scope, confidence, match, result (engine priceLine output or null), tier, cfg }
  function evaluate(ctx) {
    var reasons = [], notes = [], cfg = ctx.cfg || DEFAULTS, m = ctx.match || {}, r = ctx.result, s = ctx.scope || {};
    function reason(code, plain) { reasons.push({ code: code, plain: plain }); }
    var label = s.item_type || 'this job';

    if (!m.chosen) {
      reason('no_rate_card_match', 'nothing on your price list matches "' + label + '" — add the service or quote it by hand');
      return { priceable: false, inside: false, reasons: reasons, notes: notes };
    }
    var item = m.chosen.item, nice = item.name;
    if (!item.ai_quotable) {
      reason('not_ai_quotable', 'you marked "' + nice + '" as never quoted from a photo — it needs a site visit');
      return { priceable: false, inside: false, reasons: reasons, notes: notes };
    }
    if (!r || !r.ok) {
      reason((r && r.reason) || 'not_priced', 'could not price "' + nice + '"' + (r && r.reason ? ' (' + r.reason + ')' : ''));
      return { priceable: false, inside: false, reasons: reasons, notes: notes };
    }

    if (m.chosen.match_kind === 'name_contains' || m.chosen.match_kind === 'alias_fuzzy')
      reason('fuzzy_match', 'closest line on your price list is "' + nice + '" — confirm it is the right service');
    if ((m.distinct_items || []).length > 1)
      reason('ambiguous_match', 'the photo could be more than one service (' + (m.distinct_names || m.distinct_items).join(' / ') + ') — priced as "' + nice + '"');
    if (r.flags.indexOf('requires_site_visit') !== -1)
      reason('requires_site_visit', 'you marked "' + nice + '" as site-visit work — treat this number as a ballpark until someone has looked');
    if (r.total_cents > cfg.max_autonomous_quote_cents)
      reason('over_limit', money(r.total_cents) + ' is over your ' + money(cfg.max_autonomous_quote_cents) + ' self-approve limit');
    var conf = Number(ctx.confidence);
    if (!isFinite(conf) || conf < cfg.ai_confidence_floor)
      reason('low_confidence', 'the photo read is only ' + Math.round((isFinite(conf) ? conf : 0) * 100) + '% sure (your floor is ' + Math.round(cfg.ai_confidence_floor * 100) + '%)');
    if (ctx.tier && ctx.tier.assumed)
      reason('tier_assumed', ctx.tier.why === 'no_address' ? 'no job address yet — priced at your home-zone rates with no travel'
                                                           : 'the address is not in any of your travel zones — priced at home-zone rates');
    if (s.quote_hints && s.quote_hints.emergency === true)
      reason('emergency_hint', 'this looks urgent — no emergency rate was added, that is your call');
    ['unknown_tier', 'unknown_premium', 'premium_not_eligible'].forEach(function (f) {
      if (r.flags.indexOf(f) !== -1) reason(f, 'pricing flag: ' + f.replace(/_/g, ' '));
    });

    if (r.resolved.pricing_model === 'range' && r.lines[0].low_price_cents !== null && r.lines[0].high_price_cents !== null)
      notes.push({ code: 'range_priced', plain: 'your price list has this as a range: ' + money(r.lines[0].low_price_cents) + '–' + money(r.lines[0].high_price_cents) + ' (priced at your base ' + money(r.lines[0].unit_cents) + ')' });
    if (r.min_charge_applied) notes.push({ code: 'min_charge_applied', plain: 'your minimum charge was applied' });
    if (Array.isArray(s.hazards) && s.hazards.length) notes.push({ code: 'hazards', plain: 'hazards seen: ' + s.hazards.join(', ') });
    if (Array.isArray(s.missing_info) && s.missing_info.length) notes.push({ code: 'missing_info', plain: 'still unknown: ' + s.missing_info.join('; ') });
    if (!cfg.owner_approval_required) notes.push({ code: 'approval_setting_ignored', plain: 'owner approval is switched off in settings — ignored: a person approves every AI quote, always' });

    return { priceable: true, inside: reasons.length === 0, reasons: reasons, notes: notes };
  }

  // Group drafts into quotes: one quote per job; a draft with no job stands alone.
  function groupDrafts(drafts) {
    var groups = {}, order = [];
    drafts.forEach(function (d) {
      var k = d.job_id ? 'job:' + d.job_id : 'draft:' + d.id;
      if (!groups[k]) { groups[k] = { key: k, job_id: d.job_id || null, contact_id: d.contact_id || null, drafts: [] }; order.push(k); }
      groups[k].drafts.push(d);
      if (!groups[k].contact_id && d.contact_id) groups[k].contact_id = d.contact_id;
    });
    return order.map(function (k) { return groups[k]; });
  }

  // Everything the runner needs for one group, computed without touching the network.
  function planGroup(book, tenant, group, job, cfg, on) {
    var tier = pickTier(book, tenant, job, on);
    var byItem = {}, itemOrder = [], unmatched = [], matchLog = [];
    group.drafts.forEach(function (d) {
      var m = matchScope(book, tenant, d.scope || {}, on);
      matchLog.push({ scope_draft_id: d.id, tried: m.tried, chosen: m.chosen ? { item_code: m.chosen.item.code, match_kind: m.chosen.match_kind, text: m.chosen.text, source: m.chosen.source } : null, distinct_items: m.distinct_items });
      if (!m.chosen) { unmatched.push({ draft: d, match: m }); return; }
      var code = m.chosen.item.code;
      if (!byItem[code]) { byItem[code] = { code: code, match: m, drafts: [], qty: 1, confidence: 0, scope: d.scope }; itemOrder.push(code); }
      var b = byItem[code];
      b.drafts.push(d);
      b.qty = Math.max(b.qty, qtyFor(d.scope, m.chosen.item));           // three photos of one heater is still one heater
      var c = Number(d.ai_confidence !== undefined && d.ai_confidence !== null ? d.ai_confidence : (d.scope || {}).confidence);
      if (isFinite(c) && c > b.confidence) { b.confidence = c; b.scope = d.scope; b.match = m; }
      if ((m.distinct_items || []).length > (b.match.distinct_items || []).length) { b.match.distinct_items = m.distinct_items; b.match.distinct_names = m.distinct_names; }
    });

    var inputs = [], results = [], evals = [], reasons = [], notes = [], blockers = [];
    itemOrder.forEach(function (code) {
      var b = byItem[code];
      var input = { service: b.match.chosen.text, tier: tier.tier_no, premiums: [], qty: b.qty, variance_pct: cfg.max_variance_pct, on: on };
      var res = b.match.chosen.item.ai_quotable ? E.priceLine(book, Object.assign({ tenant: tenant }, input)) : null;
      var ev = evaluate({ scope: b.scope, confidence: b.confidence, match: b.match, result: res, tier: tier, cfg: cfg });
      evals.push(ev);
      if (ev.priceable) { inputs.push(input); results.push(res); reasons = reasons.concat(ev.reasons); notes = notes.concat(ev.notes); }
      else blockers = blockers.concat(ev.reasons);
    });
    unmatched.forEach(function (u) {
      var ev = evaluate({ scope: u.draft.scope, confidence: u.draft.ai_confidence, match: u.match, result: null, tier: tier, cfg: cfg });
      blockers = blockers.concat(ev.reasons);
    });
    // de-duplicate reasons/notes by code+plain
    function uniq(list) { var seen = {}; return list.filter(function (x) { var k = x.code + '|' + x.plain; if (seen[k]) return false; seen[k] = true; return true; }); }
    var allReasons = uniq(reasons.concat(blockers));
    var lines = [];
    results.forEach(function (r) { lines = lines.concat(E.quoteLinesFor(r)); });
    var card = E.activeRateCard(book, tenant, on);   // sr_quote_recalc reads the rate and the tax-inclusive flag off the card
    var totals = results.length ? E.recalcQuote(lines, { tax_rate_pct: card.tax_rate_pct, prices_include_tax: !!card.prices_include_tax }) : null;
    var confs = itemOrder.map(function (c) { return byItem[c].confidence; });
    var first = itemOrder.length ? byItem[itemOrder[0]] : null;
    return {
      inputs: inputs, engine_results: results, engine_totals: totals,
      rules: { inside: results.length > 0 && allReasons.length === 0, reasons: allReasons, notes: uniq(notes) },
      match: matchLog, tier: tier,
      ai_confidence: confs.length ? Math.min.apply(null, confs) : Number(group.drafts[0].ai_confidence) || 0,
      what: first && results.length ? null : ((group.drafts[0].scope || {}).item_type || group.drafts[0].item_type || 'this job'),
      scope_text: group.drafts.map(function (d) { var s = d.scope || {}; return [s.item_type, s.condition, s.access].filter(Boolean).join(' — '); }).join('\n')
    };
  }

  return { DEFAULTS: DEFAULTS, resolveConfig: resolveConfig, candidatesFor: candidatesFor, matchScope: matchScope, qtyFor: qtyFor,
           pickTier: pickTier, evaluate: evaluate, groupDrafts: groupDrafts, planGroup: planGroup, humanize: humanize, money: money };
});
