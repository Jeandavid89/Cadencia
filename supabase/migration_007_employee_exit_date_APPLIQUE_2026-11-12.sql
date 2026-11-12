-- Migration 007 — Date de sortie des employés (Prompt 12)
--
-- Corrige un bug découvert pendant l'audit : employees.entry_date existe
-- mais n'était lu nulle part dans les calculs, et un employé désactivé
-- (active=false) disparaissait silencieusement des calculs de TOUTES les
-- années passées déjà consultées, pas seulement de l'année en cours.
--
-- Cette migration ajoute exit_date (nullable = toujours en poste). Le code
-- applicatif (CalcAnnuelPage, computeSoldeLive) est adapté séparément pour
-- n'inclure une semaine dans la cible d'un employé que si elle tombe
-- entièrement dans sa fenêtre d'emploi [entry_date, exit_date] (semaines
-- complètes uniquement, pas de prorata infra-semaine).
--
-- Ne pas exécuter en production avant validation en dev.

alter table employees add column exit_date date;

alter table employees add constraint employees_exit_after_entry
  check (exit_date is null or exit_date >= entry_date);

create index employees_entry_exit_idx on employees(company_id, entry_date, exit_date);
