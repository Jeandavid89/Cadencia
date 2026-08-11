-- APPLIQUE le 2026-08-11 par Jd via le SQL Editor du dashboard Supabase,
-- verifie en lecture (information_schema.columns). Reportee dans
-- schema.sql. Prompt 3 (double-stockage du lissage) - nouvelle colonne,
-- contrairement aux ecarts du Prompt 1 (Cas A) qui existaient deja.
--
-- Stocke le taux hebdomadaire de cotisation a la 6e semaine
-- (sixthWkMin / normalWeeks, calcule dans ReplacementPage.tsx::compute()),
-- utilise par CalcAnnuelPage/CongesPage/SemaineTypePage/PlanningPage pour
-- ne pas decompter cette part lors du calcul des conges pris. Aujourd'hui
-- cette valeur ne vit qu'en localStorage (cle lissage_<companyId>) -> mauvais
-- resultat sur un autre appareil/navigateur tant que le lissage n'y a pas
-- ete recalcule. Numeric (pas integer) car c'est un ratio fractionnaire,
-- pas une duree en minutes entieres.
alter table week_targets
  add column if not exists sixth_week_cap_min numeric;
