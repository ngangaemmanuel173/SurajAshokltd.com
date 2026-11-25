/*
  Tyres now come from the Tyre Records app (table tyre_records).
  The fleet app reads them through two views, so nothing is typed in twice:

    tyres_live     one row per tyre, current state (status, truck, position, cost)
    tyre_costs_v   one row per cost (purchase, retread, repair), dated, per truck

  Safe to run more than once. The old tyres_v2 / tyre_history tables are left untouched
  but the fleet app no longer reads them.
*/

-- 1. Tyre Records tables (skipped if they already exist in this project)
create table if not exists public.tyre_staff (email text primary key);
create table if not exists public.tyre_records (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
alter table public.tyre_staff enable row level security;
alter table public.tyre_records enable row level security;

drop policy if exists "own staff row" on public.tyre_staff;
create policy "own staff row" on public.tyre_staff
  for select to authenticated
  using (lower(email) = lower(auth.jwt() ->> 'email'));

-- Only people in tyre_staff can add or change tyres (the person doing tyres)
drop policy if exists "staff only" on public.tyre_records;
create policy "staff only" on public.tyre_records
  for all to authenticated
  using (lower(auth.jwt() ->> 'email') in (select lower(email) from public.tyre_staff))
  with check (lower(auth.jwt() ->> 'email') in (select lower(email) from public.tyre_staff));

-- Everyone with a fleet login can READ tyres (Spares, Sales & Reports, managers, admin)
drop policy if exists "fleet users read tyres" on public.tyre_records;
create policy "fleet users read tyres" on public.tyre_records
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid()));

do $$
begin
  alter publication supabase_realtime add table public.tyre_records;
exception when duplicate_object then null;
end $$;

-- 2. Safe converters (the tyre app stores everything as text)
create or replace function public.tyre_num(t text) returns numeric
language sql immutable as $$ select case when t ~ '^\s*\d+(\.\d+)?\s*$' then t::numeric end $$;

create or replace function public.tyre_date(t text) returns date
language sql immutable as $$ select case when t ~ '^\d{4}-\d{2}-\d{2}$' then t::date end $$;

create or replace function public.tyre_plate_key(t text) returns text
language sql immutable as $$ select upper(regexp_replace(coalesce(t, ''), '\s', '', 'g')) $$;

-- 3. Current state of every tyre
create or replace view public.tyres_live with (security_invoker = true) as
select
  r.id,
  r.data->>'serial'                                   as serial_number,
  r.data->>'brand'                                    as brand,
  r.data->>'size'                                     as size,
  case when r.data->>'type' = 'Retread' then 'rebound' else 'new' end as tyre_type,
  s.status,
  r.data->>'supplier'                                 as supplier,
  r.data->>'invoice'                                  as invoice_number,
  public.tyre_date(r.data->>'received')               as date_in,
  public.tyre_date(r.data->>'received')               as purchase_date,
  public.tyre_num(r.data->>'cost')                    as unit_cost,
  case when s.status = 'fitted' then v.id end         as current_truck_id,
  case when s.status = 'fitted' then s.plate end      as plate_number,
  case when s.status = 'fitted' then s.pos end        as position,
  case when s.status = 'fitted' then s.d end          as fitted_date,
  s.rebounds                                          as rebound_count,
  s.last_action,
  s.d                                                 as last_action_date,
  coalesce(v.sub_account, 'master')                   as sub_account
from public.tyre_records r
cross join lateral (
  select
    case
      when q.lm is null then 'in_store'
      when q.lm->>'type' = 'fit' then 'fitted'
      when q.lm->>'type' = 'ret' then 'in_store'
      when q.lm->>'dest' = 'Sent for retread' then 'at_rebound'
      when q.lm->>'dest' in ('Scrapped', 'Sold') then 'disposed'
      else 'in_store'
    end as status,
    q.lm->>'plate' as plate,
    q.lm->>'pos'   as pos,
    public.tyre_date(q.lm->>'date') as d,
    (select count(*)::int from jsonb_array_elements(coalesce(r.data->'moves', '[]'::jsonb)) x
      where x->>'type' = 'ret') as rebounds,
    case
      when q.lm is null then null
      when q.lm->>'type' = 'fit' then 'Fitted'
      when q.lm->>'type' = 'ret' then 'Returned from retread'
      else 'Removed to ' || coalesce(q.lm->>'dest', '')
    end as last_action
  from (select (r.data->'moves') -> (-1) as lm) q
) s
left join lateral (
  select v2.id, v2.sub_account
  from public.vehicles v2
  where coalesce(s.plate, '') <> ''
    and public.tyre_plate_key(v2.plate_number) = public.tyre_plate_key(s.plate)
  limit 1
) v on true;

-- 4. Every cost, with its date and the truck it belongs to
--    Purchase  : counted on the date the tyre is first fitted, to that truck
--    Retread / repair : counted on their own date, to the truck the tyre was on then
create or replace view public.tyre_costs_v with (security_invoker = true) as
with base as (
  select r.id, r.data->>'serial' as serial, r.data->>'brand' as brand, r.data,
         coalesce(r.data->'moves', '[]'::jsonb) as moves
  from public.tyre_records r
),
fits as (
  select b.id, public.tyre_date(m->>'date') as d, m->>'plate' as plate
  from base b, jsonb_array_elements(b.moves) m
  where m->>'type' = 'fit' and public.tyre_date(m->>'date') is not null
),
lines as (
  (select distinct on (f.id)
          f.id || ':purchase' as line_id, f.id as tyre_id, 'Purchase'::text as cost_type,
          f.d as line_date, f.plate as plate, public.tyre_num(b.data->>'cost') as amount
   from fits f join base b on b.id = f.id
   order by f.id, f.d)
  union all
  select b.id || ':retread:' || x.n, b.id, 'Retread', public.tyre_date(x.m->>'date'),
         null::text, public.tyre_num(x.m->>'cost')
  from base b, jsonb_array_elements(b.moves) with ordinality as x(m, n)
  where x.m->>'type' = 'ret'
  union all
  select b.id || ':event:' || x.n, b.id, 'Repair / event', public.tyre_date(x.m->>'date'),
         null::text, public.tyre_num(x.m->>'cost')
  from base b, jsonb_array_elements(coalesce(b.data->'events', '[]'::jsonb)) with ordinality as x(m, n)
)
select
  l.line_id                      as id,
  l.tyre_id,
  b.serial                       as serial_number,
  b.brand,
  l.cost_type,
  l.amount                       as unit_cost,
  l.line_date                    as fitted_date,
  v.id                           as current_truck_id,
  coalesce(v.sub_account, 'master') as sub_account
from lines l
join base b on b.id = l.tyre_id
left join lateral (
  select f.plate from fits f where f.id = l.tyre_id and f.d <= l.line_date order by f.d desc limit 1
) lf on true
left join lateral (
  select v2.id, v2.sub_account from public.vehicles v2
  where public.tyre_plate_key(v2.plate_number) = public.tyre_plate_key(coalesce(l.plate, lf.plate))
  limit 1
) v on true
where l.amount > 0 and l.line_date is not null and v.id is not null;

grant select on public.tyres_live, public.tyre_costs_v to authenticated;
