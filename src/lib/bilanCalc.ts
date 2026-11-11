import { getWeekType, getMondayOf, toDateStr, getYearWeekMondays } from './weekUtils'
import { resolveActivePeriod, type PlanningPeriod } from './periods'

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
export interface PeriodSlots {
  period: PlanningPeriod
  semSlots: SemaineTypeSlot[]
  replSlots: ReplacementSlot[]
}
export interface SimplifiedBilanInput {
  year: number
  refMonday: Date
  employees: SimplifiedEmployee[]
  periodSlots: PeriodSlots[]
  leaveSlots: LeaveSlot[]
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
 * Résout, pour une date donnée, le jeu de semaine type + remplacements de la
 * période active à cette date (la période datée qui la couvre, ou la période
 * de base sinon - cf. resolveActivePeriod). Permet à une même semaine civile
 * d'utiliser des slots différents selon le jour, quand une période commence
 * ou finit un jour autre que lundi.
 */
export function slotsForDate(periodSlots: PeriodSlots[], date: Date): { semSlots: SemaineTypeSlot[]; replSlots: ReplacementSlot[] } {
  const periods = periodSlots.map(ps => ps.period)
  const active = resolveActivePeriod(periods, date)
  const found = periodSlots.find(ps => ps.period.id === active.id)
  return found ? { semSlots: found.semSlots, replSlots: found.replSlots } : { semSlots: [], replSlots: [] }
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
 *
 * Résolution par période (Prompt 9) : la semaine type et les remplacements
 * sont résolus jour par jour via slotsForDate, pas une seule fois pour toute
 * l'année - une période peut démarrer/finir n'importe quel jour de la
 * semaine, pas seulement un lundi.
 */
export function computeSimplifiedBilan(input: SimplifiedBilanInput): Record<string, SimplifiedBilanRow> {
  const { year, refMonday, employees, periodSlots, leaveSlots, holSet, hasSixthWeek, capMap, carryMap } = input
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

    let theoryNormal = 0
    const replByAbsent: Record<string, number> = {}

    for (const weekMon of weekMondays) {
      const monKey = toDateStr(weekMon)
      const isLeaveWeek = absentWeekMondays.has(monKey)

      if (isLeaveWeek) {
        // Jour férié tombant un jour normalement travaillé pendant le congé : assimilé travaillé.
        for (let offset = 0; offset <= 4; offset++) {
          const day = new Date(weekMon); day.setDate(weekMon.getDate() + offset)
          if (!holSet.has(toDateStr(day))) continue
          const jsDay = day.getDay()
          const weekType = getWeekType(day, refMonday)
          const { semSlots } = slotsForDate(periodSlots, day)
          theoryNormal += semSlots
            .filter(s => s.employee_id === emp.id && s.week_type === weekType && s.day_of_week === jsDay && !s.is_formation)
            .reduce((a, s) => a + eff(s.start_minutes, s.end_minutes, s.break_minutes), 0)
        }
        continue
      }

      const absentColleagues = employees.filter(o => o.id !== emp.id && absentWeeksByEmp[o.id]?.has(monKey))

      // Passe 1 : cette semaine contient-elle un jour de remplacement ?
      let weekIsRepl = false
      for (let offset = 0; offset <= 4; offset++) {
        const day = new Date(weekMon); day.setDate(weekMon.getDate() + offset)
        const ds = toDateStr(day); const jsDay = day.getDay()
        if (leaveDayDates.has(ds)) continue
        const { replSlots } = slotsForDate(periodSlots, day)
        const dayRepl = replSlots.filter(r => r.present_employee_id === emp.id && r.day_of_week === jsDay && absentColleagues.some(a => a.id === r.absent_employee_id))
        if (dayRepl.length > 0) {
          weekIsRepl = true
          for (const r of dayRepl) {
            if (!r.is_formation) replByAbsent[r.absent_employee_id] = (replByAbsent[r.absent_employee_id] ?? 0) + eff(r.start_minutes, r.end_minutes, r.break_minutes)
          }
        }
      }

      // Passe 2 : si aucun remplacement cette semaine, créditer la semaine
      // type jour par jour (résolue par période, potentiellement différente
      // d'un jour à l'autre si la semaine est à cheval entre deux périodes).
      if (!weekIsRepl) {
        for (let offset = 0; offset <= 4; offset++) {
          const day = new Date(weekMon); day.setDate(weekMon.getDate() + offset)
          const jsDay = day.getDay()
          const weekType = getWeekType(day, refMonday)
          const { semSlots } = slotsForDate(periodSlots, day)
          theoryNormal += semSlots
            .filter(s => s.employee_id === emp.id && s.week_type === weekType && s.day_of_week === jsDay && !s.is_formation)
            .reduce((a, s) => a + eff(s.start_minutes, s.end_minutes, s.break_minutes), 0)
        }
      }
    }

    const totalRepl = Object.values(replByAbsent).reduce((a, v) => a + v, 0)
    const carry = carryMap[emp.id]
    const soldeHeures = theoryNormal + totalRepl - cible + (carry?.carryover_minutes ?? 0)

    // Congés payés : décompte basé sur semaine type − cap, résolu par la
    // période active à la date du congé.
    const cap = capMap[emp.id] ?? 0
    const weekTypeTotalForDate = (date: Date, wt: 'A' | 'B') =>
      slotsForDate(periodSlots, date).semSlots
        .filter(s => s.employee_id === emp.id && s.week_type === wt && !s.is_formation)
        .reduce((a, s) => a + eff(s.start_minutes, s.end_minutes, s.break_minutes), 0)

    let leaveMin = 0
    const processedMondays = new Set<string>()
    for (const ls of empLeaveSlots.filter(s => s.slot_type === 'leave_week')) {
      const d = new Date(ls.date + 'T12:00:00')
      const monKey = toDateStr(getMondayOf(d))
      if (processedMondays.has(monKey)) continue
      processedMondays.add(monKey)
      const wt = getWeekType(d, refMonday)
      leaveMin += Math.round(Math.max(0, weekTypeTotalForDate(d, wt) - cap))
    }
    for (const ls of empLeaveSlots.filter(s => s.slot_type === 'leave_day')) {
      if (holSet.has(ls.date)) continue
      const d = new Date(ls.date + 'T12:00:00')
      const jsDay = d.getDay()
      if (jsDay < 1 || jsDay > 5) continue
      const wt = getWeekType(d, refMonday)
      const { semSlots } = slotsForDate(periodSlots, d)
      const dayMin = semSlots.filter(s => s.employee_id === emp.id && s.week_type === wt && s.day_of_week === jsDay && !s.is_formation)
        .reduce((a, s) => a + eff(s.start_minutes, s.end_minutes, s.break_minutes), 0)
      const total = weekTypeTotalForDate(d, wt)
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
