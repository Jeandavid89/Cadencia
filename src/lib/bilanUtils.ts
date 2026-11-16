import { supabase } from './supabase'
import { defaultRefMonday, getMondayOf, toDateStr } from './weekUtils'
import { effectiveWeekType } from './periods'
import { eff, computeSimplifiedBilan, slotsForDate, type LeaveSlot } from './bilanCalc'
import { loadPlanningData } from './planningData'

export async function computeSoldeLive(companyId: string): Promise<Record<string, number>> {
  const year = new Date().getFullYear()
  const from = `${year}-01-01`
  const to = `${year}-12-31`

  const [{ data: emps }, { data: hols }, planningData, { data: leaveSlots }, { data: coData }, { data: carryData }] = await Promise.all([
    // entry_date/exit_date : un employé entré en cours d'année courante a une
    // cible proratée par computeSimplifiedBilan plutôt qu'un solde faussé
    // (Prompt 12). active=true reste pertinent ici : le badge "en direct" ne
    // concerne que l'équipe actuellement en poste.
    supabase.from('employees').select('id,first_name,last_name,contract_minutes_per_week,formation_minutes_per_week,leave_weeks_per_year,entry_date,exit_date').eq('company_id', companyId).eq('active', true).order('sort_order'),
    supabase.from('public_holidays').select('date').eq('company_id', companyId).eq('year', year),
    loadPlanningData(companyId),
    supabase.from('planning_slots').select('employee_id,date,slot_type,start_minutes,end_minutes').eq('company_id', companyId).gte('date', from).lte('date', to).in('slot_type', ['leave_week', 'leave_day', 'leave_partial']),
    supabase.from('companies').select('reference_week_date').eq('id', companyId).single(),
    supabase.from('annual_carryover').select('employee_id,carryover_minutes').eq('company_id', companyId).eq('year', year - 1),
  ])

  if (!emps || emps.length === 0) return {}

  const refStr = (coData)?.reference_week_date as string | null
  const ref = refStr ? new Date(refStr + 'T00:00:00') : defaultRefMonday(year)

  const lSlots = (leaveSlots ?? []) as LeaveSlot[]
  const carryMap: Record<string, { carryover_minutes: number; carryover_leave_minutes: number }> = {}
  for (const c of (carryData ?? []) as { employee_id: string; carryover_minutes: number }[]) carryMap[c.employee_id] = { carryover_minutes: c.carryover_minutes, carryover_leave_minutes: 0 }

  const holSet = new Set(((hols ?? []) as { date: string }[]).map(h => h.date))
  const simplified = computeSimplifiedBilan({
    year, refMonday: ref, employees: emps, periodSlots: planningData.periodSlots, leaveSlots: lSlots,
    holSet, hasSixthWeek: false, capMap: {}, carryMap,
  })

  // Données semaine courante (weekSolde — équivalent de getDeviation dans PlanningPage)
  const cwMon = getMondayOf(new Date())
  const cwStart = toDateStr(cwMon)
  const cwFri = (() => { const d = new Date(cwMon); d.setDate(d.getDate() + 4); return toDateStr(d) })()
  const { data: cwSlotsData } = await supabase.from('planning_slots')
    .select('employee_id,date,start_minutes,end_minutes,break_minutes,slot_type')
    .eq('company_id', companyId)
    .gte('date', cwStart).lte('date', cwFri)
  const cwSlots = (cwSlotsData ?? []) as { employee_id: string; date: string; start_minutes: number | null; end_minutes: number | null; break_minutes: number; slot_type: string }[]
  const cwAbsentEmps = new Set<string>()
  for (const s of cwSlots.filter(s => s.slot_type === 'leave_week')) cwAbsentEmps.add(s.employee_id)

  const result: Record<string, number> = {}

  for (const emp of emps) {
    let weekSolde = 0
    if (!cwAbsentEmps.has(emp.id)) {
      const absentDays = new Set<number>()
      for (const s of cwSlots.filter(s => s.employee_id === emp.id && (s.slot_type === 'leave_day' || s.slot_type === 'public_holiday')))
        absentDays.add(new Date(s.date + 'T12:00:00').getDay())
      const absentCols = new Set(([...cwAbsentEmps]).filter(id => id !== emp.id))
      // Règle RH "Remplacement simple" : dès qu'un collègue est absent cette
      // semaine, la semaine type normale est ignorée - un jour sans créneau
      // de remplacement explicite compte 0, pas le planning normal.
      const weekHasColleagueAbsence = absentCols.size > 0
      let reference = 0
      for (let d = 1; d <= 5; d++) {
        if (absentDays.has(d)) continue
        const dayDate = new Date(cwMon); dayDate.setDate(cwMon.getDate() + (d - 1))
        const { semSlots: daySemSlots, replSlots: dayReplSlots, period: dayPeriod } = slotsForDate(planningData.periodSlots, dayDate)
        const replForDay = dayReplSlots.filter(r => r.present_employee_id === emp.id && r.day_of_week === d && !r.is_formation && absentCols.has(r.absent_employee_id))
        if (replForDay.length > 0) {
          reference += replForDay.reduce((a, r) => a + eff(r.start_minutes, r.end_minutes, r.break_minutes), 0)
        } else if (!weekHasColleagueAbsence) {
          const dayWeekType = effectiveWeekType(dayPeriod, dayDate, ref)
          reference += daySemSlots.filter(s => s.employee_id === emp.id && s.week_type === dayWeekType && s.day_of_week === d && !s.is_formation).reduce((a, s) => a + eff(s.start_minutes, s.end_minutes, s.break_minutes), 0)
        }
      }
      const actual = cwSlots.filter(s => s.employee_id === emp.id && s.slot_type === 'work' && s.start_minutes != null).reduce((a, s) => a + eff(s.start_minutes!, s.end_minutes ?? s.start_minutes!, s.break_minutes ?? 0), 0)
      weekSolde = actual - reference
    }

    result[emp.id] = simplified[emp.id].soldeHeures + weekSolde
  }

  return result
}
