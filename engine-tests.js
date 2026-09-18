'use strict';
// engine-tests.js — the OFFLINE assertion suite. No database, no network, no clock.
//   node engine-tests.js
// Every expected number below was either worked by hand from the price list or is a figure the
// live database produced (marked LIVE). If one of these ever fails after an engine edit, the edit
// is wrong — conformance.js is the second opinion, and the database outranks both.

const fs = require('fs');
const path = require('path');
const E = require('./pricing-engine.js');
const Q = require('./quote-rules.js');
const I = E._internals;
const BOOK = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'demo-book.json'), 'utf8'));
const SCOPES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'day2-standin-scopes.json'), 'utf8')).drafts;
const FEN = '00000000-0000-0000-0000-000000000000', GR = '11111111-1111-1111-1111-111111111111', ON = '2026-09-18';

let pass = 0, fail = 0, section = '';
function sec(s) { section = s; console.log('\n' + s); }
function ok(c, name, got) { if (c) { pass++; } else { fail++; console.log('  ✗ ' + name + (got !== undefined ? '   got: ' + JSON.stringify(got) : '')); } }
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name + ' (expected ' + JSON.stringify(b) + ')', a); }
const P = (tenant, service, o) => E.priceLine(BOOK, Object.assign({ tenant, service, on: ON }, o || {}));
const clone = x => JSON.parse(JSON.stringify(x));

sec('A · the canonical numbers (LIVE — what production returned on Sep 9 and again on Sep 18)');
let r = P(FEN, 'drain clearing', { tier: 2, premiums: ['after_hours'] });
eq([r.subtotal_cents, r.tax_cents, r.total_cents], [46500, 6045, 52545], 'Fennwick drain clearing · zone 2 · after hours = $465.00 + $60.45 = $525.45');
eq(r.lines.map(l => l.line_cents), [32000, 1600, 8400, 4500], 'four lines: base 320.00 · uplift 16.00 · premium 84.00 · travel 45.00');
eq([r.variance.envelope_low_cents, r.variance.envelope_high_cents], [41850, 51150], 'envelope ±10% = $418.50–$511.50');
eq(r.resolved.match, 'alias', 'resolved by alias ("drain clearing" is what a customer says)');
eq(r.resolved.item_code, 'drain_cleaning_auger', 'to drain_cleaning_auger');
eq(r.display, 'Drain cleaning (auger) · Cambridge · Guelph · Woolwich · after_hours → $465.00 + HST $60.45 = $525.45  (envelope $418.50–$511.50)', 'display line, character for character');
eq(r.lines[1].description, 'Tier 2 uplift 5%  (Cambridge · Guelph · Woolwich)', 'uplift label');
eq(r.lines[2].description, 'After-hours premium 25%', 'premium label');
r = P(GR, 'drain clearing', { tier: 2, premiums: ['after_hours'] });
eq([r.subtotal_cents, r.tax_cents, r.total_cents], [47553, 6182, 53735], 'Grand River, same words = $475.53 + $61.82 = $537.35 (cheaper base, dearer night)');
eq(r.lines.map(l => l.line_cents), [28500, 2280, 10773, 6000], '285.00 · 8% 22.80 · 35% 107.73 · travel 60.00');
r = P(FEN, 'sump pump', { tier: 2, premiums: ['weekend'] });
eq(r.lines[2].line_cents, 24544, 'Fennwick sump pump zone 2 weekend: 25% of $981.75 = $245.4375 → $245.44 (half rounds away from zero)');
r = P(GR, 'water_heater_replacement_40gal_gas');
eq([r.subtotal_cents, r.tax_cents, r.total_cents], [219000, 28470, 247470], 'Grand River 40-gal water heater = $2,190.00 + $284.70 = $2,474.70');

sec('B · every service on both price lists prices by its own code');
['rate_cards'].forEach(() => {
  BOOK.rate_cards.forEach(card => {
    const items = BOOK.items.filter(i => i.rate_card_id === card.id);
    let bad = [];
    items.forEach(i => {
      const x = P(card.tenant_id, i.code);
      const sub = Math.max(i.base_price_cents, card.min_charge_cents, i.min_price_cents || 0);
      const tax = Math.round(sub * 13 / 100 + 1e-9);
      if (!(x.ok && x.resolved.match === 'code' && x.resolved.item_code === i.code && x.subtotal_cents === sub && x.total_cents === x.subtotal_cents + x.tax_cents && Math.abs(x.tax_cents - tax) <= 0 && x.lines[0].rate_card_item_id === i.id)) bad.push(i.code);
    });
    ok(bad.length === 0, card.name + ': all ' + items.length + ' services price by code, subtotal = max(base, minimum), total = subtotal + HST', bad);
    bad = items.filter(i => { const x = P(card.tenant_id, i.name); return !(x.ok && x.resolved.item_code === i.code && x.resolved.match === 'name'); }).map(i => i.code);
    ok(bad.length === 0, card.name + ': all resolve by exact name', bad);
    bad = [];
    items.forEach(i => (i.aliases || []).forEach(a => { const x = P(card.tenant_id, a.toUpperCase() + '  '); const want = a === i.name.toLowerCase() ? 'name' : 'alias'; if (!(x.ok && x.resolved.item_code === i.code && x.resolved.match === want)) bad.push(a); }));
    ok(bad.length === 0, card.name + ': every alias resolves to its own service, case and trailing spaces ignored (an alias that IS the name reports "name")', bad);
  });
});

sec('C · rounding is Postgres numeric round(): half away from zero, never banker\'s, never float');
eq(String(I.divRound(5n, 2n)), '3', '2.5 → 3'); eq(String(I.divRound(-5n, 2n)), '-3', '-2.5 → -3');
eq(String(I.divRound(7n, 2n)), '4', '3.5 → 4'); eq(String(I.divRound(1n, 3n)), '0', '0.33 → 0');
eq(String(I.divRound(2n, 3n)), '1', '0.67 → 1'); eq(String(I.divRound(-1n, 3n)), '0', '-0.33 → 0');
eq(String(I.divRound(149n, 100n)), '1', '1.49 → 1'); eq(String(I.divRound(150n, 100n)), '2', '1.50 → 2');
eq(String(I.mulRound(98175n, I.dec('25'), 100n)), '24544', '981.75 × 25% = 245.4375 → 24544');
eq(String(I.mulRound(33333n, I.dec('7.5'), 100n)), '2500', '333.33 × 7.5% = 24.99975 → 2500');
eq(String(I.mulRound(10n, I.dec('0.5'), 1n)), '5', '10 × 0.5 exact');
eq(String(I.mulRound(1n, I.dec('0.5'), 1n)), '1', '0.5 → 1'); eq(String(I.mulRound(-1n, I.dec('0.5'), 1n)), '-1', '-0.5 → -1');
eq(String(I.mulRound(1005n, I.dec(0.1), 1n)), '101', '1005 × 0.1 = 100.5 → 101 (a float would say 100.49999…)');
eq(String(I.mulRound(99999999n, I.dec('14.975'), 100n)), '14975000', 'large × 3-decimal rate stays exact');
eq(I.decToString(I.dec(1e-7)), '0.0000001', 'exponent notation parsed exactly');
eq(I.decToString(I.dec('2.50')), '2.50', 'scale preserved'); eq(I.decToString(I.decTrim(I.dec('2.50'))), '2.5', 'trimmed');
eq(String(I.divFloor(-1n, 2n)), '-1', 'floor(-0.5) = -1'); eq(E.cpaCap(20340), 22374, 'CPA cap floor(203.40 × 1.10) = $223.74'); eq(E.cpaCap(100), 110, 'cap of $1.00 = $1.10');
let threw = false; try { I.dec('abc'); } catch (e) { threw = true; } ok(threw, 'garbage is refused, not coerced');
threw = false; try { E.priceLine({ rate_cards: BOOK.rate_cards, items: [Object.assign({}, BOOK.items[0], { base_price_cents: 10.5 })], tiers: [], premiums: [] }, { tenant: FEN, service: BOOK.items[0].code, on: ON }); } catch (e) { threw = true; } ok(threw, 'fractional cents on a price list are refused');

sec('D · labels and money formatting (what the customer reads)');
eq(I.fmtPct(I.dec('5.00')), '5', '5.00% → "5"'); eq(I.fmtPct(I.dec('7.50')), '7.5', '7.50% → "7.5" (the old template printed "8")');
eq(I.fmtPct(I.dec('12.35')), '12.35', '12.35'); eq(I.fmtPct(I.dec('-0.5')), '-0.5', 'negative'); eq(I.fmtPct(I.dec('0')), '0', 'zero'); eq(I.fmtPct(I.dec('100')), '100', '100');
eq(I.fmtMoney(46500n), '465.00', '465.00'); eq(I.fmtMoney(219000n), '2,190.00', 'thousands'); eq(I.fmtMoney(50n), '0.50', 'sub-dollar'); eq(I.fmtMoney(5n), '0.05', 'five cents');
eq(I.fmtMoney(-46550n), '-465.50', 'negative'); eq(I.fmtMoney(99999999n), '999,999.99', 'top of template'); eq(I.fmtMoney(100000000n), '###,###.##', 'overflow prints hashes, exactly as to_char does');
eq(I.capFirst('drain cleaning (auger)'), 'Drain cleaning (auger)', 'first letter only'); eq(I.capFirst('GFCI outlet install'), 'GFCI outlet install', 'already capital'); eq(I.capFirst('éclair'), 'Éclair', 'accented'); eq(I.capFirst('ßx'), 'ßx', 'never expands a character');

sec('E · finding the service: exact beats fuzzy, and ties cannot happen');
const F = (t, text) => { const f = E.findRateItem(BOOK, t, text, ON); return f ? f.item.code + ':' + f.match_kind : null; };
eq(F(GR, 'toilet_repair'), 'toilet_repair:code', 'code'); eq(F(GR, 'Toilet Repair'), 'toilet_repair:name', 'name, any case');
eq(F(GR, 'running toilet'), 'toilet_repair:alias', 'alias'); eq(F(GR, 'dishwash'), 'dishwasher_hookup:name_contains', 'part of a name');
eq(F(GR, 'my sump pump please'), 'sump_pump_replacement:alias_fuzzy', 'text that contains an alias');
eq(F(GR, 'replacement'), 'breaker_replacement:name_contains', 'THE TIE: "replacement" hits breaker_ and sump_pump_ at the same rank and sort 30 — code breaks it, always the same way');
eq(F(GR, 'repair'), 'burst_pipe_emergency:name_contains', 'lowest sort wins among equals');
eq(F(GR, 'furnace'), 'furnace_repair:name_contains', 'furnace → repair (sort 40) before replacement (100)');
eq(F(GR, 'xx'), null, 'under 3 characters never matches'); eq(F(GR, ''), null, 'empty'); eq(F(GR, null), null, 'null'); eq(F(GR, 'zzzz nothing'), null, 'no match is null, never a guess');
eq(F(GR, 'water_heater_replacement_40gal'), null, 'a slug with underscores is NOT the same as the words — _ is a one-character wildcard and still misses');
eq(F(GR, 'water heater replacement 40gal'), 'water_heater_replacement_40gal_gas:alias_fuzzy', '…humanised, it finds the alias');
eq(F(GR, 'electrical panel replacement'), 'panel_upgrade_200a:alias_fuzzy', 'a panel photo lands on the panel upgrade line');
eq(F(FEN, 'breaker'), null, 'Fennwick is a plumber: no electrical line, no number');
eq(F(GR, '  SUMP PUMP  '), 'sump_pump_replacement:alias', 'spaces trimmed, case folded');
eq(F(GR, '\tsump pump'), 'sump_pump_replacement:alias_fuzzy', 'btrim strips SPACES only — a tab stays, exactly like Postgres');
ok(I.like('water heater replacement (40-gal gas)', '%water_heater%'), 'LIKE: _ matches any one character');
ok(!I.like('abc', 'a\\%c') && I.like('a%c', 'a\\%c'), 'LIKE: backslash escapes %'); ok(I.like('', '%') && !I.like('', '_'), 'LIKE: % matches empty, _ does not');
ok(I.like('call-out', '%call-out%') && I.like('50% off', '%50\\% off%'), 'LIKE: punctuation is literal');
eq(I.cmpC('tier1', 'tier_1'), -1, 'byte order: "tier1" < "tier_1" (ICU says the opposite — which is why the SQL pins COLLATE "C")');
eq(I.cmpC('B', 'a'), -1, 'byte order: "B" < "a"'); eq(I.cmpC('a', 'a'), 0, 'equal');

sec('F · premiums: the biggest percentage in a group wins, flats add, the ineligible are refused out loud');
r = P(FEN, 'drain_cleaning_auger', { premiums: ['weekend', 'after_hours'] });
eq([r.resolved.premiums_applied, r.resolved.premiums_ignored], [['after_hours'], ['weekend']], 'two 25% time premiums: after_hours wins on code, weekend is reported as ignored');
r = P(FEN, 'drain_cleaning_auger', { premiums: ['after_hours', 'holiday'] });
eq(r.resolved.premiums_applied, ['holiday'], 'holiday 50% beats after-hours 25% — they do not stack'); eq(r.lines[1].line_cents, 16000, '50% of $320');
r = P(FEN, 'drain_cleaning_auger', { premiums: ['holiday', 'emergency'] });
eq(r.resolved.premiums_applied, ['holiday', 'emergency'], 'different groups both apply, time before urgency'); eq(r.subtotal_cents, 32000 + 16000 + 15000, '$320 + $160 + $150 flat');
r = P(FEN, 'faucet_replacement', { premiums: ['emergency'] });
eq([r.flags, r.resolved.premiums_applied, r.subtotal_cents], [['premium_not_eligible'], [], 36500], 'a faucet swap is not emergency-eligible: flagged, not charged');
r = P(FEN, 'drain_cleaning_auger', { premiums: ['rush'] });
eq([r.flags, r.resolved.premiums_ignored], [['unknown_premium'], ['rush']], 'a premium that is not on the price list is flagged and ignored');
r = P(FEN, 'drain_cleaning_auger', { premiums: ['after_hours', 'after_hours'] });
eq(r.lines.filter(l => l.kind === 'premium').length, 1, 'asking twice charges once');
r = P(FEN, 'drain_cleaning_auger', { premiums: null }); eq(r.input.premiums, [], 'null premiums = none');
const b2 = clone(BOOK); b2.premiums.push({ id: 'p-both', rate_card_id: '00000000-0000-0000-0000-00000000b1c0', code: 'both', name: 'Both', stack_group: 'other', pct: 12.5, flat_cents: 2500, requires_emergency_eligible: false, active: true });
r = E.priceLine(b2, { tenant: FEN, service: 'drain_cleaning_auger', premiums: ['both'], on: ON });
eq(r.lines.slice(1).map(l => [l.description, l.line_cents]), [['Both 12.5%', 4000], ['Both', 2500]], 'a premium with a % and a flat makes two lines, and 12.5 is labelled 12.5');
b2.premiums[b2.premiums.length - 1].active = false;
r = E.priceLine(b2, { tenant: FEN, service: 'drain_cleaning_auger', premiums: ['both'], on: ON });
eq([r.flags, r.resolved.premiums_ignored], [[], ['both']], 'a switched-off premium is ignored but is not "unknown"');

sec('G · zones, quantities, minimums, tax');
r = P(GR, 'toilet_repair', { tier: 3 }); eq([r.lines.map(l => l.line_cents), r.subtotal_cents], [[22500, 2700, 9500], 34700], 'zone 3: +12% and $95 travel');
r = P(GR, 'toilet_repair', { tier: 9 }); eq([r.flags, r.resolved.tier, r.subtotal_cents], [['unknown_tier'], null, 22500], 'a zone that does not exist: flagged, no uplift, no travel — never a guess');
ok(/ · no tier · /.test(r.display), 'display says "no tier"');
r = P(GR, 'toilet_repair', { tier: null }); eq([r.input.tier, r.resolved.tier], [null, 'Kitchener-Waterloo-Cambridge'], 'no zone given = home zone');
r = P(GR, 'pot_light_install', { qty: 6 }); eq([r.lines[0].line_cents, r.lines[0].qty], [195000, 6], 'six pot lights = 6 × $325');
r = P(GR, 'toilet_repair', { qty: 2.5 }); eq(r.lines[0].line_cents, 56250, '2.5 × $225 = $562.50');
r = P(GR, 'toilet_repair', { qty: 0.333 }); eq([r.lines[0].line_cents, r.subtotal_cents, r.min_charge_applied, r.flags], [7493, 18000, true, ['min_charge_applied']], '0.333 × $225 = $74.93 → the $180 minimum applies');
r = P(GR, 'diagnostic_service_call'); eq([r.lines[0].line_cents, r.subtotal_cents, r.tax_cents, r.total_cents], [12900, 18000, 2340, 20340], '$129 call-out → $180 minimum → HST on the $180');
eq(E.quoteLinesFor(r).map(l => [l.description, l.line_cents]), [['Diagnostic / service call', 12900], ['Minimum charge adjustment', 5100]], 'the quote gets an adjustment line so its lines add up to the price');
r = P(GR, 'toilet_repair', { qty: null }); eq(r.input.qty, 1, 'null quantity = 1');
r = P(GR, 'toilet_repair', { variance_pct: 7.5 }); eq([r.variance.envelope_low_cents, r.variance.envelope_high_cents], [20813, 24188], 'envelope ±7.5%: 208.125 → 208.13, 241.875 → 241.88');
const b3 = clone(BOOK); b3.rate_cards[1].prices_include_tax = true;
r = E.priceLine(b3, { tenant: GR, service: 'toilet_repair', on: ON }); eq([r.tax_cents, r.total_cents], [0, 22500], 'tax-inclusive price list: no tax added');
const b4 = clone(BOOK); b4.items.find(i => i.code === 'toilet_repair' && i.rate_card_id === b4.rate_cards[1].id).taxable = false;
r = E.priceLine(b4, { tenant: GR, service: 'toilet_repair', on: ON }); eq([r.tax_cents, r.lines[0].taxable], [0, false], 'a non-taxable service carries no tax');
const b5 = clone(BOOK); b5.tiers.find(t => t.tier_no === 2 && t.rate_card_id === b5.rate_cards[1].id).uplift_pct = -7.5;
r = E.priceLine(b5, { tenant: GR, service: 'toilet_repair', tier: 2, on: ON }); eq([r.lines[1].line_cents, r.lines[1].description.slice(0, 20)], [-1688, 'Tier 2 uplift -7.5% '], 'a negative uplift is a discount line: -7.5% of $225.00 = -16.875 → -$16.88 (half rounds AWAY from zero, also below zero)');

sec('H · which price list: dates and status');
eq(P(GR, 'toilet_repair', { on: '2025-12-31' }).reason, 'no_active_rate_card', 'before the card starts: no price list, no price');
eq(P('99999999-9999-9999-9999-999999999999', 'toilet_repair').reason, 'no_active_rate_card', 'a tenant with no price list');
const b6 = clone(BOOK); b6.rate_cards[1].status = 'draft'; eq(E.priceLine(b6, { tenant: GR, service: 'toilet_repair', on: ON }).reason, 'no_active_rate_card', 'a draft price list is never priced from');
const b7 = clone(BOOK); b7.rate_cards[1].effective_to = '2026-09-17'; eq(E.priceLine(b7, { tenant: GR, service: 'toilet_repair', on: ON }).reason, 'no_active_rate_card', 'an ended price list is never priced from');
const b8 = clone(BOOK); b8.rate_cards[1].effective_to = ON; ok(E.priceLine(b8, { tenant: GR, service: 'toilet_repair', on: ON }).ok, 'the end date itself still counts');
eq(P(GR, 'nothing like this').flags, ['no_rate_card_match'], 'no match carries its flag');
const b9 = clone(BOOK); b9.items.find(i => i.code === 'toilet_repair' && i.rate_card_id === b9.rate_cards[1].id).active = false;
eq(E.priceLine(b9, { tenant: GR, service: 'toilet_repair', on: ON }).reason, 'no_rate_card_match', 'a switched-off service cannot be priced');
eq(P(GR, 'bathroom_rough_in').flags, ['requires_site_visit', 'not_ai_quotable'], 'site-visit and never-from-a-photo flags come through');

sec('I · the quote totals mirror the database trigger');
const two = P(GR, 'water_heater_replacement_40gal_gas', { tier: 2 }).lines.concat(P(GR, 'shutoff_valve_replacement', { tier: 2 }).lines);
eq(E.recalcQuote(two, { tax_rate_pct: 13 }), { subtotal_cents: 283620, discount_cents: 0, tax_cents: 36871, total_cents: 320491 }, 'two services, tax charged once on the sum: $3,204.91');
eq(E.recalcQuote([{ kind: 'service', line_cents: 10000, taxable: true }, { kind: 'discount', line_cents: -1000, taxable: true }], { tax_rate_pct: 13 }), { subtotal_cents: 10000, discount_cents: 1000, tax_cents: 1170, total_cents: 10170 }, 'a discount line reduces the taxable base');
eq(E.recalcQuote([{ kind: 'service', line_cents: 10000, taxable: false }], { tax_rate_pct: 13 }).tax_cents, 0, 'non-taxable lines are not taxed');
eq(E.recalcQuote([{ kind: 'service', line_cents: 10000, taxable: true }], { tax_rate_pct: 13, prices_include_tax: true }).tax_cents, 0, 'tax-inclusive');
eq(E.recalcQuote([{ kind: 'service', line_cents: 10000, taxable: true }], { tax_rate_pct: 13, deposit_pct: 25 }).deposit_cents, 2825, '25% deposit of $113.00');
eq(E.recalcQuote([], { tax_rate_pct: 13 }), { subtotal_cents: 0, discount_cents: 0, tax_cents: 0, total_cents: 0 }, 'no lines = zeros');

sec('J · from a photo to a line, and inside / outside the rules');
eq(Q.humanize('water_heater_replacement_40gal'), 'water heater replacement 40gal', 'humanize'); eq(Q.money(247470), '$2,474.70', 'money');
eq(Q.candidatesFor(SCOPES[0].scope).map(c => c.text), ['water_heater_replacement_40gal', 'water heater replacement 40gal', 'gas water heater'], 'search texts, most trusted first, no duplicates');
const cfgGR = Q.resolveConfig({ max_variance_pct: 10 }, { max_autonomous_value_cents: 50000 });
eq(cfgGR, { owner_approval_required: true, quote_as_range: true, max_variance_pct: 10, max_autonomous_quote_cents: 50000, ai_confidence_floor: 0.7 }, 'Grand River config: machine setting → tenant setting → registry default');
eq(Q.resolveConfig({ max_variance_pct: 25 }, {}).max_variance_pct, 10, 'a 25% envelope is clamped to 10 — the table would refuse it anyway');
eq(Q.resolveConfig({ max_autonomous_quote_cents: 120000 }, { max_autonomous_value_cents: 50000 }).max_autonomous_quote_cents, 120000, 'the machine setting beats the tenant-level one');
const usable = SCOPES.filter(d => d.usable), plans = Q.groupDrafts(usable).map(g => Q.planGroup(BOOK, GR, g, null, cfgGR, ON));
eq(usable.length, 5, 'five of the eight stand-in scopes are usable'); eq(plans.length, 5, 'no job ids → five separate quotes');
eq(plans.map(p => p.engine_totals.total_cents), [247470, 247470, 401150, 33335, 680825], 'the five prices: $2,474.70 · $2,474.70 · $4,011.50 · $333.35 · $6,808.25');
eq(plans.map(p => p.rules.inside), [false, false, false, false, false], 'all five are outside the rules…');
eq(plans[0].rules.reasons.map(x => x.code), ['fuzzy_match', 'over_limit', 'tier_assumed'], '…water heater: closest-match, over the $500 limit, no address');
eq(plans[1].rules.reasons.map(x => x.code), ['fuzzy_match', 'over_limit', 'low_confidence', 'tier_assumed'], '…tight water heater: also only 62% sure');
eq(plans[2].rules.reasons.map(x => x.code), ['fuzzy_match', 'requires_site_visit', 'over_limit', 'tier_assumed'], '…panel: a site-visit line');
eq(plans[3].rules.reasons.map(x => x.code), ['ambiguous_match', 'low_confidence', 'tier_assumed'], '…P-trap: could be two services');
eq(plans[4].rules.reasons.map(x => x.code), ['requires_site_visit', 'over_limit', 'low_confidence', 'tier_assumed'], '…furnace: exact match but site-visit, big, and 66% sure');
ok(plans[1].engine_totals.total_cents === plans[0].engine_totals.total_cents, 'tight access does NOT change the price: there is no access premium on this price list, so none is invented');
ok(plans[2].rules.notes.some(n => n.code === 'range_priced' && /\$2,850\.00–\$4,250\.00/.test(n.plain)), 'the panel note carries the contractor\'s own range');
ok(plans.every(p => p.inputs.every(i => i.premiums.length === 0)), 'no premium is ever added from a photo');
const job = { address: '44 Elm St, Guelph ON' };
eq(Q.pickTier(BOOK, GR, job, ON), { tier_no: 2, assumed: false, city: 'Guelph' }, 'a Guelph address = zone 2');
eq(Q.pickTier(BOOK, GR, { address: '1 Main St, Toronto' }, ON).why, 'address_not_in_any_zone', 'an address outside every zone is said so');
eq(Q.pickTier(BOOK, GR, null, ON).why, 'no_address', 'no address is said so');
const inside = Q.planGroup(BOOK, GR, { key: 'k', job_id: 'j', contact_id: null, drafts: [{ id: 'd', job_id: 'j', ai_confidence: 0.9, scope: { item_type: 'toilet', quote_hints: { likely_line_items: ['toilet_repair'] } } }] }, { address: 'Kitchener' }, cfgGR, ON);
eq([inside.rules.inside, inside.rules.reasons, inside.engine_totals.total_cents], [true, [], 25425], 'a $254.25 toilet repair, exact match, 90% sure, known address: INSIDE the rules (and still goes to approval)');
const roof = Q.planGroup(BOOK, GR, { key: 'k', job_id: null, drafts: [{ id: 'd', ai_confidence: 0.9, scope: { item_type: 'roof — missing shingles', quote_hints: { likely_line_items: ['roof_shingle_repair'] } } }] }, null, cfgGR, ON);
eq([roof.inputs.length, roof.rules.inside, roof.rules.reasons[0].code], [0, false, 'no_rate_card_match'], 'a roof on a mechanical shop\'s price list: no number at all');
const rough = Q.planGroup(BOOK, GR, { key: 'k', job_id: null, drafts: [{ id: 'd', ai_confidence: 0.9, scope: { item_type: 'rough-in', quote_hints: { likely_line_items: ['bathroom_rough_in'] } } }] }, null, cfgGR, ON);
eq([rough.inputs.length, rough.rules.reasons[0].code], [0, 'not_ai_quotable'], 'a service marked never-from-a-photo is never priced from a photo');
const urgent = Q.planGroup(BOOK, GR, { key: 'k', job_id: 'j', drafts: [{ id: 'd', job_id: 'j', ai_confidence: 0.9, scope: { item_type: 'toilet', quote_hints: { likely_line_items: ['toilet_repair'], emergency: true } } }] }, { address: 'Kitchener' }, cfgGR, ON);
eq([urgent.inputs[0].premiums, urgent.rules.reasons.map(x => x.code)], [[], ['emergency_hint']], 'the model saying "urgent" adds NO premium — it raises a flag for the owner');
const multi = Q.planGroup(BOOK, GR, { key: 'k', job_id: 'j', drafts: [
  { id: 'a', job_id: 'j', ai_confidence: 0.6, scope: { item_type: 'gas water heater', quantity: 1, quote_hints: { likely_line_items: ['water_heater_replacement_40gal_gas'] } } },
  { id: 'b', job_id: 'j', ai_confidence: 0.8, scope: { item_type: 'gas water heater', quantity: 1, quote_hints: { likely_line_items: ['water_heater_replacement_40gal_gas'] } } },
  { id: 'c', job_id: 'j', ai_confidence: 0.85, scope: { item_type: 'shutoff', quantity: 1, quote_hints: { likely_line_items: ['shutoff_valve_replacement'] } } }] }, job, cfgGR, ON);
eq([multi.inputs.length, multi.inputs.map(i => i.qty), multi.ai_confidence, multi.engine_totals.total_cents], [2, [1, 1], 0.8, 320491], 'three photos, two services, one heater (not two), $3,204.91');
eq(Q.qtyFor({ quantity: 6 }, { unit: 'each' }), 6, 'a count of 6 on a per-each service'); eq(Q.qtyFor({ quantity: 6 }, { unit: 'hour' }), 1, 'never multiplies hours from a photo');
eq(Q.qtyFor({ quantity: 500 }, { unit: 'each' }), 1, 'an absurd count is not trusted'); eq(Q.qtyFor({ dimensions: { length_ft: 12.345 } }, { unit: 'ft' }), 12.35, 'feet come from a measured length');
eq(Q.resolveConfig({ owner_approval_required: false }, {}).owner_approval_required, false, 'the setting is read…');
ok(Q.planGroup(BOOK, GR, { key: 'k', job_id: 'j', drafts: [{ id: 'd', job_id: 'j', ai_confidence: 0.9, scope: { item_type: 'toilet', quote_hints: { likely_line_items: ['toilet_repair'] } } }] }, { address: 'Kitchener' }, Q.resolveConfig({ owner_approval_required: false }, { max_autonomous_value_cents: 50000 }), ON).rules.notes.some(n => n.code === 'approval_setting_ignored'), '…and ignored, out loud: a person approves every AI quote');

sec('K · it is a pure function: same in, same out, nothing touched, nothing reached for');
const snap = JSON.stringify(BOOK);
const a1 = JSON.stringify(P(GR, 'my sump pump please', { tier: 3, premiums: ['weekend', 'holiday', 'emergency', 'x'], qty: 2.5 }));
const a2 = JSON.stringify(P(GR, 'my sump pump please', { tier: 3, premiums: ['weekend', 'holiday', 'emergency', 'x'], qty: 2.5 }));
ok(a1 === a2, 'two runs, byte-identical output'); ok(JSON.stringify(BOOK) === snap, 'the price list object is not modified by pricing');
const shuffled = clone(BOOK); shuffled.items.reverse(); shuffled.premiums.reverse(); shuffled.tiers.reverse();
ok(JSON.stringify(E.priceLine(shuffled, { tenant: GR, service: 'replacement', tier: 3, premiums: ['weekend', 'holiday', 'emergency'], on: ON })) === JSON.stringify(P(GR, 'replacement', { tier: 3, premiums: ['weekend', 'holiday', 'emergency'] })), 'row order in does not change the answer out');
['pricing-engine.js', 'quote-rules.js'].forEach(f => {
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const banned = ['fetch(', 'XMLHttpRequest', 'WebSocket', 'child_process', "require('http", "require('https", "require('net", "require('fs", 'Math.random', 'anthropic', 'openai', 'process.env', 'eval(', 'Date.now'];
  const hits = banned.filter(b => src.indexOf(b) !== -1);
  ok(hits.length === 0, f + ': no network, no AI, no randomness, no environment, no clock in the code', hits);
});
ok((fs.readFileSync(path.join(__dirname, 'pricing-engine.js'), 'utf8').match(/new Date\(/g) || []).length === 1, 'the engine reads the clock in exactly one place: the DEFAULT pricing date, when the caller gives none');
eq(E.ENGINE_VERSION, '2.0.0', 'engine version'); ok(typeof E.priceLine === 'function' && typeof E.recalcQuote === 'function' && typeof E.findRateItem === 'function', 'the public surface');

console.log('\n' + (fail ? 'FAILED' : 'PASSED') + ' — ' + pass + '/' + (pass + fail) + ' assertions · ' + E.ENGINE_NAME + ' ' + E.ENGINE_VERSION);
process.exit(fail ? 1 : 0);
