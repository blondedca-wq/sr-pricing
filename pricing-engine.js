/* sr-pricing-engine — the SecondRing shared pricing engine
 * ---------------------------------------------------------------------------
 * v2.0.0 · rebuilt Sep 18 2026 line-for-line from the LIVE database functions
 *          public.sr_price_line / sr_find_rate_item / sr_active_rate_card /
 *          sr_quote_recalc  (project tjmxqyuzglcfnhgwamit, schema 10).
 *
 * What it is:  arithmetic on the CONTRACTOR'S OWN price list. Nothing else.
 *   - no AI            - no network        - no dependencies
 *   - no clock in the math (the pricing date is an input)
 *   - money is integer cents end to end; every percentage is applied with
 *     exact integer arithmetic and rounded half-away-from-zero, which is what
 *     Postgres numeric round() does — so the two agree to the cent, always.
 *
 * Who uses it, untouched:  Photo -> Quote, Blueprint AI, Change Orders.
 *
 * THE RULE:  if this file and the database ever disagree, THE DATABASE IS RIGHT
 * and this file is wrong. Never "fix" a conformance failure by editing an
 * expected value. conformance.js proves agreement; sr_save_priced_quote()
 * re-checks every real quote at write time and refuses on a single cent.
 *
 * Runs in Node (module.exports) and in a browser (window.SRPricing).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SRPricing = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ENGINE_NAME = 'sr-pricing-engine';
  var ENGINE_VERSION = '2.0.0';
  // The database objects this version mirrors. conformance.js prints these.
  var MIRRORS = {
    sr_price_line: 'schema 10 + b3 determinism fix #2 (C-collated premium order, exact pct labels)',
    sr_find_rate_item: 'schema 10 + b3 determinism fix #2 (code tie-break, C collation)',
    sr_active_rate_card: 'schema 10',
    sr_quote_recalc: 'schema 10'
  };

  // ---------------------------------------------------------------- decimals
  // An exact decimal: value = n / 10^s, n is a BigInt. Never a float.
  function dec(x) {
    if (x === null || x === undefined) return null;
    if (typeof x === 'object' && typeof x.n === 'bigint') return x;
    if (typeof x === 'bigint') return { n: x, s: 0 };
    var str = typeof x === 'number' ? numToStr(x) : String(x).trim();
    var m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(str);
    if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) throw new Error('not a decimal: ' + x);
    var intp = m[2] || '0', frac = m[3] || '', exp = m[4] ? parseInt(m[4], 10) : 0;
    var n = BigInt(intp + frac), s = frac.length - exp;
    if (s < 0) { n = n * pow10(-s); s = 0; }
    if (m[1] === '-') n = -n;
    return { n: n, s: s };
  }
  function numToStr(x) {
    if (!isFinite(x)) throw new Error('not a finite number: ' + x);
    return String(x); // shortest round-trip repr; "1e-7" style handled by dec()
  }
  function pow10(k) { var r = 1n; for (var i = 0; i < k; i++) r *= 10n; return r; }
  function decIsZero(d) { return d.n === 0n; }
  function decSign(d) { return d.n === 0n ? 0 : (d.n > 0n ? 1 : -1); }
  function decCmp(a, b) { // compare two decimals
    var s = Math.max(a.s, b.s);
    var x = a.n * pow10(s - a.s), y = b.n * pow10(s - b.s);
    return x === y ? 0 : (x > y ? 1 : -1);
  }
  function decSub(a, b) { var s = Math.max(a.s, b.s); return { n: a.n * pow10(s - a.s) - b.n * pow10(s - b.s), s: s }; }
  function decAdd(a, b) { var s = Math.max(a.s, b.s); return { n: a.n * pow10(s - a.s) + b.n * pow10(s - b.s), s: s }; }
  // numeric -> plain JS number for echoing back (qty, pct). Safe: these are small.
  function decToNumber(d) { return Number(decToString(d)); }
  function decToString(d) {
    var neg = d.n < 0n, a = neg ? -d.n : d.n, str = a.toString();
    if (d.s > 0) {
      while (str.length <= d.s) str = '0' + str;
      str = str.slice(0, str.length - d.s) + '.' + str.slice(str.length - d.s);
    }
    return (neg ? '-' : '') + str;
  }
  // trailing zeros gone: 2.50 -> "2.5", 3.00 -> "3"
  function decTrim(d) {
    var n = d.n, s = d.s;
    while (s > 0 && n % 10n === 0n) { n /= 10n; s--; }
    return { n: n, s: s };
  }

  // round(n / d) half away from zero — Postgres numeric round().
  function divRound(n, d) {
    if (d === 0n) throw new Error('division by zero');
    if (d < 0n) { n = -n; d = -d; }
    var neg = n < 0n; if (neg) n = -n;
    var q = n / d, r = n % d;
    if (r * 2n >= d) q += 1n;
    return neg ? -q : q;
  }
  // round(cents * decimal / divisor)
  function mulRound(cents, d, divisor) {
    return divRound(cents * d.n, (divisor || 1n) * pow10(d.s));
  }
  // floor(n / d) toward -infinity — Postgres floor().
  function divFloor(n, d) {
    if (d < 0n) { n = -n; d = -d; }
    var q = n / d, r = n % d;
    if (r !== 0n && n < 0n) q -= 1n;
    return q;
  }
  function big(x) {
    if (typeof x === 'bigint') return x;
    if (x === null || x === undefined) return null;
    if (typeof x === 'number') { if (!Number.isInteger(x)) throw new Error('cents must be an integer: ' + x); return BigInt(x); }
    if (/^[+-]?\d+$/.test(String(x))) return BigInt(x);
    throw new Error('cents must be an integer: ' + x);
  }
  function num(b) { // BigInt cents -> Number, refusing silent precision loss
    if (b === null || b === undefined) return null;
    var n = Number(b);
    if (!Number.isSafeInteger(n)) throw new Error('amount exceeds safe integer range: ' + b);
    return n;
  }

  // ------------------------------------------------------------- formatting
  // rtrim(to_char(pct,'FM9990.99'),'.')   5.00 -> "5"   7.50 -> "7.5"   12.35 -> "12.35"
  function fmtPct(d) {
    var r = { n: divRound(d.n * 100n, pow10(d.s)), s: 2 }; // to 2 dp, half away from zero
    var abs = r.n < 0n ? -r.n : r.n;
    if (abs >= 1000000n) return (r.n < 0n ? '-' : '') + '####.##'; // to_char overflow; numeric(6,2) cannot reach this
    return decToString(decTrim(r));
  }
  // to_char(cents/100.0,'FM999,990.00')
  function fmtMoney(cents) {
    var neg = cents < 0n, a = neg ? -cents : cents;
    var ip = a / 100n, fp = a % 100n;
    if (ip > 999999n) return (neg ? '-' : '') + '###,###.##';
    var s = ip.toString(), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (neg ? '-' : '') + s + out + '.' + (fp < 10n ? '0' : '') + fp.toString();
  }
  // initcap(left(name,1)) || substr(name,2)
  function capFirst(name) {
    if (!name) return name;
    var cp = Array.from(name);
    var up = cp[0].toUpperCase();
    if (Array.from(up).length !== 1) up = cp[0]; // initcap never expands one char into two (ß stays ß)
    return up + cp.slice(1).join('');
  }

  // ---------------------------------------------------------------- matching
  // Postgres LIKE: % = any run, _ = any one character, backslash escapes the next character.
  // A hand-rolled matcher (no RegExp): nothing to escape, no backtracking blow-ups.
  function likeTokens(pattern) {
    var cp = Array.from(pattern), out = [];
    for (var i = 0; i < cp.length; i++) {
      var c = cp[i];
      if (c === '\\') {
        if (i + 1 >= cp.length) throw new Error('LIKE pattern must not end with escape character');
        out.push({ lit: cp[++i] });
      } else if (c === '%') { if (!out.length || !out[out.length - 1].any) out.push({ any: true }); }
      else if (c === '_') out.push({ one: true });
      else out.push({ lit: c });
    }
    return out;
  }
  function like(str, pattern) {
    var s = Array.from(str), p = likeTokens(pattern);
    var si = 0, pi = 0, starP = -1, starS = 0;
    while (si < s.length) {
      if (pi < p.length && (p[pi].one || (p[pi].lit !== undefined && p[pi].lit === s[si]))) { si++; pi++; }
      else if (pi < p.length && p[pi].any) { starP = pi++; starS = si; }
      else if (starP !== -1) { pi = starP + 1; si = ++starS; }
      else return false;
    }
    while (pi < p.length && p[pi].any) pi++;
    return pi === p.length;
  }

  // byte-wise (COLLATE "C") comparison of two strings
  var _enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  function cmpC(a, b) {
    if (a === b) return 0;
    if (_enc) {
      var x = _enc.encode(a), y = _enc.encode(b), n = Math.min(x.length, y.length);
      for (var i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
      return x.length === y.length ? 0 : (x.length < y.length ? -1 : 1);
    }
    return a < b ? -1 : 1;
  }
  // btrim(): Postgres trims SPACES only, not tabs or newlines.
  function btrim(s) { return String(s).replace(/^ +| +$/g, ''); }

  // sr_active_rate_card(tenant, on)
  function activeRateCard(book, tenantId, on) {
    var best = null;
    (book.rate_cards || []).forEach(function (rc) {
      if (rc.tenant_id !== tenantId || rc.status !== 'active') return;
      if (!(String(rc.effective_from).slice(0, 10) <= on)) return;
      if (rc.effective_to !== null && rc.effective_to !== undefined && !(String(rc.effective_to).slice(0, 10) >= on)) return;
      if (!best || String(rc.effective_from) > String(best.effective_from)) best = rc;
    });
    return best;
  }

  // sr_find_rate_item(tenant, text, on)  ->  { item, match_kind } | null
  function findRateItem(book, tenantId, text, on) {
    var card = activeRateCard(book, tenantId, on);
    if (!card) return null;
    var t = btrim(text === null || text === undefined ? '' : String(text)).toLowerCase(); // lower(btrim(coalesce(x,'')))
    if (Array.from(t).length < 3) return null;
    var pContains = '%' + t + '%';
    var hits = [];
    (book.items || []).forEach(function (i) {
      if (i.rate_card_id !== card.id || !i.active) return;
      var lname = String(i.name).toLowerCase();
      var aliases = (i.aliases || []).filter(function (a) { return a !== null && a !== undefined; });
      var rank, kind;
      if (i.code === t) { rank = 0; kind = 'code'; }
      else if (lname === t) { rank = 1; kind = 'name'; }
      else if (aliases.indexOf(t) !== -1) { rank = 2; kind = 'alias'; }
      else if (like(lname, pContains)) { rank = 3; kind = 'name_contains'; }
      else if (aliases.some(function (a) { return like(a, pContains) || like(t, '%' + a + '%'); })) { rank = 4; kind = 'alias_fuzzy'; }
      else return;
      hits.push({ item: i, rank: rank, kind: kind });
    });
    if (!hits.length) return null;
    hits.sort(function (a, b) {
      return (a.rank - b.rank) || (Number(a.item.sort) - Number(b.item.sort)) || cmpC(a.item.code, b.item.code);
    });
    return { item: hits[0].item, match_kind: hits[0].kind };
  }

  // ----------------------------------------------------------------- pricing
  // sr_price_line(tenant, service, tier, premiums[], qty, variance_pct, on)
  // args.on is REQUIRED in spirit (pass the pricing date). If omitted, today's
  // UTC date is used — the same thing CURRENT_DATE gives a UTC database session.
  function priceLine(book, args) {
    args = args || {};
    var tenant = args.tenant;
    var service = args.service === undefined ? null : args.service;
    var pTier = args.tier === undefined ? 1 : args.tier;
    var pPrem = args.premiums === undefined ? [] : args.premiums;
    var pQty = args.qty === undefined ? 1 : args.qty;
    var pVar = args.variance_pct === undefined ? 10 : args.variance_pct;
    var on = args.on || new Date().toISOString().slice(0, 10);

    var card = activeRateCard(book, tenant, on);
    if (!card) return { ok: false, reason: 'no_active_rate_card' };

    var found = findRateItem(book, tenant, service, on);
    if (!found) return { ok: false, reason: 'no_rate_card_match', input: service, flags: ['no_rate_card_match'] };
    var item = found.item, match = found.match_kind;

    var flags = [], lines = [], n = 0;
    if (item.requires_site_visit) flags.push('requires_site_visit');
    if (!item.ai_quotable) flags.push('not_ai_quotable');

    var qty = dec(pQty === null ? 1 : pQty);
    var basePrice = big(item.base_price_cents);
    var vBase = mulRound(basePrice, qty);
    n++;
    lines.push({
      line_no: n, kind: 'service', description: capFirst(item.name),
      qty: decToNumber(qty), unit: item.unit, unit_cents: num(basePrice), line_cents: num(vBase),
      taxable: !!item.taxable, rate_card_item_id: item.id, pricing_model: item.pricing_model,
      low_price_cents: item.low_price_cents === undefined ? null : item.low_price_cents,
      high_price_cents: item.high_price_cents === undefined ? null : item.high_price_cents
    });

    // geographic tier
    var tierNo = pTier === null ? 1 : pTier;
    var tier = null;
    (book.tiers || []).forEach(function (t) {
      if (t.rate_card_id === card.id && Number(t.tier_no) === Number(tierNo) && t.active) tier = t;
    });
    var vUplift = 0n, vTravel = 0n;
    if (!tier) flags.push('unknown_tier');
    else {
      var up = dec(tier.uplift_pct);
      if (!decIsZero(up)) {
        vUplift = mulRound(vBase, up, 100n);
        n++;
        lines.push({
          line_no: n, kind: 'adjustment',
          description: 'Tier ' + tier.tier_no + ' uplift ' + fmtPct(up) + '%  (' + tier.name + ')',
          qty: 1, unit: 'each', unit_cents: num(vUplift), line_cents: num(vUplift), taxable: !!item.taxable, tier_id: tier.id
        });
      }
      vTravel = big(tier.travel_fee_cents);
    }
    var vServiceSub = vBase + vUplift;

    // premiums: highest pct per stack_group wins, flats add
    var asked = (pPrem === null ? [] : pPrem).filter(function (x) { return x !== null && x !== undefined; }).map(String);
    var rows = (book.premiums || []).filter(function (p) {
      return p.rate_card_id === card.id && p.active && asked.indexOf(p.code) !== -1;
    });
    // row_number() over (partition by stack_group order by pct desc, flat_cents desc, code collate "C")
    var byGroup = {};
    rows.forEach(function (p) { (byGroup[p.stack_group] = byGroup[p.stack_group] || []).push(p); });
    Object.keys(byGroup).forEach(function (g) {
      byGroup[g].sort(function (a, b) {
        return -decCmp(dec(a.pct), dec(b.pct)) || -cmpBig(big(a.flat_cents), big(b.flat_cents)) || cmpC(a.code, b.code);
      });
      byGroup[g].forEach(function (p, idx) { p.__rn = idx + 1; });
    });
    rows.sort(function (a, b) { return cmpC(a.stack_group, b.stack_group) || cmpC(a.code, b.code); });

    var applied = [], vPremTotal = 0n;
    rows.forEach(function (p) {
      var rn = p.__rn; delete p.__rn;
      if (p.requires_emergency_eligible && !item.emergency_eligible) { flags.push('premium_not_eligible'); return; }
      if (rn > 1) return; // does not stack within its group
      applied.push(p.code);
      var pct = dec(p.pct), flat = big(p.flat_cents);
      if (decSign(pct) > 0) {
        var amt = mulRound(vServiceSub, pct, 100n);
        n++;
        lines.push({
          line_no: n, kind: 'premium', description: p.name + ' ' + fmtPct(pct) + '%',
          qty: 1, unit: 'each', unit_cents: num(amt), line_cents: num(amt), taxable: !!item.taxable, premium_id: p.id
        });
        vPremTotal += amt;
      }
      if (flat > 0n) {
        n++;
        lines.push({
          line_no: n, kind: 'premium', description: p.name,
          qty: 1, unit: 'each', unit_cents: num(flat), line_cents: num(flat), taxable: !!item.taxable, premium_id: p.id
        });
        vPremTotal += flat;
      }
    });
    rows.forEach(function (p) { delete p.__rn; });

    var ignored = asked.filter(function (x) { return applied.indexOf(x) === -1; });
    var known = {};
    (book.premiums || []).forEach(function (p) { if (p.rate_card_id === card.id) known[p.code] = true; });
    if (asked.some(function (x) { return !known[x]; })) flags.push('unknown_premium');

    if (vTravel > 0n) {
      n++;
      lines.push({
        line_no: n, kind: 'travel', description: 'Travel — ' + tier.name,
        qty: 1, unit: 'each', unit_cents: num(vTravel), line_cents: num(vTravel), taxable: !!item.taxable, tier_id: tier.id
      });
    }

    var vSubtotal = vServiceSub + vPremTotal + vTravel;
    var floorCents = maxBig(big(card.min_charge_cents), item.min_price_cents === null || item.min_price_cents === undefined ? 0n : big(item.min_price_cents));
    var minApplied = false;
    if (vSubtotal < floorCents) { vSubtotal = floorCents; minApplied = true; flags.push('min_charge_applied'); }

    var taxRate = dec(card.tax_rate_pct);
    var vTax = (item.taxable && !card.prices_include_tax) ? mulRound(vSubtotal, taxRate, 100n) : 0n;
    var vTotal = vSubtotal + vTax;

    var variance = dec(pVar);
    var envLow = mulRound(vSubtotal, decSub(dec(100), variance), 100n);
    var envHigh = mulRound(vSubtotal, decAdd(dec(100), variance), 100n);

    return {
      ok: true,
      input: { service: service, tier: pTier, premiums: asked, qty: decToNumber(qty), on: on },
      resolved: {
        rate_card: card.name, rate_card_id: card.id, currency: card.currency,
        item_code: item.code, item_name: item.name, match: match, pricing_model: item.pricing_model,
        tier: tier ? tier.name : null, premiums_applied: applied, premiums_ignored: ignored
      },
      lines: lines,
      subtotal_cents: num(vSubtotal), min_charge_applied: minApplied,
      tax_label: card.tax_label, tax_rate_pct: decToNumber(taxRate), tax_cents: num(vTax), total_cents: num(vTotal),
      variance: { max_pct: decToNumber(variance), envelope_low_cents: num(envLow), envelope_high_cents: num(envHigh) },
      flags: flags,
      display: capFirst(item.name) + ' · ' + (tier ? tier.name : 'no tier') + ' · ' + (applied.length ? applied.join('+') : 'no premium') +
        ' → $' + fmtMoney(vSubtotal) + ' + ' + card.tax_label + ' $' + fmtMoney(vTax) + ' = $' + fmtMoney(vTotal) +
        '  (envelope $' + fmtMoney(envLow) + '–$' + fmtMoney(envHigh) + ')'
    };
  }
  function cmpBig(a, b) { return a === b ? 0 : (a > b ? 1 : -1); }
  function maxBig(a, b) { return a > b ? a : b; }

  // sr_quote_recalc(): totals follow the lines. Tax is charged once, on the
  // summed taxable base — NOT per line — so a multi-line quote can differ from
  // the sum of its parts by a cent. This mirrors the database trigger exactly.
  //   lines: [{kind, line_cents, taxable}]   opts: {tax_rate_pct, prices_include_tax, deposit_pct}
  function recalcQuote(lines, opts) {
    opts = opts || {};
    var sub = 0n, disc = 0n, taxbase = 0n;
    (lines || []).forEach(function (l) {
      var c = big(l.line_cents);
      if (l.kind !== 'discount') sub += c; else disc += -c;
      if (l.taxable) taxbase += c;
    });
    var rate = dec(opts.tax_rate_pct === undefined || opts.tax_rate_pct === null ? 0 : opts.tax_rate_pct);
    var tax = opts.prices_include_tax ? 0n : mulRound(taxbase > 0n ? taxbase : 0n, rate, 100n);
    var total = sub - disc + tax;
    var out = { subtotal_cents: num(sub), discount_cents: num(disc), tax_cents: num(tax), total_cents: num(total) };
    if (opts.deposit_pct !== undefined && opts.deposit_pct !== null) out.deposit_cents = num(mulRound(total, dec(opts.deposit_pct), 100n));
    return out;
  }

  // Ontario Consumer Protection Act s.10 cap the database enforces:
  // floor(estimate_total * 1.10). A quote that supersedes an estimate may not pass it.
  function cpaCap(estimateTotalCents) { return num(divFloor(big(estimateTotalCents) * 110n, 100n)); }

  // The lines a quote needs so its database totals equal priceLine()'s numbers,
  // including the one case where they would not: the minimum charge.
  function quoteLinesFor(result) {
    if (!result || !result.ok) return [];
    var lines = result.lines.map(function (l) { return Object.assign({}, l); });
    if (result.min_charge_applied) {
      var sum = lines.reduce(function (a, l) { return a + l.line_cents; }, 0);
      lines.push({
        line_no: lines.length + 1, kind: 'adjustment', description: 'Minimum charge adjustment',
        qty: 1, unit: 'each', unit_cents: result.subtotal_cents - sum, line_cents: result.subtotal_cents - sum,
        taxable: lines[0].taxable
      });
    }
    return lines;
  }

  return {
    ENGINE_NAME: ENGINE_NAME, ENGINE_VERSION: ENGINE_VERSION, MIRRORS: MIRRORS,
    priceLine: priceLine, findRateItem: findRateItem, activeRateCard: activeRateCard,
    recalcQuote: recalcQuote, cpaCap: cpaCap, quoteLinesFor: quoteLinesFor,
    _internals: { dec: dec, divRound: divRound, divFloor: divFloor, mulRound: mulRound, fmtPct: fmtPct, fmtMoney: fmtMoney, capFirst: capFirst, like: like, cmpC: cmpC, btrim: btrim, decToString: decToString, decTrim: decTrim }
  };
});
