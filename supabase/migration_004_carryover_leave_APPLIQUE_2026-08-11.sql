-- APPLIQUE le 2026-08-11 par Jd via le SQL Editor du dashboard Supabase,
-- verifie en lecture (information_schema.columns). Reportee dans schema.sql.
-- Prompt 4 (cloture annuelle). Decision Jd : le report concerne les
-- heures ET les conges non pris - deux notions distinctes (unites
-- differentes, semantique differente), donc deux colonnes separees.
-- annual_carryover.carryover_minutes existait deja (heures, inchange).
alter table annual_carryover
  add column if not exists carryover_leave_minutes integer not null default 0;
