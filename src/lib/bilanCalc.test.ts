import { describe, it, expect } from 'vitest'
import { computeSimplifiedBilan, type SemaineTypeSlot, type LeaveSlot } from './bilanCalc'
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

const employee = { id: 'e1', contract_minutes_per_week: 2100, formation_minutes_per_week: 0, leave_weeks_per_year: 5 }

describe('computeSimplifiedBilan', () => {
  it('sans congé ni remplacement, le solde correspond exactement aux 5 semaines de congé théoriques créditées', () => {
    const result = computeSimplifiedBilan({
      year: 2026,
      refMonday: getMondayOf(new Date(2026, 0, 5)),
      employees: [employee],
      semSlots: fullWeekSlots('e1'),
      leaveSlots: [],
      replSlots: [],
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
      semSlots: fullWeekSlots('e1'),
      leaveSlots,
      replSlots: [],
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
      semSlots: fullWeekSlots('e1'),
      leaveSlots,
      replSlots: [],
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
      semSlots: fullWeekSlots('e1'),
      leaveSlots,
      replSlots: [],
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
      semSlots: fullWeekSlots('e1'),
      leaveSlots: [],
      replSlots: [],
      holSet: new Set(),
      hasSixthWeek: false,
      capMap: {},
      carryMap: { e1: { carryover_minutes: 300, carryover_leave_minutes: 120 } },
    })
    expect(result.e1.soldeHeures).toBe(5 * 2100 + 300)
    expect(result.e1.droitConge).toBe(2100 * 5 + 120)
  })
})
