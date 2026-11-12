-- Migration 006 — week_targets multi-périodes (Prompt 10)
--
-- Jusqu'ici, week_targets ne pouvait avoir qu'une seule ligne par employé et
-- par année (contrainte unique(employee_id, year)), ce qui empêchait de
-- stocker un lissage différent par période de planning. Cette migration
-- rattache chaque ligne existante à la période de base (aucune perte de
-- donnée, comportement inchangé) puis remplace la contrainte par
-- unique(employee_id, year, period_id).
--
-- Prérequis : migration_005_planning_periods.sql déjà appliquée (table
-- planning_periods existante). Ne pas exécuter en production avant
-- validation en dev.

alter table week_targets add column period_id uuid references planning_periods(id) on delete cascade;

update week_targets w set period_id = p.id
  from planning_periods p where p.company_id = w.company_id and p.is_base;

alter table week_targets alter column period_id set not null;

-- Le nom par défaut donné par Postgres à une contrainte unique(employee_id, year)
-- déclarée inline est "<table>_<col1>_<col2>_key". Vérifier avant d'exécuter si
-- un doute existe :
--   select conname from pg_constraint where conrelid = 'week_targets'::regclass and contype = 'u';
alter table week_targets drop constraint week_targets_employee_id_year_key;
alter table week_targets add constraint week_targets_employee_year_period_key unique (employee_id, year, period_id);

create index week_targets_period_idx on week_targets(period_id);
