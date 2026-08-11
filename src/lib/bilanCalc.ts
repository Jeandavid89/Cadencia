import { getWeekType, getMondayOf, toDateStr, getYearWeekMondays } from './weekUtils'

export const eff = (s: number, e: number, b: number) => Math.max(0, e - s - b)

export interface SimplifiedEmployee {
  id: string
  contract_minutes_per_week: number
  formation_minutes_per_week: number
  leave_weeks_per_year: number
}
export interface SemaineTypeSlot {
  employee_id: string; week_type: 'A' | 'B'; day_of_week: number
  start_minutes: number; end_minutes: number; break_minutes: number; is_formation: boolean
}
export interface LeaveSlot {
  employee_id: string; date: string; slot_type: string
  start_minutes?: number | null; end_minutes?: number | null
}
export interface ReplacementSlot {
  absent_employee_id: string; present_employee_id: string
  day_of_week: number; start_minutes: number; end_minutes: number
  break_minutes: number; is_formation: boolean
}
export interface SimplifiedBilanInput {
  year: number
  refMonday: Date
  employees: SimplifiedEmployee[]
  semSlots: SemaineTypeSlot[]
  leaveSlots: LeaveSlot[]
  replSlots: ReplacementSlot[]
  holSet: Set<string>
  hasSixthWeek: boolean
  capMap: Record<string, number>
  carryMap: Record<string, { carryover_minutes: number; carryover_leave_minutes: number }>
}
export interface SimplifiedBilanRow {
  cible: number
  soldeHeures: number
  droitConge: number
  leaveMin: number
  soldeConges: number
}

/**
 * Modèle "simplifié" (semaine par semaine, semaine type × nombre de semaines)
 * partagé par computeSoldeLive (badge live) et PlanningPage::loadBilan
 * (mini-bilan). Distinct du modèle détaillé jour par jour de
 * CalcAnnuelPage::load, qui reste la référence pour la clôture annuelle.
 *
 * Un jour férié tombant sur un jour normalement travaillé pendant une
 * semaine de congé est crédité (assimilé travaillé) - même règle que le
 * modèle détaillé.
 */
export function computeSimplifiedBilan(input: SimplifiedBilanInput): Record<string, SimplifiedBilanRow> {
  const { year, refMonday, employees, semSlots, leaveSlots, replSlots, holSet, hasSixthWeek, capMap, carryMap } = input
  const weekMondays = getYearWeekMondays(year)
  const T = weekMondays.length

  const absentWeeksByEmp: Record<string, Set<string>> = {}
  for (const emp of employees) absentWeeksByEmp[emp.id] = new Set()
  for (const ls of leaveSlots.filter(s => s.slot_type === 'leave_week'))
    absentWeeksByEmp[ls.employee_id]?.add(toDateStr(getMondayOf(new Date(ls.date + 'T12:00:00'))))

  const result: Record<string, SimplifiedBilanRow> = {}

  for (const emp of employees) {
    const effectiveContract = emp.contract_minutes_per_week - emp.formation_minutes_per_week
    const effectiveLeave = emp.leave_weeks_per_year
    const cible = (T - effectiveLeave) * effectiveContract

    const empLeaveSlots = leaveSlots.filter(s => s.employee_id === emp.id)
    const absentWeekMondays = absentWeeksByEmp[emp.id]
    const leaveDayDates = new Set(empLeaveSlots.filter(s => s.slot_type === 'leave_day').map(s => s.date))

    const semATotal = semSlots.filter(s => s.employee_id === emp.id && s.week_type === 'A' && !s.is_formation).reduce((a, s) => a + eff(s.start_minutes, s.end_minutes, s.break_minutes), 0)
    const semBTotal = semSlots.filter(s => s.employee_id === emp.id && s.week_type === 'B' && !s.is_formation).reduce((a, s) => a + eff(s.start_minutes, s.end_minutes, s.break_minutes), 0)

    let normalWeeksCountA = 0, normalWeeksCountB = 0
    let holidayCreditMin = 0
    const replByAbsent: Record<string, number> = {}

    for (const weekMon of weekMondays) {
      const monKey = toDateStr(weekMon)
      const weekType = getWeekType(weekMon, refMonday)
      const isLeaveWeek = absentWeekMondays.has(monKey)

      if (isLeaveWeek) {
        // Jour férié tombant un jour normalement travaillé pendant le congé : assimilé travaillé.
        for (let offset = 0; offset <= 4; offset++) {
          const day = new Date(weekMon); day.setDate(weekMon.getDate() + offset)
          if (!holSet.has(toDateStr(day))) continue
          const jsDay = day.getDay()
          holidayCreditMin += semSlots
            .filter(s => s.employee_id === emp.id && s.week_type === weekType && s.day_of_week === jsDay && !s.is_formation)
            .reduce((a, s) => a + eff(s.start_minutes, s.end_minutes, s.break_minutes), 0)
        }
        continue
      }

      const absentColleagues = employees.filter(o => o.id !== emp.id && absentWeeksByEmp[o.id]?.has(monKey))
      let weekIsRepl = false
      for (let offset = 0; offset <= 4; offset++) {
        const day = new Date(weekMon); day.setDate(weekMon.getDate() + offset)
        const ds = toDateStr(day); const jsDay = day.getDay()
        if (leaveDayDates.has(ds)) continue
        const dayRepl = replSlots.filter(r => r.present_employee_id === emp.id && r.day_of_week === jsDay && absentColleagues.some(a => a.id === r.absent_employee_id))
        if (dayRepl.length > 0) {
          weekIsRepl = true
          for (const r of dayRepl) {
            if (!r.is_formation) replByAbsent[r.absent_employee_id] = (replByAbsent[r.absent_employee_id] ?? 0) + eff(r.start_minutes, r.end_minutes, r.break_minutes)
          }
        }
      }
      if (!weekIsRepl) { if (weekType === 'A') normalWeeksCountA++; else normalWeeksCountB++ }
    }

    const theoryNormal = normalWeeksCountA * semATotal + normalWeeksCountB * semBTotal + holidayCreditMin
    const totalRepl = Object.values(replByAbsent).reduce((a, v) => a + v, 0)
    const carry = carryMap[emp.id]
    const soldeHeures = theoryNormal + totalRepl - cible + (carry?.carryover_minutes ?? 0)

    // Congés payés : décompte basé sur semaine type − cap
    const cap = capMap[emp.id] ?? 0
    const weekTypeTotalFn = (wt: 'A' | 'B') =>
      semSlots.filter(s => s.employee_id === emp.id && s.week_type === wt && !s.is_formation)
        .reduce((a, s) => a + eff(s.start_minutes, s.end_minutes, s.break_minutes), 0)

    let leaveMin = 0
    const processedMondays = new Set<string>()
    for (const ls of empLeaveSlots.filter(s => s.slot_type === 'leave_week')) {
      const d = new Date(ls.date + 'T12:00:00')
      const monKey = toDateStr(getMondayOf(d))
      if (processedMondays.has(monKey)) continue
      processedMondays.add(monKey)
      const wt = getWeekType(d, refMonday)
      leaveMin += Math.round(Math.max(0, weekTypeTotalFn(wt) - cap))
    }
    for (const ls of empLeaveSlots.filter(s => s.slot_type === 'leave_day')) {
      if (holSet.has(ls.date)) continue
      const d = new Date(ls.date + 'T12:00:00')
      const jsDay = d.getDay()
      if (jsDay < 1 || jsDay > 5) continue
      const wt = getWeekType(d, refMonday)
      const dayMin = semSlots.filter(s => s.employee_id === emp.id && s.week_type === wt && s.day_of_week === jsDay && !s.is_formation)
        .reduce((a, s) => a + eff(s.start_minutes, s.end_minutes, s.break_minutes), 0)
      const total = weekTypeTotalFn(wt)
      const k = total > 0 ? (total - cap) / total : 1
      leaveMin += Math.round(dayMin * k)
    }
    for (const ls of empLeaveSlots.filter(s => s.slot_type === 'leave_partial')) {
      if (ls.start_minutes == null || ls.end_minutes == null) continue
      leaveMin += Math.max(0, ls.end_minutes - ls.start_minutes)
    }

    const sixthWkMin = hasSixthWeek ? effectiveContract : 0
    const droitConge = effectiveContract * effectiveLeave + sixthWkMin + (carry?.carryover_leave_minutes ?? 0)
    const soldeConges = droitConge - leaveMin

    result[emp.id] = { cible, soldeHeures, droitConge, leaveMin, soldeConges }
  }

  return result
}
