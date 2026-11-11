-- Migration 005 — Périodes de planning (Prompt 7+8)
--
-- Introduit la notion de "période de planning" : une semaine type et des
-- remplacements peuvent désormais être versionnés par plage de dates dans
-- l'année, plutôt qu'être uniques et globaux pour tout le cabinet. Chaque
-- cabinet reçoit automatiquement une période "de base" (perpétuelle,
-- is_base=true) à laquelle toutes les données existantes sont rattachées :
-- AUCUN changement de comportement tant qu'aucune période datée n'est créée.
--
-- Ne pas exécuter en production avant validation en dev. À appliquer dans
-- l'ordre : dev d'abord, vérifier, puis prod.

-- Nécessaire pour la contrainte d'exclusion anti-chevauchement (opérateur "="
-- sur uuid utilisable dans un index GiST).
create extension if not exists "btree_gist";

-- ============================================================
-- PLANNING PERIODS
-- ============================================================
create table planning_periods (
  id          uuid primary key default uuid_generate_v4(),
  company_id  uuid not null references companies(id) on delete cascade,
  label       text not null,
  is_base     boolean not null default false,
  start_date  date,
  end_date    date,
  created_at  timestamptz not null default now(),
  constraint planning_periods_base_dates_null
    check (is_base = (start_date is null and end_date is null)),
  constraint planning_periods_dates_order
    check (start_date is null or end_date is null or start_date <= end_date),
  constraint planning_periods_single_year
    check (start_date is null or extract(year from start_date) = extract(year from end_date))
);

-- une seule période "de base" par cabinet
create unique index planning_periods_one_base_idx
  on planning_periods(company_id) where is_base;

-- Interdiction de chevauchement au niveau Postgres, bornes incluses des deux
-- côtés : une période finissant le 13/09 et une autre commençant le 13/09
-- sont considérées comme chevauchantes (pas de jour partagé possible). La
-- période de base (dates NULL) est hors contrainte via le WHERE.
alter table planning_periods
  add constraint planning_periods_no_overlap
  exclude using gist (company_id with =, daterange(start_date, end_date, '[]') with &&)
  where (not is_base);

alter table planning_periods enable row level security;

create policy "company members only"
  on planning_periods for all
  using (company_id in (select id from companies where auth.uid() = companies.id))
  with check (company_id in (select id from companies where auth.uid() = companies.id));

-- Garde-fou "année déjà clôturée" au niveau DB (filet de sécurité en plus du
-- contrôle côté UI) : impossible de créer/déplacer une période datée vers
-- une année où annual_carryover contient déjà des lignes pour ce cabinet.
create or replace function planning_periods_guard_closed_year() returns trigger as $$
begin
  if new.start_date is not null and exists (
    select 1 from annual_carryover
    where company_id = new.company_id and year = extract(year from new.start_date)::int
  ) then
    raise exception 'planning_period_year_closed';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger planning_periods_guard_closed_year_trg
  before insert or update on planning_periods
  for each row execute function planning_periods_guard_closed_year();

-- Auto-création de la période de base pour tout nouveau cabinet (évite une
-- logique applicative fragile de type "créer si absent" à chaque chargement).
create or replace function create_base_planning_period() returns trigger as $$
begin
  insert into planning_periods (company_id, label, is_base) values (new.id, 'Planning de base', true);
  return new;
end;
$$ language plpgsql;

create trigger companies_create_base_period_trg
  after insert on companies
  for each row execute function create_base_planning_period();

-- Période de base pour les cabinets DÉJÀ existants (le trigger ci-dessus ne
-- joue que pour les futurs inserts sur companies).
insert into planning_periods (company_id, label, is_base)
select id, 'Planning de base', true from companies;

-- ============================================================
-- SEMAINE_TYPE_SLOTS — rattachement à une période
-- ============================================================
alter table semaine_type_slots add column period_id uuid references planning_periods(id) on delete cascade;

update semaine_type_slots s set period_id = p.id
  from planning_periods p where p.company_id = s.company_id and p.is_base;

alter table semaine_type_slots alter column period_id set not null;

create index semaine_type_slots_period_idx on semaine_type_slots(period_id);

-- ============================================================
-- REPLACEMENT_SLOTS — rattachement à une période
-- ============================================================
alter table replacement_slots add column period_id uuid references planning_periods(id) on delete cascade;

update replacement_slots s set period_id = p.id
  from planning_periods p where p.company_id = s.company_id and p.is_base;

alter table replacement_slots alter column period_id set not null;

create index replacement_slots_period_idx on replacement_slots(period_id);
