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

const basePeriod: PlanningPeriod = { id: 'base', companyId: 'c1', label: 'Planning de base', isBase: true, startDate: null, endDate: null }
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
      const ete: PlanningPeriod = { id: 'ete', companyId: 'c1', label: 'Semaine spéciale', isBase: false, startDate: toDateStr(monday), endDate: toDateStr(friday) }

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
      const ete: PlanningPeriod = { id: 'ete', companyId: 'c1', label: 'Mi-semaine', isBase: false, startDate: toDateStr(wednesday), endDate: toDateStr(friday) }

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
})
