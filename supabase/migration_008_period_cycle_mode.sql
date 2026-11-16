-- Migration 008 — Cycle A/B vs semaine unique, par période (Prompt 13)
--
-- Permet à chaque période (base incluse) de choisir entre le cycle A/B
-- alterné (comportement historique) et une "semaine unique" (même planning
-- toutes les semaines). Implémenté par duplication invisible : en mode
-- 'single', SemaineTypePage.tsx sauvegarde la même semaine type sous A et
-- sous B - aucun changement nécessaire dans les modèles de calcul
-- (bilanCalc.ts, CalcAnnuelPage.tsx, ReplacementPage.tsx, etc.), qui
-- continuent de résoudre A/B normalement et trouvent des valeurs
-- identiques des deux côtés.
--
-- Ne pas exécuter en production avant validation en dev.

alter table planning_periods
  add column cycle_mode text not null default 'ab'
  check (cycle_mode in ('ab', 'single'));
