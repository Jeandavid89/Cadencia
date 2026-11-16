import { describe, it, expect } from 'vitest'
import { computeSimplifiedBilan, type SemaineTypeSlot, type LeaveSlot, type PeriodSlots } from './bilanCalc'
import type { PlanningPeriod } from './periods'
import { getMondayOf, toDateStr } from './weekUtils'

// Semaine type identique en A et B (7h/j, lun-ven) pour neutraliser l'alternance
// A/B dans les assertions qui ne portent pas dessus.
function fullWeekSlots(employeeId: string): SemaineTypeSlot[] {
  const slots: SemaineTypeSlot[] = []
  for (const week_type of ['A', 'B'] as const) {
    for (let day = 1; day <= 5; day++) {
      slots.push({ employee_id: employeeId, week_type, day_of_week: day, start_minutes: 9 * 60, end_minutes: 17 * 60, break_minutes: 60, is_formation: false })
    }
  }
  return slots
}

const basePeriod: PlanningPeriod = { id: 'base', companyId: 'c1', label: 'Planning de base', isBase: true, startDate: null, endDate: null, cycleMode: 'ab' }
function onlyBase(semSlots: SemaineTypeSlot[], replSlots: PeriodSlots['replSlots'] = []): PeriodSlots[] {
  return [{ period: basePeriod, semSlots, replSlots }]
}

const employee = { id: 'e1', contract_minutes_per_week: 2100, formation_minutes_per_week: 0, leave_weeks_per_year: 5 }

describe('computeSimplifiedBilan', () => {
  it('sans congé ni remplacement, le solde correspond exactement aux 5 semaines de congé théoriques créditées', () => {
    const result = computeSimplifiedBilan({
      year: 2026,
      refMonday: getMondayOf(new Date(2026, 0, 5)),
      employees: [employee],
      periodSlots: onlyBase(fullWeekSlots('e1')),
      leaveSlots: [],
      holSet: new Set(),
      hasSixthWeek: false,
      capMap: {},
      carryMap: {},
    })
    // cible = (T - 5) * 2100 ; theoryNormal = T * 2100 (toutes les semaines sont "normales")
    // => soldeHeures = T*2100 - (T-5)*2100 = 5*2100
    expect(result.e1.soldeHeures).toBe(5 * 2100)
  })

  it('crédite un jour férié tombant sur un jour travaillé pendant une semaine de congé (non-régression)', () => {
    const leaveWeekMonday = getMondayOf(new Date(2026, 0, 5)) // lundi 5 janvier 2026
    const tuesday = new Date(leaveWeekMonday); tuesday.setDate(tuesday.getDate() + 1)
    const leaveSlots: LeaveSlot[] = [{ employee_id: 'e1', date: toDateStr(tuesday), slot_type: 'leave_week' }]

    const base = {
      year: 2026,
      refMonday: leaveWeekMonday, // la semaine de congé est donc de type A
      employees: [employee],
      periodSlots: onlyBase(fullWeekSlots('e1')),
      leaveSlots,
      hasSixthWeek: false,
      capMap: {},
      carryMap: {},
    }

    const withoutHoliday = computeSimplifiedBilan({ ...base, holSet: new Set() })
    const withHoliday = computeSimplifiedBilan({ ...base, holSet: new Set([toDateStr(tuesday)]) })

    // Mardi = 7h de semaine type (420 min) doivent être créditées en plus quand férié
    expect(withHoliday.e1.soldeHeures - withoutHoliday.e1.soldeHeures).toBe(420)
  })

  it('ne crédite rien pour un férié tombant un jour non travaillé pendant le congé', () => {
    const leaveWeekMonday = getMondayOf(new Date(2026, 0, 5))
    const saturday = new Date(leaveWeekMonday); saturday.setDate(saturday.getDate() + 5) // samedi, hors semaine type (1-5 seulement)
    const leaveSlots: LeaveSlot[] = [{ employee_id: 'e1', date: toDateStr(new Date(leaveWeekMonday.getTime() + 24 * 60 * 60 * 1000)), slot_type: 'leave_week' }]

    const base = {
      year: 2026,
      refMonday: leaveWeekMonday,
      employees: [employee],
      periodSlots: onlyBase(fullWeekSlots('e1')),
      leaveSlots,
      hasSixthWeek: false,
      capMap: {},
      carryMap: {},
    }

    const withoutHoliday = computeSimplifiedBilan({ ...base, holSet: new Set() })
    const withHoliday = computeSimplifiedBilan({ ...base, holSet: new Set([toDateStr(saturday)]) })
    expect(withHoliday.e1.soldeHeures).toBe(withoutHoliday.e1.soldeHeures)
  })

  it('calcule le droit à congé et le solde congés à partir d\'une semaine de congé posée', () => {
    const leaveWeekMonday = getMondayOf(new Date(2026, 0, 5))
    const leaveSlots: LeaveSlot[] = [{ employee_id: 'e1', date: toDateStr(leaveWeekMonday), slot_type: 'leave_week' }]
    const result = computeSimplifiedBilan({
      year: 2026,
      refMonday: leaveWeekMonday,
      employees: [employee],
      periodSlots: onlyBase(fullWeekSlots('e1')),
      leaveSlots,
      holSet: new Set(),
      hasSixthWeek: false,
      capMap: {},
      carryMap: {},
    })
    expect(result.e1.droitConge).toBe(2100 * 5) // effectiveContract * leave_weeks_per_year
    expect(result.e1.leaveMin).toBe(2100) // une semaine complète décomptée (pas de cap)
    expect(result.e1.soldeConges).toBe(2100 * 5 - 2100)
  })

  it('un remplacement partiel (un seul jour de la semaine) ne fait pas perdre le crédit normal des autres jours NON concernés par une absence (non-régression du bug weekIsRepl)', () => {
    // e2 absente la semaine du 5 janvier 2026 ; e1 la remplace le LUNDI
    // seulement. Mardi-vendredi, e1 n'a NI remplacement NI absence de
    // collègue : elle travaille normalement. Seule la semaine de e2 doit
    // être affectée par la règle "semaine type ignorée" (cf. test suivant).
    const weekMonday = getMondayOf(new Date(2026, 0, 5))
    const employee2 = { id: 'e2', contract_minutes_per_week: 2100, formation_minutes_per_week: 0, leave_weeks_per_year: 5 }
    const leaveSlots: LeaveSlot[] = [{ employee_id: 'e2', date: toDateStr(weekMonday), slot_type: 'leave_week' }]
    const replSlots: PeriodSlots['replSlots'] = [
      { absent_employee_id: 'e2', present_employee_id: 'e1', day_of_week: 1, start_minutes: 9 * 60, end_minutes: 17 * 60, break_minutes: 60, is_formation: false },
    ]

    const result = computeSimplifiedBilan({
      year: 2026,
      refMonday: weekMonday,
      employees: [employee, employee2],
      periodSlots: onlyBase(fullWeekSlots('e1'), replSlots),
      leaveSlots,
      holSet: new Set(),
      hasSixthWeek: false,
      capMap: {},
      carryMap: {},
    })
    // 51 semaines normales (2100 min) + 1 semaine de e2 où seul le lundi
    // compte (420 min de remplacement, mar-ven à 0 car "semaine type
    // ignorée cette semaine-là" - règle RH "Remplacement simple") :
    // cible = (52-5)*2100 = 94500 ; théorie = 51*2100 + 420 = 107520
    expect(result.e1.soldeHeures).toBe(51 * 2100 + 420 - (52 - 5) * 2100)
  })

  it('règle RH "Remplacement simple" : un jour sans créneau de remplacement explicite compte 0, pas la semaine type (non-régression)', () => {
    // e2 absente toute la semaine du 5 janvier 2026 ; e1 ne la remplace
    // AUCUN jour (aucun replSlot). D'après la règle documentée ("la
    // semaine type normale est ignorée cette semaine-là"), e1 doit avoir 0
    // minute créditée cette semaine-là, pas sa semaine type habituelle.
    const weekMonday = getMondayOf(new Date(2026, 0, 5))
    const employee2 = { id: 'e2', contract_minutes_per_week: 2100, formation_minutes_per_week: 0, leave_weeks_per_year: 5 }
    const leaveSlots: LeaveSlot[] = [{ employee_id: 'e2', date: toDateStr(weekMonday), slot_type: 'leave_week' }]

    const result = computeSimplifiedBilan({
      year: 2026,
      refMonday: weekMonday,
      employees: [employee, employee2],
      periodSlots: onlyBase(fullWeekSlots('e1'), []), // aucun remplacement défini
      leaveSlots,
      holSet: new Set(),
      hasSixthWeek: false,
      capMap: {},
      carryMap: {},
    })
    // 51 semaines normales (2100 min) + 0 pour la semaine de e2
    expect(result.e1.soldeHeures).toBe(51 * 2100 - (52 - 5) * 2100)
  })

  it('applique le report N-1 (heures et congés)', () => {
    const result = computeSimplifiedBilan({
      year: 2026,
      refMonday: getMondayOf(new Date(2026, 0, 5)),
      employees: [employee],
      periodSlots: onlyBase(fullWeekSlots('e1')),
      leaveSlots: [],
      holSet: new Set(),
      hasSixthWeek: false,
      capMap: {},
      carryMap: { e1: { carryover_minutes: 300, carryover_leave_minutes: 120 } },
    })
    expect(result.e1.soldeHeures).toBe(5 * 2100 + 300)
    expect(result.e1.droitConge).toBe(2100 * 5 + 120)
  })

  describe('résolution par période (Prompt 9)', () => {
    it('une période couvrant exactement une semaine civile avec une semaine type différente ne change que cette semaine-là', () => {
      const ref = getMondayOf(new Date(2026, 0, 5))
      const monday = getMondayOf(new Date(2026, 2, 2)) // lundi 2 mars 2026
      const friday = new Date(monday); friday.setDate(friday.getDate() + 4)
      const ete: PlanningPeriod = { id: 'ete', companyId: 'c1', label: 'Semaine spéciale', isBase: false, startDate: toDateStr(monday), endDate: toDateStr(friday), cycleMode: 'ab' }

      // Pendant la période : seulement 3h/jour au lieu de 7h/jour
      const periodSemSlots: SemaineTypeSlot[] = ['A', 'B'].flatMap(week_type =>
        Array.from({ length: 5 }, (_, i) => ({ employee_id: 'e1', week_type: week_type as 'A' | 'B', day_of_week: i + 1, start_minutes: 9 * 60, end_minutes: 12 * 60, break_minutes: 0, is_formation: false }))
      )

      const periodSlots: PeriodSlots[] = [
        { period: basePeriod, semSlots: fullWeekSlots('e1'), replSlots: [] },
        { period: ete, semSlots: periodSemSlots, replSlots: [] },
      ]

      const withPeriod = computeSimplifiedBilan({
        year: 2026, refMonday: ref, employees: [employee], periodSlots, leaveSlots: [],
        holSet: new Set(), hasSixthWeek: false, capMap: {}, carryMap: {},
      })
      const withoutPeriod = computeSimplifiedBilan({
        year: 2026, refMonday: ref, employees: [employee], periodSlots: onlyBase(fullWeekSlots('e1')), leaveSlots: [],
        holSet: new Set(), hasSixthWeek: false, capMap: {}, carryMap: {},
      })

      // 5 jours * (7h - 3h) = 20h = 1200 min de moins uniquement sur cette semaine
      expect(withoutPeriod.e1.soldeHeures - withPeriod.e1.soldeHeures).toBe(1200)
    })

    it('une période démarrant un mercredi : lundi/mardi utilisent la base, mercredi-vendredi la période', () => {
      const ref = getMondayOf(new Date(2026, 0, 5))
      const monday = getMondayOf(new Date(2026, 2, 2)) // lundi 2 mars 2026
      const wednesday = new Date(monday); wednesday.setDate(wednesday.getDate() + 2)
      const friday = new Date(monday); friday.setDate(friday.getDate() + 4)
      const ete: PlanningPeriod = { id: 'ete', companyId: 'c1', label: 'Mi-semaine', isBase: false, startDate: toDateStr(wednesday), endDate: toDateStr(friday), cycleMode: 'ab' }

      // Pendant la période : 0h/jour (rien du tout) pour isoler son effet
      const periodSemSlots: SemaineTypeSlot[] = []

      const periodSlots: PeriodSlots[] = [
        { period: basePeriod, semSlots: fullWeekSlots('e1'), replSlots: [] },
        { period: ete, semSlots: periodSemSlots, replSlots: [] },
      ]

      const withPeriod = computeSimplifiedBilan({
        year: 2026, refMonday: ref, employees: [employee], periodSlots, leaveSlots: [],
        holSet: new Set(), hasSixthWeek: false, capMap: {}, carryMap: {},
      })
      const withoutPeriod = computeSimplifiedBilan({
        year: 2026, refMonday: ref, employees: [employee], periodSlots: onlyBase(fullWeekSlots('e1')), leaveSlots: [],
        holSet: new Set(), hasSixthWeek: false, capMap: {}, carryMap: {},
      })

      // Seuls mercredi/jeudi/vendredi (3 jours * 7h = 21h = 1260 min) sont perdus ;
      // lundi/mardi restent crédités via la base.
      expect(withoutPeriod.e1.soldeHeures - withPeriod.e1.soldeHeures).toBe(1260)
    })
  })

  describe('entry_date / exit_date (Prompt 12)', () => {
    it('un employé entré en cours d\'année a une cible réduite et aucune contribution avant son entrée', () => {
      const ref = getMondayOf(new Date(2026, 0, 5))
      const entryDate = toDateStr(getMondayOf(new Date(2026, 8, 1))) // 1er septembre 2026 (mardi -> lundi de sa semaine)
      const empMidYear = { ...employee, entry_date: entryDate, exit_date: null }

      const resultFull = computeSimplifiedBilan({
        year: 2026, refMonday: ref, employees: [employee], periodSlots: onlyBase(fullWeekSlots('e1')), leaveSlots: [],
        holSet: new Set(), hasSixthWeek: false, capMap: {}, carryMap: {},
      })
      const resultMidYear = computeSimplifiedBilan({
        year: 2026, refMonday: ref, employees: [empMidYear], periodSlots: onlyBase(fullWeekSlots('e1')), leaveSlots: [],
        holSet: new Set(), hasSixthWeek: false, capMap: {}, carryMap: {},
      })

      // La cible de l'employé entré en septembre doit être strictement inférieure
      // (moins de semaines comptées), et son solde reflète uniquement les semaines
      // depuis son entrée (toujours exactement 5 semaines de congé créditées au-dessus
      // de la cible, puisqu'aucun congé n'est posé dans ce test).
      expect(resultMidYear.e1.cible).toBeLessThan(resultFull.e1.cible)
      expect(resultMidYear.e1.soldeHeures).toBe(5 * 2100)
    })

    it('un employé sorti en cours d\'année n\'est plus crédité après sa sortie, mais reste crédité avant', () => {
      const ref = getMondayOf(new Date(2026, 0, 5))
      const exitDate = toDateStr(new Date(getMondayOf(new Date(2026, 5, 1)).getTime() - 3 * 86400000)) // vendredi fin mai
      const empLeftMidYear = { ...employee, entry_date: null, exit_date: exitDate }

      const result = computeSimplifiedBilan({
        year: 2026, refMonday: ref, employees: [empLeftMidYear], periodSlots: onlyBase(fullWeekSlots('e1')), leaveSlots: [],
        holSet: new Set(), hasSixthWeek: false, capMap: {}, carryMap: {},
      })
      const resultFull = computeSimplifiedBilan({
        year: 2026, refMonday: ref, employees: [employee], periodSlots: onlyBase(fullWeekSlots('e1')), leaveSlots: [],
        holSet: new Set(), hasSixthWeek: false, capMap: {}, carryMap: {},
      })

      // Moins de semaines employées => cible plus faible, mais toujours un
      // employé "présent" dans le calcul (pas d'exception, pas de disparition) -
      // non-régression du bug où un employé sorti disparaissait silencieusement.
      expect(result.e1.cible).toBeLessThan(resultFull.e1.cible)
      expect(result.e1.soldeHeures).toBe(5 * 2100)
    })

    it('un employé rejoignant l\'équipe pendant une période datée : intersection correcte emploi × période', () => {
      const ref = getMondayOf(new Date(2026, 0, 5))
      const periodStart = getMondayOf(new Date(2026, 2, 2)) // lundi 2 mars 2026
      const periodEnd = new Date(periodStart); periodEnd.setDate(periodEnd.getDate() + 4)
      const ete: PlanningPeriod = { id: 'ete', companyId: 'c1', label: 'Période test', isBase: false, startDate: toDateStr(periodStart), endDate: toDateStr(periodEnd), cycleMode: 'ab' }
      // Entré le mercredi de cette même semaine de période
      const entryDate = toDateStr(new Date(periodStart.getTime() + 2 * 86400000))
      const empJoinsMidPeriod = { ...employee, entry_date: entryDate, exit_date: null }

      const periodSlots: PeriodSlots[] = [
        { period: basePeriod, semSlots: fullWeekSlots('e1'), replSlots: [] },
        { period: ete, semSlots: fullWeekSlots('e1'), replSlots: [] },
      ]

      const result = computeSimplifiedBilan({
        year: 2026, refMonday: ref, employees: [empJoinsMidPeriod], periodSlots, leaveSlots: [],
        holSet: new Set(), hasSixthWeek: false, capMap: {}, carryMap: {},
      })
      const resultFull = computeSimplifiedBilan({
        year: 2026, refMonday: ref, employees: [employee], periodSlots, leaveSlots: [],
        holSet: new Set(), hasSixthWeek: false, capMap: {}, carryMap: {},
      })

      // La semaine à cheval (entrée un mercredi) n'est pas une semaine complète :
      // elle ne compte dans la cible de personne (règle "semaines complètes").
      expect(result.e1.cible).toBeLessThan(resultFull.e1.cible)
    })
  })
})
