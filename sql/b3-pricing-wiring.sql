-- b3-pricing-wiring.sql — Category B Day 3 (Fri Sep 18 2026) — Photo -> Quote AI II
-- Wires the shared pricing engine (sr-pricing on the droplet) to the quote tables.
-- ADDITIVE ONLY: two nullable columns, one index, three functions, two views. Nothing is dropped,
-- no existing function or table is redefined here (the determinism fix is its own file).
-- Safe to run twice.
--
-- The contract, in one paragraph: the droplet prices with the JS engine, then hands the result to
-- sr_save_priced_quote(). The DATABASE re-prices every line itself with sr_price_line() and refuses
-- the whole quote if the engine is off by a single cent or a single word ("engine_drift"). What is
-- stored is always the database's own arithmetic. Every quote lands as pending_approval with an
-- approvals row — inside the owner's rules or not. There is no path here to a customer.

-- 1 ─ scope drafts remember which quote priced them (so nothing is priced twice)
alter table public.scope_drafts add column if not exists quote_id  uuid references public.quotes(id) on delete set null;
alter table public.scope_drafts add column if not exists priced_at timestamptz;
create index if not exists scope_drafts_unpriced_idx on public.scope_drafts (tenant_id, created_at) where priced_at is null and usable;

-- 2 ─ the write path ──────────────────────────────────────────────────────────────────────────────
create or replace function public.sr_save_priced_quote(p_tenant uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_mode        text;
  v_ids         uuid[];
  v_inputs      jsonb := coalesce(p_payload->'inputs', '[]'::jsonb);
  v_results     jsonb := coalesce(p_payload->'engine_results', '[]'::jsonb);
  v_rules       jsonb := coalesce(p_payload->'rules', '{}'::jsonb);
  v_inside      boolean := coalesce((p_payload->'rules'->>'inside')::boolean, false);
  v_reasons     text;
  v_engine      jsonb := coalesce(p_payload->'engine', '{}'::jsonb);
  v_in          jsonb;
  v_db          jsonb;
  v_dbs         jsonb := '[]'::jsonb;
  v_i           integer;
  v_n           integer;
  v_line        jsonb;
  v_line_no     integer := 0;
  v_sum         bigint;
  v_quote       public.quotes%rowtype;
  v_quote_id    uuid;
  v_quote_no    text;
  v_approval    uuid;
  v_summary     text;
  v_what        text;
  v_var         numeric;
  v_conf        numeric;
  v_job         uuid := nullif(p_payload->>'job_id','')::uuid;
  v_contact     uuid := nullif(p_payload->>'contact_id','')::uuid;
  v_first       jsonb;
  v_blocked     boolean;
  v_eng_tot     jsonb := p_payload->'engine_totals';
  v_detail      jsonb;
begin
  if p_tenant is null or p_payload is null then
    raise exception 'sr_save_priced_quote: p_tenant and p_payload are required';
  end if;
  if auth.uid() is not null and p_tenant not in (select public.auth_tenant_ids()) then
    raise exception 'sr_save_priced_quote: not authorised for tenant %', p_tenant;
  end if;

  select coalesce(array_agg(x::uuid), '{}') into v_ids
    from jsonb_array_elements_text(coalesce(p_payload->'scope_draft_ids','[]'::jsonb)) x;
  if array_length(v_ids,1) is null then
    return jsonb_build_object('ok', false, 'reason', 'no_scope_drafts');
  end if;
  if exists (select 1 from public.scope_drafts where id = any(v_ids) and tenant_id <> p_tenant)
     or (select count(*) from public.scope_drafts where id = any(v_ids) and tenant_id = p_tenant) <> array_length(v_ids,1) then
    return jsonb_build_object('ok', false, 'reason', 'scope_draft_not_found');
  end if;
  if exists (select 1 from public.scope_drafts where id = any(v_ids) and priced_at is not null) then
    return jsonb_build_object('ok', false, 'reason', 'already_priced');
  end if;

  -- the notch is enforced HERE, not just in the runner
  v_mode := public.sr_mode(p_tenant, 'photo_to_quote');
  if v_mode in ('paused', 'not_installed') then
    return jsonb_build_object('ok', false, 'reason', 'machine_' || v_mode);
  end if;

  v_n := jsonb_array_length(v_inputs);
  if v_n <> jsonb_array_length(v_results) then
    return jsonb_build_object('ok', false, 'reason', 'inputs_results_length_mismatch');
  end if;
  v_blocked := (v_n = 0);   -- nothing could be priced: the card still goes to the owner, with no number on it

  -- ── THE DRIFT CHECK: the database re-prices every line and must agree with the engine exactly ──
  for v_i in 0 .. v_n - 1 loop
    v_in := v_inputs->v_i;
    v_db := public.sr_price_line(
              p_tenant,
              v_in->>'service',
              (v_in->>'tier')::integer,
              coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(v_in->'premiums','[]'::jsonb)) x), '{}'),
              coalesce((v_in->>'qty')::numeric, 1),
              coalesce((v_in->>'variance_pct')::numeric, 10),
              coalesce((v_in->>'on')::date, current_date));
    if v_db is distinct from (v_results->v_i) then
      v_detail := jsonb_build_object('index', v_i, 'input', v_in, 'database', v_db, 'engine', v_results->v_i, 'engine_version', v_engine);
      perform public.sr_log(p_tenant, 'photo_to_quote', 'pricing.drift',
        'Engine and database disagree on "' || coalesce(v_in->>'service','?') || '" — nothing was written. The database is right; the engine needs fixing.',
        v_detail, 'scope_draft', v_ids[1]::text, 'error', false, null, null, null, 'engine_conformance', false);
      return jsonb_build_object('ok', false, 'reason', 'engine_drift') || v_detail;
    end if;
    if not coalesce((v_db->>'ok')::boolean, false) then
      return jsonb_build_object('ok', false, 'reason', 'unpriceable_input', 'index', v_i, 'database', v_db);
    end if;
    v_dbs := v_dbs || jsonb_build_array(v_db);
  end loop;

  v_conf  := least(greatest(coalesce((p_payload->>'ai_confidence')::numeric, 0), 0), 1);
  v_first := v_dbs->0;
  v_what  := coalesce(nullif(p_payload->>'what',''), initcap(left(coalesce(v_first->'resolved'->>'item_name','job'),1)) || substr(coalesce(v_first->'resolved'->>'item_name','job'),2));
  v_reasons := (select string_agg(r->>'plain', ' · ') from jsonb_array_elements(coalesce(v_rules->'reasons','[]'::jsonb)) r);

  -- Watch: say what it would have done, write nothing a person has to act on
  if v_mode = 'observe' then
    perform public.sr_log(p_tenant, 'photo_to_quote', 'quote_action_held',
      'WATCH: would have drafted a quote for ' || v_what ||
        case when v_blocked then ' — could not price it: ' || coalesce(v_reasons,'no price-list match')
             else ' — $' || to_char((select sum((d->>'subtotal_cents')::bigint) from jsonb_array_elements(v_dbs) d)/100.0,'FM999,999,990.00') || ' before tax' end,
      jsonb_build_object('held', true, 'scope_draft_ids', to_jsonb(v_ids), 'rules', v_rules, 'database', v_dbs, 'engine', v_engine),
      'scope_draft', v_ids[1]::text, 'info', false, p_payload->>'ai_model', v_conf, null, 'quote_rules', v_inside);
    update public.scope_drafts set priced_at = now() where id = any(v_ids);
    return jsonb_build_object('ok', true, 'held', true, 'mode', v_mode);
  end if;

  -- ── could not be priced at all: the owner still hears about it, with no number attached ──
  if v_blocked then
    v_summary := 'Can''t price this from the photo: ' || v_what || ' — ' || coalesce(v_reasons, 'nothing on your price list matches') || '.';
    v_approval := public.sr_request_approval(p_tenant, 'photo_to_quote', 'quote_review', v_summary,
      jsonb_build_object('priced', false, 'scope_draft_ids', to_jsonb(v_ids), 'rules', v_rules, 'match', p_payload->'match',
                         'job_id', v_job, 'contact_id', v_contact, 'scope_text', p_payload->>'scope_text'),
      'Outside the rules: ' || coalesce(v_reasons,'no price-list match'), 'scope_draft', v_ids[1]::text, 72);
    update public.scope_drafts set priced_at = now() where id = any(v_ids);
    perform public.sr_log(p_tenant, 'photo_to_quote', 'quote.not_priced', v_summary,
      jsonb_build_object('scope_draft_ids', to_jsonb(v_ids), 'approval_id', v_approval, 'rules', v_rules, 'engine', v_engine),
      'scope_draft', v_ids[1]::text, 'warn', false, p_payload->>'ai_model', v_conf, null, 'quote_rules', false);
    return jsonb_build_object('ok', true, 'priced', false, 'approval_id', v_approval);
  end if;

  -- ── write the quote. Everything below is one sub-transaction: all of it lands or none of it ──
  begin
    v_var      := least(coalesce((v_inputs->0->>'variance_pct')::numeric, 10), 10);   -- Ontario CPA s.10: the table refuses more
    v_quote_no := public.sr_new_quote_no(p_tenant);
    insert into public.quotes (tenant_id, quote_no, kind, status, source, contact_id, job_id, rate_card_id, tier_no, premium_codes,
                               currency, tax_label, tax_rate_pct, max_variance_pct, variance_flags, ai_model, ai_confidence,
                               ai_reasoning, scope_text, exclusions_text, notes_internal, approval_mode)
    values (p_tenant, v_quote_no, 'estimate', 'pending_approval', coalesce(nullif(p_payload->>'source',''),'photo'), v_contact, v_job,
            (v_first->'resolved'->>'rate_card_id')::uuid, (v_inputs->0->>'tier')::integer,
            coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(v_inputs->0->'premiums','[]'::jsonb)) x), '{}'),
            coalesce(v_first->'resolved'->>'currency','CAD'), v_first->>'tax_label', (v_first->>'tax_rate_pct')::numeric, v_var,
            jsonb_build_object('inside_rules', v_inside, 'reasons', coalesce(v_rules->'reasons','[]'::jsonb), 'notes', coalesce(v_rules->'notes','[]'::jsonb),
                               'engine_flags', (select coalesce(jsonb_agg(distinct f), '[]'::jsonb) from jsonb_array_elements(v_dbs) d, jsonb_array_elements(d->'flags') f)),
            p_payload->>'ai_model', v_conf, v_reasons, p_payload->>'scope_text', p_payload->>'exclusions_text',
            'Priced by ' || coalesce(v_engine->>'name','sr-pricing-engine') || ' ' || coalesce(v_engine->>'version','?') || ' and re-priced by sr_price_line at write time — identical.',
            'human')
    returning * into v_quote;
    v_quote_id := v_quote.id;

    for v_i in 0 .. v_n - 1 loop
      v_db := v_dbs->v_i;
      v_sum := 0;
      for v_line in select l from jsonb_array_elements(v_db->'lines') l order by (l->>'line_no')::integer loop
        v_line_no := v_line_no + 1;
        v_sum := v_sum + (v_line->>'line_cents')::bigint;
        insert into public.quote_lines (tenant_id, quote_id, line_no, kind, rate_card_item_id, premium_id, tier_id, description, qty, unit,
                                        unit_cents, line_cents, taxable, ai_confidence, variance_flag)
        values (p_tenant, v_quote_id, v_line_no, v_line->>'kind', (v_line->>'rate_card_item_id')::uuid, (v_line->>'premium_id')::uuid,
                (v_line->>'tier_id')::uuid, v_line->>'description', (v_line->>'qty')::numeric, v_line->>'unit',
                (v_line->>'unit_cents')::bigint, (v_line->>'line_cents')::bigint, (v_line->>'taxable')::boolean,
                case when v_line->>'kind' = 'service' then v_conf end,
                case when v_line->>'kind' = 'service' and v_db->'resolved'->>'pricing_model' = 'range' then 'range_priced' end);
      end loop;
      if coalesce((v_db->>'min_charge_applied')::boolean, false) then   -- the one case the lines do not add up to the price
        v_line_no := v_line_no + 1;
        insert into public.quote_lines (tenant_id, quote_id, line_no, kind, description, qty, unit, unit_cents, line_cents, taxable)
        values (p_tenant, v_quote_id, v_line_no, 'adjustment', 'Minimum charge adjustment', 1, 'each',
                (v_db->>'subtotal_cents')::bigint - v_sum, (v_db->>'subtotal_cents')::bigint - v_sum,
                (v_db->'lines'->0->>'taxable')::boolean);
      end if;
    end loop;

    select * into v_quote from public.quotes where id = v_quote_id;   -- totals now follow the lines (trigger)
    if v_quote.subtotal_cents <> (select sum((d->>'subtotal_cents')::bigint) from jsonb_array_elements(v_dbs) d) then
      raise exception 'quote subtotal % does not equal the priced subtotal', v_quote.subtotal_cents using errcode = 'SR001';
    end if;
    if v_eng_tot is not null and (
         v_quote.subtotal_cents <> (v_eng_tot->>'subtotal_cents')::bigint
      or v_quote.tax_cents      <> (v_eng_tot->>'tax_cents')::bigint
      or v_quote.total_cents    <> (v_eng_tot->>'total_cents')::bigint) then
      raise exception 'engine totals % do not equal the quote totals %/%/%', v_eng_tot, v_quote.subtotal_cents, v_quote.tax_cents, v_quote.total_cents using errcode = 'SR001';
    end if;

    insert into public.quote_evidence (tenant_id, quote_id, file_id, role, caption, ai_findings, ai_model, ai_confidence)
    select p_tenant, v_quote_id, sd.file_id, 'photo', sd.item_type, sd.scope, sd.ai_model, least(greatest(coalesce(sd.ai_confidence,0),0),1)
      from public.scope_drafts sd where sd.id = any(v_ids) order by sd.created_at;

    v_summary := 'Quote ' || v_quote_no || ' — ' || v_what || ' — $' || to_char(v_quote.subtotal_cents/100.0,'FM999,999,990.00')
              || ' + ' || coalesce(v_quote.tax_label,'tax') || ' = $' || to_char(v_quote.total_cents/100.0,'FM999,999,990.00')
              || case when v_first->'resolved'->>'pricing_model' = 'range' and v_first->'lines'->0->>'low_price_cents' is not null
                      then ' (your range $' || to_char((v_first->'lines'->0->>'low_price_cents')::bigint/100.0,'FM999,999,990') || '–$' || to_char((v_first->'lines'->0->>'high_price_cents')::bigint/100.0,'FM999,999,990') || ')' else '' end
              || ' — from ' || array_length(v_ids,1) || ' photo' || case when array_length(v_ids,1) = 1 then '' else 's' end
              || case when v_inside then ' — inside your rules' else ' — needs your eye: ' || coalesce(v_reasons,'outside your rules') end;

    v_approval := public.sr_request_approval(p_tenant, 'photo_to_quote', 'quote_review', v_summary,
      jsonb_build_object('priced', true, 'quote_id', v_quote_id, 'quote_no', v_quote_no, 'subtotal_cents', v_quote.subtotal_cents,
                         'tax_cents', v_quote.tax_cents, 'total_cents', v_quote.total_cents, 'inside_rules', v_inside,
                         'rules', v_rules, 'match', p_payload->'match', 'scope_draft_ids', to_jsonb(v_ids),
                         'job_id', v_job, 'contact_id', v_contact,
                         'envelope_low_cents', (v_first->'variance'->>'envelope_low_cents')::bigint,
                         'envelope_high_cents', (v_first->'variance'->>'envelope_high_cents')::bigint),
      case when v_inside then 'Inside the rules — approval is on by default' else 'Outside the rules: ' || coalesce(v_reasons,'see card') end,
      'quote', v_quote_id::text, 72);

    update public.quotes set approval_id = v_approval where id = v_quote_id;
    update public.scope_drafts set quote_id = v_quote_id, priced_at = now() where id = any(v_ids);

    perform public.sr_log(p_tenant, 'photo_to_quote', 'quote.drafted', v_summary,
      jsonb_build_object('quote_id', v_quote_id, 'quote_no', v_quote_no, 'approval_id', v_approval, 'total_cents', v_quote.total_cents,
                         'subtotal_cents', v_quote.subtotal_cents, 'inside_rules', v_inside, 'rules', v_rules,
                         'scope_draft_ids', to_jsonb(v_ids), 'engine', v_engine, 'conformance', 'identical'),
      'quote', v_quote_id::text, 'info', false, p_payload->>'ai_model', v_conf, null, 'quote_rules', v_inside);
  exception when sqlstate 'SR001' then
    -- the sub-transaction is gone; say so out loud and write nothing
    perform public.sr_log(p_tenant, 'photo_to_quote', 'pricing.drift',
      'Quote totals did not reconcile — nothing was written: ' || sqlerrm,
      jsonb_build_object('scope_draft_ids', to_jsonb(v_ids), 'engine', v_engine, 'engine_totals', v_eng_tot, 'error', sqlerrm),
      'scope_draft', v_ids[1]::text, 'error', false, null, null, null, 'engine_conformance', false);
    return jsonb_build_object('ok', false, 'reason', 'engine_drift', 'detail', sqlerrm);
  end;

  return jsonb_build_object('ok', true, 'priced', true, 'quote_id', v_quote_id, 'quote_no', v_quote_no, 'approval_id', v_approval,
                            'subtotal_cents', v_quote.subtotal_cents, 'tax_cents', v_quote.tax_cents, 'total_cents', v_quote.total_cents,
                            'inside_rules', v_inside, 'status', 'pending_approval');
end;
$function$;

-- 3 ─ the owner's decision reaches the quote ─────────────────────────────────────────────────────
create or replace function public.sr_quote_apply_decision(p_approval uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  a public.approvals%rowtype;
  q public.quotes%rowtype;
begin
  select * into a from public.approvals where id = p_approval and action_type = 'quote_review';
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_a_quote_review'); end if;
  if auth.uid() is not null and a.tenant_id not in (select public.auth_tenant_ids()) then
    raise exception 'sr_quote_apply_decision: not authorised';
  end if;
  if a.status = 'pending' then return jsonb_build_object('ok', false, 'reason', 'still_pending'); end if;
  select * into q from public.quotes where approval_id = a.id;
  if not found then return jsonb_build_object('ok', true, 'applied', false, 'reason', 'no_quote_on_this_card'); end if;
  if q.status <> 'pending_approval' then return jsonb_build_object('ok', true, 'applied', false, 'reason', 'already_' || q.status); end if;

  if a.status in ('approved', 'edited_approved') and a.edited_payload is null then
    update public.quotes set status = 'approved', approved_at = coalesce(a.decided_at, now()), approved_by = a.decided_by where id = q.id;
    perform public.sr_log(a.tenant_id, 'photo_to_quote', 'quote.approved', 'You approved quote ' || q.quote_no || ' — $' || to_char(q.total_cents/100.0,'FM999,999,990.00') || '. It is ready to send; nothing has gone to the customer yet.',
      jsonb_build_object('quote_id', q.id, 'approval_id', a.id, 'decided_by', a.decided_by), 'quote', q.id::text, 'info', false, null, null, null, 'owner_approval', true);
    return jsonb_build_object('ok', true, 'applied', true, 'status', 'approved', 'quote_no', q.quote_no);
  elsif a.status in ('approved', 'edited_approved') then
    -- the owner changed something. A changed price is a new version, never a silent overwrite.
    update public.quotes set status = 'draft', notes_internal = coalesce(notes_internal||E'\n','') || 'Owner asked for changes on approval — reprice as a new version.' where id = q.id;
    perform public.sr_log(a.tenant_id, 'photo_to_quote', 'quote.edit_requested', 'You asked for changes to quote ' || q.quote_no || ' — it is back in draft, not approved.',
      jsonb_build_object('quote_id', q.id, 'approval_id', a.id, 'edited_payload', a.edited_payload), 'quote', q.id::text, 'info', false);
    return jsonb_build_object('ok', true, 'applied', true, 'status', 'draft', 'quote_no', q.quote_no);
  elsif a.status = 'rejected' then
    update public.quotes set status = 'rejected', notes_internal = coalesce(notes_internal||E'\n','') || 'Turned down: ' || coalesce(a.decision_note,'') where id = q.id;
    perform public.sr_log(a.tenant_id, 'photo_to_quote', 'quote.rejected', 'You turned down quote ' || q.quote_no || ': ' || coalesce(a.decision_note,''),
      jsonb_build_object('quote_id', q.id, 'approval_id', a.id, 'note', a.decision_note), 'quote', q.id::text, 'info', false, null, null, null, 'owner_approval', false);
    return jsonb_build_object('ok', true, 'applied', true, 'status', 'rejected', 'quote_no', q.quote_no);
  else  -- expired / cancelled: nobody decided
    update public.quotes set status = 'draft', approval_id = null, notes_internal = coalesce(notes_internal||E'\n','') || 'Approval ' || a.status || ' with no decision.' where id = q.id;
    perform public.sr_log(a.tenant_id, 'photo_to_quote', 'quote.approval_lapsed', 'Nobody decided on quote ' || q.quote_no || ' in time — it is back in draft.',
      jsonb_build_object('quote_id', q.id, 'approval_id', a.id, 'approval_status', a.status), 'quote', q.id::text, 'warn', false);
    return jsonb_build_object('ok', true, 'applied', true, 'status', 'draft', 'quote_no', q.quote_no);
  end if;
end;
$function$;

-- 4 ─ the conformance receipt (one event per matrix run, so the console can show "last proved") ──
create or replace function public.sr_pricing_conformance_log(p_tenant uuid, p_pass integer, p_fail integer, p_detail jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is not null then raise exception 'sr_pricing_conformance_log: service role only'; end if;
  return public.sr_log(p_tenant, 'photo_to_quote', 'pricing.conformance',
    case when p_fail = 0 then 'Pricing engine proved against the database: ' || p_pass || ' of ' || p_pass || ' cases identical.'
         else 'PRICING DRIFT: ' || p_fail || ' of ' || (p_pass + p_fail) || ' cases disagree with the database. Quoting is stopped until this is fixed.' end,
    coalesce(p_detail,'{}'::jsonb) || jsonb_build_object('pass', p_pass, 'fail', p_fail),
    'pricing_engine', coalesce(p_detail->>'engine_version','?'),
    case when p_fail = 0 then 'info' else 'critical' end, true, null, null, null, 'engine_conformance', p_fail = 0);
end;
$function$;

revoke all on function public.sr_save_priced_quote(uuid, jsonb)            from public, anon, authenticated;
revoke all on function public.sr_quote_apply_decision(uuid)                from public, anon;
revoke all on function public.sr_pricing_conformance_log(uuid, integer, integer, jsonb) from public, anon, authenticated;
grant execute on function public.sr_save_priced_quote(uuid, jsonb)         to service_role;
grant execute on function public.sr_quote_apply_decision(uuid)             to authenticated, service_role;
grant execute on function public.sr_pricing_conformance_log(uuid, integer, integer, jsonb) to service_role;

-- 5 ─ console data contract: what the Owner Console reads for this machine ───────────────────────
create or replace view public.v_console_quotes with (security_invoker = true) as
select q.id as quote_id, q.tenant_id, t.is_demo, q.quote_no, q.version, q.kind, q.source, q.status,
       case q.status when 'pending_approval' then 'Waiting for you'
                     when 'approved'  then 'Approved — not sent yet'
                     when 'rejected'  then 'You turned it down'
                     when 'draft'     then 'Draft'
                     when 'sent'      then 'Sent to the customer'
                     when 'accepted'  then 'Customer accepted'
                     when 'declined'  then 'Customer declined'
                     when 'expired'   then 'Expired'
                     when 'superseded' then 'Replaced by a newer version'
                     else 'Void' end as status_plain,
       (select ql.description from public.quote_lines ql where ql.quote_id = q.id and ql.kind = 'service' order by ql.line_no limit 1) as what,
       q.subtotal_cents, q.tax_label, q.tax_cents, q.total_cents, q.currency,
       round(q.subtotal_cents * (100 - q.max_variance_pct) / 100.0)::bigint as envelope_low_cents,
       round(q.subtotal_cents * (100 + q.max_variance_pct) / 100.0)::bigint as envelope_high_cents,
       coalesce((q.variance_flags->>'inside_rules')::boolean, false) as inside_rules,
       q.variance_flags->'reasons' as rule_reasons,
       q.ai_confidence,
       (select count(*) from public.quote_evidence qe where qe.quote_id = q.id) as photos,
       q.approval_id, q.approved_at, q.approved_by, q.sent_at, q.contact_id, q.job_id, q.created_at
  from public.quotes q join public.tenants t on t.id = q.tenant_id;

create or replace view public.v_console_photo_quote with (security_invoker = true) as
select t.id as tenant_id, t.is_demo,
       (select count(*) from public.scope_drafts s where s.tenant_id = t.id and s.created_at >= now() - interval '30 days')                as photos_scoped_30d,
       (select count(*) from public.scope_drafts s where s.tenant_id = t.id and s.created_at >= now() - interval '30 days' and not coalesce(s.usable,false)) as sent_back_for_photos_30d,
       (select count(*) from public.quotes q where q.tenant_id = t.id and q.source = 'photo' and q.created_at >= now() - interval '30 days') as quotes_drafted_30d,
       (select count(*) from public.quotes q where q.tenant_id = t.id and q.source = 'photo' and q.status = 'pending_approval')             as waiting_on_you,
       (select count(*) from public.quotes q where q.tenant_id = t.id and q.source = 'photo' and q.approved_at >= now() - interval '30 days') as approved_30d,
       (select max(e.created_at) from public.events e where e.tenant_id = t.id and e.event_type = 'pricing.conformance' and e.guardrail_pass) as engine_last_proved_at,
       (select count(*) from public.events e where e.tenant_id = t.id and e.event_type = 'pricing.drift' and e.created_at >= now() - interval '30 days') as drift_refusals_30d
  from public.tenants t;

grant select on public.v_console_quotes, public.v_console_photo_quote to authenticated, service_role;
