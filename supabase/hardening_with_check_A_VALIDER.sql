-- NE PAS EXECUTER SANS VALIDATION EXPLICITE.
-- Ajoute des clauses WITH CHECK identiques aux clauses USING existantes,
-- sur les 8 policies "for all" du projet (point d'hygiene 17 de l'audit
-- du 10/08/2026). Comportement actuel deja sur, PostgreSQL utilise USING
-- comme garde-fou implicite pour INSERT/UPDATE en l'absence de WITH CHECK
-- - ce script rend cette protection explicite plutot que de dependre
-- d'un comportement implicite.
--
-- Sans danger fonctionnel attendu (le comportement ne change pas), mais
-- reste une modification de policies RLS EN PRODUCTION : a executer
-- uniquement apres validation, une table a la fois si prudence maximale
-- souhaitee, dans le SQL Editor du dashboard Supabase.

alter policy "company owner access" on companies
  with check (auth.uid() = id);

alter policy "company members only" on employees
  with check (company_id in (select id from companies where auth.uid() = companies.id));

alter policy "company members only" on public_holidays
  with check (company_id in (select id from companies where auth.uid() = companies.id));

alter policy "company members only" on week_targets
  with check (company_id in (select id from companies where auth.uid() = companies.id));

alter policy "company members only" on semaine_type_slots
  with check (company_id in (select id from companies where auth.uid() = companies.id));

alter policy "company members only" on planning_slots
  with check (company_id in (select id from companies where auth.uid() = companies.id));

alter policy "company members only" on replacement_slots
  with check (company_id in (select id from companies where auth.uid() = companies.id));

alter policy "company members only" on annual_carryover
  with check (company_id in (select id from companies where auth.uid() = companies.id));
