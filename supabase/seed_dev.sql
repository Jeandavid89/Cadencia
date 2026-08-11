-- Donnees de developpement (Prompt 6). A executer UNIQUEMENT sur le
-- projet Supabase de DEV, jamais sur la production.
--
-- Prerequis : un compte a deja ete cree via l'ecran d'inscription de
-- l'app (pointee sur .env.development) - la ligne `companies` est creee
-- automatiquement a l'inscription (src/stores/authStore.ts::signUp,
-- id = auth.uid()). Ce script suppose qu'une seule entreprise existe
-- dans la base (cas normal d'un projet dev fraichement cree) et s'y
-- rattache sans avoir besoin de connaitre son UUID a l'avance.
--
-- Ajoute : 3 employes, un jour ferie, une semaine type (A) minimale pour
-- chacun, un conge d'une journee pour un employe. Rejouable sans doublon
-- grace aux contraintes unique existantes (delete les employes de test
-- au prealable si tu relances apres modification).

do $$
declare
  v_company_id uuid;
  v_emp1 uuid; v_emp2 uuid; v_emp3 uuid;
  v_year int := extract(year from now())::int;
begin
  select id into v_company_id from companies order by created_at limit 1;
  if v_company_id is null then
    raise exception 'Aucune entreprise trouvee. Inscris-toi via l''app (pointee sur .env.development) avant de lancer ce script.';
  end if;

  insert into employees (company_id, first_name, last_name, contract_minutes_per_week, formation_minutes_per_week, leave_weeks_per_year, sort_order)
  values
    (v_company_id, 'Alice', 'Dupont', 2100, 0, 5, 1),
    (v_company_id, 'Bruno', 'Martin', 2100, 60, 5, 2),
    (v_company_id, 'Chloe', 'Bernard', 1260, 0, 5, 3);

  select id into v_emp1 from employees where company_id = v_company_id and first_name = 'Alice';
  select id into v_emp2 from employees where company_id = v_company_id and first_name = 'Bruno';
  select id into v_emp3 from employees where company_id = v_company_id and first_name = 'Chloe';

  -- Semaine type A minimale : lun-ven 9h-17h (pause 60min) pour Alice et Bruno,
  -- lun/mar/jeu/ven pour Chloe (temps partiel 21h/sem)
  insert into semaine_type_slots (company_id, employee_id, week_type, day_of_week, start_minutes, end_minutes, break_minutes)
  select v_company_id, v_emp1, 'A', d, 9*60, 17*60, 60 from generate_series(1,5) d
  union all
  select v_company_id, v_emp2, 'A', d, 9*60, 17*60, 60 from generate_series(1,5) d
  union all
  select v_company_id, v_emp3, 'A', d, 9*60, 17*60, 60 from unnest(array[1,2,4,5]) d;

  -- Jour ferie de test (1er mai de l'annee en cours)
  insert into public_holidays (company_id, date, name, year)
  values (v_company_id, make_date(v_year, 5, 1), 'Fete du travail', v_year)
  on conflict (company_id, date) do nothing;

  -- Un conge d'une journee pour Alice, un lundi dans ~2 semaines.
  -- start_minutes est NULL pour un conge : la contrainte UNIQUE ne
  -- deduplique pas les NULL (chaque NULL est distinct en SQL), donc
  -- ON CONFLICT ne suffit pas ici - verification explicite a la place.
  insert into planning_slots (company_id, employee_id, date, slot_type)
  select v_company_id, v_emp1, (date_trunc('week', now()) + interval '14 days')::date, 'leave_day'
  where not exists (
    select 1 from planning_slots
    where employee_id = v_emp1
      and date = (date_trunc('week', now()) + interval '14 days')::date
      and slot_type = 'leave_day'
  );

  raise notice 'Seed termine : 3 employes, 1 jour ferie, 1 conge, semaines types A ajoutees pour company_id=%', v_company_id;
end $$;
