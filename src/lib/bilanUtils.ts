import { supabase } from './supabase'
import { getWeekType, defaultRefMonday, getMondayOf } from './weekUtils'

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const eff = (s: number, e: number, b: number) => Math.max(0, e - s - b)

export async function computeSoldeLive(companyId: string): Promise<Record<string, number>> {
  const year = new Date().getFullYear()
  const from = `${year}-01-01`
  const to = `${year}-12-31`

  const [{ data: emps }, { data: stSlots }, { data: leaveSlots }, { data: replSlotsData }, { data: coData }] = await Promise.all([
    supabase.from('employees').select('id,first_name,last_name,contract_minutes_per_week,formation_minutes_per_week,leave_weeks_per_year').eq('company_id', companyId).eq('active', true).order('sort_order'),
    supabase.from('semaine_type_slots').select('employee_id,week_type,day_of_week,start_minutes,end_minutes,break_minutes,is_formation').eq('company_id', companyId),
    supabase.from('planning_slots').select('employee_id,date,slot_type,start_minutes,end_minutes').eq('company_id', companyId).gte('date', from).lte('date', to).in('slot_type', ['leave_week', 'leave_day', 'leave_partial']),
    supabase.from('replacement_slots').select('absent_employee_id,present_employee_id,day_of_week,start_minutes,end_minutes,break_minutes,is_formation').eq('company_id', companyId),
    supabase.from('companies').select('reference_week_date').eq('id', companyId).single(),
  ])

  if (!emps || emps.length === 0) return {}

  const refStr = (coData as any)?.reference_week_date as string | null
  const ref = refStr ? new Date(refStr + 'T00:00:00') : defaultRefMonday(year)

  const semSlots = (stSlots ?? []) as { employee_id: string; week_type: 'A' | 'B'; day_of_week: number; start_minutes: number; end_minutes: number; break_minutes: number; is_formation: boolean }[]
  const lSlots = (leaveSlots ?? []) as { employee_id: string; date: string; slot_type: string; start_minutes?: number | null; end_minutes?: number | null }[]
  const rSlots = (replSlotsData ?? []) as { absent_employee_id: string; present_employee_id: string; day_of_week: number; start_minutes: number; end_minutes: number; break_minutes: number; is_formation: boolean }[]

  // Semaines de l'année
  const weekMondays: Date[] = []
  {
    const seen = new Set<number>()
    const d = new Date(from + 'T00:00:00')
    const end = new Date(to + 'T00:00:00')
    while (d <= end) {
      const dow = d.getDay()
      if (dow >= 1 && dow <= 5) {
        const mon = getMondayOf(new Date(d))
        if (!seen.has(mon.getTime())) { seen.add(mon.getTime()); weekMondays.push(new Date(mon)) }
      }
      d.setDate(d.getDate() + 1)
    }
  }
  const T = weekMondays.length

  // Semaines d'absence par employé
  const absentWeeksByEmp: Record<string, Set<string>> = {}
  for (const emp of emps as any[]) absentWeeksByEmp[emp.id] = new Set()
  for (const ls of lSlots.filter(s => s.slot_type === 'leave_week'))
    absentWeeksByEmp[ls.employee_id]?.add(toDateStr(getMondayOf(new Date(ls.date + 'T12:00:00'))))

  // Données semaine courante (pour weekSolde — équivalent de getDeviation dans PlanningPage)
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

  for (const emp of emps as any[]) {
    const effectiveContract = emp.contract_minutes_per_week - emp.formation_minutes_per_week
    const cible = (T - emp.leave_weeks_per_year) * effectiveContract

    const semATotal = semSlots.filter(s => s.employee_id === emp.id && s.week_type === 'A' && !s.is_formation).reduce((a, s) => a + eff(s.start_minutes, s.end_minutes, s.break_minutes), 0)
    const semBTotal = semSlots.filter(s => s.employee_id === emp.id && s.week_type === 'B' && !s.is_formation).reduce((a, s) => a + eff(s.start_minutes, s.end_minutes, s.break_minutes), 0)

    const absentWeekMondays = absentWeeksByEmp[emp.id]
    const leaveDayDates = new Set(lSlots.filter(s => s.employee_id === emp.id && s.slot_type === 'leave_day').map(s => s.date))

    let normalWeeksCountA = 0, normalWeeksCountB = 0
    const replByAbsent: Record<string, number> = {}

    for (const weekMon of weekMondays) {
      const monKey = toDateStr(weekMon)
      const weekType = getWeekType(weekMon, ref)
      if (absentWeekMondays.has(monKey)) continue
      const absentColleagues = (emps as any[]).filter((o: any) => o.id !== emp.id && absentWeeksByEmp[o.id]?.has(monKey))
      let weekIsRepl = false
      for (let offset = 0; offset <= 4; offset++) {
        const day = new Date(weekMon); day.setDate(weekMon.getDate() + offset)
        const ds = toDateStr(day); const jsDay = day.getDay()
        if (leaveDayDates.has(ds)) continue
        const dayRepl = rSlots.filter(r => r.present_employee_id === emp.id && r.day_of_week === jsDay && !r.is_formation && absentColleagues.some((a: any) => a.id === r.absent_employee_id))
        if (dayRepl.length > 0) {
          weekIsRepl = true
          for (const r of dayRepl) replByAbsent[r.absent_employee_id] = (replByAbsent[r.absent_employee_id] ?? 0) + eff(r.start_minutes, r.end_minutes, r.break_minutes)
        }
      }
      if (!weekIsRepl) { if (weekType === 'A') normalWeeksCountA++; else normalWeeksCountB++ }
    }

    const theoryNormal = normalWeeksCountA * semATotal + normalWeeksCountB * semBTotal
    const totalRepl = Object.values(replByAbsent).reduce((a, v) => a + v, 0)
    const soldeHeures = theoryNormal + totalRepl - cible

    // weekSolde : même logique que getDeviation() dans PlanningPage
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

    result[emp.id] = soldeHeures + weekSolde
  }

  return result
}
