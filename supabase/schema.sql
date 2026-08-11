-- ============================================================
-- CADENCIA — Schéma initial
-- Toutes les heures sont stockées en MINUTES ENTIÈRES
--
-- RÉCONCILIÉ le 2026-08-11 (Prompt 1, suite à l'audit du 10/08/2026) :
-- les colonnes/table ci-dessous avaient été ajoutées directement en
-- production (SQL Editor du dashboard Supabase) sans jamais être
-- reportées dans ce fichier versionné. Vérifié en lecture seule contre
-- la base réelle avant réconciliation (Prompt 0) - aucune exécution
-- n'a été nécessaire pour ce fichier, il ne fait que rattraper la
-- documentation :
--   - companies.reference_week_date, companies.team_validated_at
--   - week_targets.sem_a_no_sixth_minutes, sem_b_no_sixth_minutes
--   - employees.color_index
--   - table replacement_slots (entière)
--   - 'leave_partial' dans le CHECK de planning_slots.slot_type
-- ============================================================

-- Extension UUID
create extension if not exists "uuid-ossp";

-- ============================================================
-- COMPANIES
-- ============================================================
create table companies (
  id                   uuid primary key default uuid_generate_v4(),
  name                 text not null,
  country              text not null default 'FR',
  sixth_week           boolean not null default false,
  reference_week_date  date,        -- semaine de reference pour le cycle A/B (RhRulesPage)
  team_validated_at    timestamptz, -- date de validation de l'equipe (AdminPage)
  created_at           timestamptz not null default now()
);

alter table companies enable row level security;

create policy "company owner access"
  on companies for all
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ============================================================
-- EMPLOYEES
-- ============================================================
create table employees (
  id                        uuid primary key default uuid_generate_v4(),
  company_id                uuid not null references companies(id) on delete cascade,
  first_name                text not null,
  last_name                 text not null,
  contract_minutes_per_week integer not null default 420,  -- 7h00 = 420 min
  formation_minutes_per_week integer not null default 0,
  leave_minutes_per_year    integer not null default 0,  -- calculé dynamiquement, conservé pour référence
  leave_weeks_per_year      integer not null default 5,
  entry_date                date not null default (date_trunc('year', now())::date),
  active                    boolean not null default true,
  sort_order                integer not null default 0,
  color_index               integer,  -- index de couleur d'affichage (AdminPage, ExportPanel)
  created_at                timestamptz not null default now()
);

alter table employees enable row level security;

create policy "company members only"
  on employees for all
  using (company_id in (select id from companies where auth.uid() = companies.id))
  with check (company_id in (select id from companies where auth.uid() = companies.id));

-- ============================================================
-- PUBLIC HOLIDAYS
-- ============================================================
create table public_holidays (
  id          uuid primary key default uuid_generate_v4(),
  company_id  uuid not null references companies(id) on delete cascade,
  date        date not null,
  name        text not null,
  year        integer not null,
  unique(company_id, date)
);

alter table public_holidays enable row level security;

create policy "company members only"
  on public_holidays for all
  using (company_id in (select id from companies where auth.uid() = companies.id))
  with check (company_id in (select id from companies where auth.uid() = companies.id));

-- ============================================================
-- WEEK TARGETS (cibles 2 semaines issues du lissage)
-- ============================================================
create table week_targets (
  id                      uuid primary key default uuid_generate_v4(),
  company_id              uuid not null references companies(id) on delete cascade,
  employee_id             uuid not null references employees(id) on delete cascade,
  year                    integer not null,
  sem_a_minutes           integer not null default 0,
  sem_b_minutes           integer not null default 0,
  sem_a_no_sixth_minutes  integer,  -- cible sans la 6e semaine (ReplacementPage)
  sem_b_no_sixth_minutes  integer,
  sixth_week_cap_min      numeric,  -- taux hebdo cotisation 6e semaine (Prompt 3, migration 003)
  updated_at              timestamptz not null default now(),
  unique(employee_id, year)
);

alter table week_targets enable row level security;

create policy "company members only"
  on week_targets for all
  using (company_id in (select id from companies where auth.uid() = companies.id))
  with check (company_id in (select id from companies where auth.uid() = companies.id));

-- ============================================================
-- SEMAINE TYPE SLOTS
-- ============================================================
create table semaine_type_slots (
  id            uuid primary key default uuid_generate_v4(),
  company_id    uuid not null references companies(id) on delete cascade,
  employee_id   uuid not null references employees(id) on delete cascade,
  week_type     char(1) not null check (week_type in ('A', 'B')),
  day_of_week   integer not null check (day_of_week between 1 and 6), -- 1=lun, 6=sam
  start_minutes integer not null,  -- minutes depuis minuit
  end_minutes   integer not null,
  break_minutes integer not null default 0,
  is_formation  boolean not null default false,
  created_at    timestamptz not null default now()
);

alter table semaine_type_slots enable row level security;

create policy "company members only"
  on semaine_type_slots for all
  using (company_id in (select id from companies where auth.uid() = companies.id))
  with check (company_id in (select id from companies where auth.uid() = companies.id));

-- ============================================================
-- PLANNING SLOTS (agenda réel)
-- ============================================================
create table planning_slots (
  id            uuid primary key default uuid_generate_v4(),
  company_id    uuid not null references companies(id) on delete cascade,
  employee_id   uuid not null references employees(id) on delete cascade,
  date          date not null,
  start_minutes integer,            -- null si congé ou férié
  end_minutes   integer,
  break_minutes integer not null default 0,
  slot_type     text not null default 'work'
                check (slot_type in ('work', 'formation', 'leave_day', 'leave_week', 'public_holiday', 'leave_partial')),
  created_at    timestamptz not null default now(),
  unique(employee_id, date, start_minutes)
);

alter table planning_slots enable row level security;

create policy "company members only"
  on planning_slots for all
  using (company_id in (select id from companies where auth.uid() = companies.id))
  with check (company_id in (select id from companies where auth.uid() = companies.id));

-- ============================================================
-- REPLACEMENT SLOTS (planning de remplacement pendant un congé)
-- Reconstruite le 2026-08-11 depuis la structure reelle en production
-- (information_schema.columns), la table n'avait jamais ete versionnee.
-- ============================================================
create table replacement_slots (
  id                    uuid primary key default uuid_generate_v4(),
  company_id            uuid not null references companies(id) on delete cascade,
  absent_employee_id    uuid not null references employees(id) on delete cascade,
  present_employee_id   uuid not null references employees(id) on delete cascade,
  day_of_week           integer not null,
  start_minutes         integer not null,
  end_minutes           integer not null,
  break_minutes         integer not null default 0,
  is_formation          boolean not null default false,
  created_at            timestamptz not null default now()
);

alter table replacement_slots enable row level security;

create policy "company members only"
  on replacement_slots for all
  using (company_id in (select id from companies where auth.uid() = companies.id))
  with check (company_id in (select id from companies where auth.uid() = companies.id));

-- ============================================================
-- ANNUAL CARRYOVER (report d'heures d'une année sur l'autre)
-- ============================================================
create table annual_carryover (
  id            uuid primary key default uuid_generate_v4(),
  company_id    uuid not null references companies(id) on delete cascade,
  employee_id   uuid not null references employees(id) on delete cascade,
  year          integer not null,
  carryover_minutes integer not null default 0,  -- positif = heures en avance, négatif = heures en retard
  carryover_leave_minutes integer not null default 0,  -- congés non pris reportés (Prompt 4, migration 004)
  unique(employee_id, year)
);

alter table annual_carryover enable row level security;

create policy "company members only"
  on annual_carryover for all
  using (company_id in (select id from companies where auth.uid() = companies.id))
  with check (company_id in (select id from companies where auth.uid() = companies.id));
