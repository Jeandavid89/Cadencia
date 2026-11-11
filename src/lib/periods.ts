import { toDateStr, getWeekType } from './weekUtils'

export interface PlanningPeriod {
  id: string
  companyId: string
  label: string
  isBase: boolean
  startDate: string | null  // 'YYYY-MM-DD', null seulement si isBase
  endDate: string | null
}

/**
 * Retourne la période active à cette date : la période datée qui la couvre
 * (bornes incluses), ou la période de base (is_base=true) si aucune ne la
 * couvre. `periods` doit toujours contenir exactement une entrée isBase=true
 * (garanti par le trigger DB companies_create_base_period_trg) ; si ce n'est
 * pas le cas (ex. données de test incomplètes), lève une erreur explicite
 * plutôt que de retourner silencieusement undefined.
 */
export function resolveActivePeriod(periods: PlanningPeriod[], date: Date): PlanningPeriod {
  const ds = toDateStr(date)
  const dated = periods.find(p => !p.isBase && p.startDate !== null && p.endDate !== null && p.startDate <= ds && ds <= p.endDate)
  if (dated) return dated
  const base = periods.find(p => p.isBase)
  if (!base) throw new Error('resolveActivePeriod: aucune période de base trouvée')
  return base
}

/**
 * Détecte si `candidate` chevauche une période datée existante (bornes
 * incluses des deux côtés - adjacence exacte, ex. 01/06-30/06 suivi de
 * 01/07-31/07, n'est PAS un chevauchement). Permet d'afficher un message
 * clair côté UI avant d'atteindre la contrainte d'exclusion Postgres.
 * `excludeId` permet d'éditer une période existante sans qu'elle se bloque
 * elle-même.
 */
export function findOverlappingPeriod(
  periods: PlanningPeriod[],
  candidate: { startDate: string; endDate: string; excludeId?: string }
): PlanningPeriod | null {
  for (const p of periods) {
    if (p.isBase) continue
    if (candidate.excludeId && p.id === candidate.excludeId) continue
    if (p.startDate === null || p.endDate === null) continue
    const overlaps = candidate.startDate <= p.endDate && p.startDate <= candidate.endDate
    if (overlaps) return p
  }
  return null
}

/**
 * Parmi des lundis déjà calculés par getYearWeekMondays(year), compte ceux
 * dont la période active (résolue via resolveActivePeriod) est `periodId`,
 * ventilés par type de semaine A/B. Utilisé pour segmenter le lissage par
 * période (ReplacementPage::compute).
 */
export function countPeriodWeeks(
  mondays: Date[],
  periods: PlanningPeriod[],
  periodId: string,
  refMonday: Date
): { nA: number; nB: number; total: number } {
  let nA = 0, nB = 0
  for (const mon of mondays) {
    const active = resolveActivePeriod(periods, mon)
    if (active.id !== periodId) continue
    if (getWeekType(mon, refMonday) === 'A') nA++
    else nB++
  }
  return { nA, nB, total: nA + nB }
}
