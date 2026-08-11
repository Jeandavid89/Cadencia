import { supabase } from './supabase'
import { getWeekType, defaultRefMonday, getMondayOf, toDateStr } from './weekUtils'
import { eff, computeSimplifiedBilan, type SemaineTypeSlot, type LeaveSlot, type ReplacementSlot } from './bilanCalc'

export async function computeSoldeLive(companyId: string): Promise<Record<string, number>> {
  const year = new Date().getFullYear()
  const from = `${year}-01-01`
  const to = `${year}-12-31`

  const [{ data: emps }, { data: hols }, { data: stSlots }, { data: leaveSlots }, { data: replSlotsData }, { data: coData }, { data: carryData }] = await Promise.all([
    supabase.from('employees').select('id,first_name,last_name,contract_minutes_per_week,formation_minutes_per_week,leave_weeks_per_year').eq('company_id', companyId).eq('active', true).order('sort_order'),
    supabase.from('public_holidays').select('date').eq('company_id', companyId).eq('year', year),
    supabase.from('semaine_type_slots').select('employee_id,week_type,day_of_week,start_minutes,end_minutes,break_minutes,is_formation').eq('company_id', companyId),
    supabase.from('planning_slots').select('employee_id,date,slot_type,start_minutes,end_minutes').eq('company_id', companyId).gte('date', from).lte('date', to).in('slot_type', ['leave_week', 'leave_day', 'leave_partial']),
    supabase.from('replacement_slots').select('absent_employee_id,present_employee_id,day_of_week,start_minutes,end_minutes,break_minutes,is_formation').eq('company_id', companyId),
    supabase.from('companies').select('reference_week_date').eq('id', companyId).single(),
    supabase.from('annual_carryover').select('employee_id,carryover_minutes').eq('company_id', companyId).eq('year', year - 1),
  ])

  if (!emps || emps.length === 0) return {}

  const refStr = (coData)?.reference_week_date as string | null
  const ref = refStr ? new Date(refStr + 'T00:00:00') : defaultRefMonday(year)

  const semSlots = (stSlots ?? []) as SemaineTypeSlot[]
  const lSlots = (leaveSlots ?? []) as LeaveSlot[]
  const rSlots = (replSlotsData ?? []) as ReplacementSlot[]
  const carryMap: Record<string, { carryover_minutes: number; carryover_leave_minutes: number }> = {}
  for (const c of (carryData ?? []) as { employee_id: string; carryover_minutes: number }[]) carryMap[c.employee_id] = { carryover_minutes: c.carryover_minutes, carryover_leave_minutes: 0 }

  const holSet = new Set(((hols ?? []) as { date: string }[]).map(h => h.date))
  const simplified = computeSimplifiedBilan({
    year, refMonday: ref, employees: emps, semSlots, leaveSlots: lSlots, replSlots: rSlots,
    holSet, hasSixthWeek: false, capMap: {}, carryMap,
  })

  // Données semaine courante (weekSolde — équivalent de getDeviation dans PlanningPage)
  const cwMon = getMondayOf(new Date())
  const cwWeekType = getWeekType(cwMon, ref)
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
      let reference = 0
      for (let d = 1; d <= 5; d++) {
        if (absentDays.has(d)) continue
        const dayRef = semSlots.filter(s => s.employee_id === emp.id && s.week_type === cwWeekType && s.day_of_week === d && !s.is_formation).reduce((a, s) => a + eff(s.start_minutes, s.end_minutes, s.break_minutes), 0)
        const replForDay = rSlots.filter(r => r.present_employee_id === emp.id && r.day_of_week === d && !r.is_formation && absentCols.has(r.absent_employee_id))
        reference += replForDay.length > 0 ? replForDay.reduce((a, r) => a + eff(r.start_minutes, r.end_minutes, r.break_minutes), 0) : dayRef
      }
      const actual = cwSlots.filter(s => s.employee_id === emp.id && s.slot_type === 'work' && s.start_minutes != null).reduce((a, s) => a + eff(s.start_minutes!, s.end_minutes ?? s.start_minutes!, s.break_minutes ?? 0), 0)
      weekSolde = actual - reference
    }

    result[emp.id] = simplified[emp.id].soldeHeures + weekSolde
  }

  return result
}
