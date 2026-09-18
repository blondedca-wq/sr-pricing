-- b3-sql-determinism-fix-2.sql — Category B Day 3 (Fri Sep 18 2026)
-- Found by the conformance matrix while wiring sr-pricing. Same class as the Sep 9 fixes:
-- NOT ONE EXISTING NUMBER CHANGES. Conformance output on both live rate cards is identical
-- before and after (every live percentage is a whole number and every tie below is latent).
--
-- FIX 3  sr_find_rate_item ended its ORDER BY at i.sort. Grand River's card re-uses sort values
--        (breaker_replacement and sump_pump_replacement are both 30), so the word "replacement"
--        matched two services at the same rank and the same sort and Postgres was free to pick
--        either. Ends the ORDER BY with the unique code.
-- FIX 4  The premium ordering compared codes under the database collation (en_US ICU). Under ICU
--        'tier_1' sorts before 'tier1'; in byte order it is after. The engine compares bytes, so
--        the ORDER BYs are pinned to COLLATE "C" and the two can never disagree about which
--        premium wins a stack group or which line prints first.
-- FIX 5  to_char(pct,'FM990.##') is not a valid numeric template: '#' is not a digit position, so
--        a 7.5% uplift was LABELLED "8%" on the customer-facing line while being CHARGED at 7.5%.
--        Labels now print the real figure (5 -> "5", 7.5 -> "7.5", 12.35 -> "12.35").
--        The arithmetic was always right; only the words were wrong.
--
-- Both statements are CREATE OR REPLACE with unchanged signatures: no dialog, no data touched.

CREATE OR REPLACE FUNCTION public.sr_find_rate_item(p_tenant uuid, p_text text, p_on date DEFAULT CURRENT_DATE)
 RETURNS TABLE(item_id uuid, code text, name text, match_kind text)
 LANGUAGE sql
 STABLE
AS $function$
  with q as (select lower(btrim(coalesce(p_text,''))) t),
       c as (select public.sr_active_rate_card(p_tenant, p_on) id)
  select i.id, i.code, i.name,
         case when i.code = q.t                 then 'code'
              when lower(i.name) = q.t          then 'name'
              when q.t = any(i.aliases)         then 'alias'
              when lower(i.name) like '%'||q.t||'%' then 'name_contains'
              else 'alias_fuzzy' end
    from public.rate_card_items i, q, c
   where i.rate_card_id = c.id and i.active and length(q.t) >= 3
     and ( i.code = q.t or lower(i.name) = q.t or q.t = any(i.aliases)
           or lower(i.name) like '%'||q.t||'%'
           or exists (select 1 from unnest(i.aliases) a where a like '%'||q.t||'%' or q.t like '%'||a||'%') )
   order by case when i.code = q.t then 0 when lower(i.name) = q.t then 1 when q.t = any(i.aliases) then 2
                 when lower(i.name) like '%'||q.t||'%' then 3 else 4 end,
            i.sort,
            i.code collate "C"                                                          -- <<< FIX 3
   limit 1
$function$
;

CREATE OR REPLACE FUNCTION public.sr_price_line(p_tenant uuid, p_service text, p_tier integer DEFAULT 1, p_premiums text[] DEFAULT '{}'::text[], p_qty numeric DEFAULT 1, p_variance_pct numeric DEFAULT 10, p_on date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  v_card      public.rate_cards%rowtype;
  v_item      public.rate_card_items%rowtype;
  v_match     text;
  v_tier      public.pricing_tiers%rowtype;
  v_prem      record;
  v_lines     jsonb := '[]'::jsonb;
  v_flags     jsonb := '[]'::jsonb;
  v_applied   text[] := '{}';
  v_ignored   text[] := '{}';
  v_base      bigint;
  v_uplift    bigint := 0;
  v_travel    bigint := 0;
  v_prem_amt  bigint := 0;
  v_prem_total bigint := 0;
  v_service_sub bigint;
  v_subtotal  bigint;
  v_min_applied boolean := false;
  v_tax       bigint;
  v_total     bigint;
  v_n         integer := 0;
begin
  select * into v_card from public.rate_cards where id = public.sr_active_rate_card(p_tenant, p_on);
  if v_card.id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_active_rate_card');
  end if;

  select f.item_id, f.match_kind into v_item.id, v_match from public.sr_find_rate_item(p_tenant, p_service, p_on) f;
  if v_item.id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_rate_card_match', 'input', p_service,
                              'flags', '["no_rate_card_match"]'::jsonb);
  end if;
  select * into v_item from public.rate_card_items where id = v_item.id;

  if v_item.requires_site_visit then v_flags := v_flags || '"requires_site_visit"'::jsonb; end if;
  if not v_item.ai_quotable      then v_flags := v_flags || '"not_ai_quotable"'::jsonb;     end if;

  -- service line
  v_base := round(v_item.base_price_cents * coalesce(p_qty,1));
  v_n := v_n + 1;
  v_lines := v_lines || jsonb_build_object('line_no', v_n, 'kind','service', 'description', initcap(left(v_item.name,1))||substr(v_item.name,2),
              'qty', coalesce(p_qty,1), 'unit', v_item.unit, 'unit_cents', v_item.base_price_cents, 'line_cents', v_base,
              'taxable', v_item.taxable, 'rate_card_item_id', v_item.id, 'pricing_model', v_item.pricing_model,
              'low_price_cents', v_item.low_price_cents, 'high_price_cents', v_item.high_price_cents);

  -- geographic tier
  select * into v_tier from public.pricing_tiers where rate_card_id = v_card.id and tier_no = coalesce(p_tier,1) and active;
  if v_tier.id is null then
    v_flags := v_flags || '"unknown_tier"'::jsonb;
  else
    if v_tier.uplift_pct <> 0 then
      v_uplift := round(v_base * v_tier.uplift_pct / 100.0);
      v_n := v_n + 1;
      v_lines := v_lines || jsonb_build_object('line_no', v_n, 'kind','adjustment',
                  'description', format('Tier %s uplift %s%%  (%s)', v_tier.tier_no, rtrim(to_char(v_tier.uplift_pct,'FM9990.99'),'.'), v_tier.name),
                  'qty', 1, 'unit','each', 'unit_cents', v_uplift, 'line_cents', v_uplift, 'taxable', v_item.taxable, 'tier_id', v_tier.id);
    end if;
    v_travel := v_tier.travel_fee_cents;
  end if;
  v_service_sub := v_base + v_uplift;

  -- premiums: highest pct per stack_group, flats add
  for v_prem in
    select p.*, row_number() over (partition by p.stack_group
                                   order by p.pct desc, p.flat_cents desc, p.code collate "C") rn   -- <<< FIX 1 + FIX 4
      from public.pricing_premiums p
     where p.rate_card_id = v_card.id and p.active and p.code = any(coalesce(p_premiums,'{}'))
     order by p.stack_group collate "C", p.code collate "C"                              -- <<< FIX 2 + FIX 4
  loop
    if v_prem.requires_emergency_eligible and not v_item.emergency_eligible then
      v_flags := v_flags || '"premium_not_eligible"'::jsonb; continue;
    end if;
    if v_prem.rn > 1 then continue; end if;   -- does not stack within its group
    v_applied := v_applied || v_prem.code;
    if v_prem.pct > 0 then
      v_prem_amt := round(v_service_sub * v_prem.pct / 100.0);
      v_n := v_n + 1;
      v_lines := v_lines || jsonb_build_object('line_no', v_n, 'kind','premium',
                  'description', format('%s %s%%', v_prem.name, rtrim(to_char(v_prem.pct,'FM9990.99'),'.')),
                  'qty', 1, 'unit','each', 'unit_cents', v_prem_amt, 'line_cents', v_prem_amt, 'taxable', v_item.taxable, 'premium_id', v_prem.id);
      v_prem_total := v_prem_total + v_prem_amt;
    end if;
    if v_prem.flat_cents > 0 then
      v_n := v_n + 1;
      v_lines := v_lines || jsonb_build_object('line_no', v_n, 'kind','premium', 'description', v_prem.name,
                  'qty', 1, 'unit','each', 'unit_cents', v_prem.flat_cents, 'line_cents', v_prem.flat_cents, 'taxable', v_item.taxable, 'premium_id', v_prem.id);
      v_prem_total := v_prem_total + v_prem.flat_cents;
    end if;
  end loop;

  -- everything asked for but not applied is reported back
  v_ignored := (select coalesce(array_agg(x), '{}') from unnest(coalesce(p_premiums,'{}')) x where x <> all(v_applied));
  if exists (select 1 from unnest(coalesce(p_premiums,'{}')) x
              where not exists (select 1 from public.pricing_premiums p where p.rate_card_id = v_card.id and p.code = x)) then
    v_flags := v_flags || '"unknown_premium"'::jsonb;
  end if;

  -- travel
  if v_travel > 0 then
    v_n := v_n + 1;
    v_lines := v_lines || jsonb_build_object('line_no', v_n, 'kind','travel', 'description', format('Travel — %s', v_tier.name),
                'qty', 1, 'unit','each', 'unit_cents', v_travel, 'line_cents', v_travel, 'taxable', v_item.taxable, 'tier_id', v_tier.id);
  end if;

  v_subtotal := v_service_sub + v_prem_total + v_travel;
  if v_subtotal < greatest(v_card.min_charge_cents, coalesce(v_item.min_price_cents,0)) then
    v_subtotal := greatest(v_card.min_charge_cents, coalesce(v_item.min_price_cents,0));
    v_min_applied := true;
    v_flags := v_flags || '"min_charge_applied"'::jsonb;
  end if;
  v_tax   := case when v_item.taxable and not v_card.prices_include_tax then round(v_subtotal * v_card.tax_rate_pct / 100.0) else 0 end;
  v_total := v_subtotal + v_tax;

  return jsonb_build_object(
    'ok', true,
    'input', jsonb_build_object('service', p_service, 'tier', p_tier, 'premiums', to_jsonb(coalesce(p_premiums,'{}')), 'qty', coalesce(p_qty,1), 'on', p_on),
    'resolved', jsonb_build_object('rate_card', v_card.name, 'rate_card_id', v_card.id, 'currency', v_card.currency,
                  'item_code', v_item.code, 'item_name', v_item.name, 'match', v_match, 'pricing_model', v_item.pricing_model,
                  'tier', v_tier.name, 'premiums_applied', to_jsonb(v_applied), 'premiums_ignored', to_jsonb(v_ignored)),
    'lines', v_lines,
    'subtotal_cents', v_subtotal, 'min_charge_applied', v_min_applied,
    'tax_label', v_card.tax_label, 'tax_rate_pct', v_card.tax_rate_pct, 'tax_cents', v_tax, 'total_cents', v_total,
    'variance', jsonb_build_object('max_pct', p_variance_pct,
                  'envelope_low_cents',  round(v_subtotal * (100 - p_variance_pct) / 100.0),
                  'envelope_high_cents', round(v_subtotal * (100 + p_variance_pct) / 100.0)),
    'flags', v_flags,
    'display', format('%s · %s · %s → $%s + %s $%s = $%s  (envelope $%s–$%s)',
                 initcap(left(v_item.name,1))||substr(v_item.name,2), coalesce(v_tier.name,'no tier'),
                 coalesce(nullif(array_to_string(v_applied,'+'),''),'no premium'),
                 to_char(v_subtotal/100.0,'FM999,990.00'), v_card.tax_label, to_char(v_tax/100.0,'FM999,990.00'),
                 to_char(v_total/100.0,'FM999,990.00'),
                 to_char(round(v_subtotal*(100-p_variance_pct)/100.0)/100.0,'FM999,990.00'),
                 to_char(round(v_subtotal*(100+p_variance_pct)/100.0)/100.0,'FM999,990.00'))
  );
end $function$
;
