import { supabase } from './supabase'
import { defaultRefMonday } from './weekUtils'
import { effectiveWeekType } from './periods'
import { slotsForDate } from './bilanCalc'
import { loadPlanningData } from './planningData'

/**
 * Régénère le planning réel (work/formation) pour des couples
 * (employé, date) donnés - à appeler après la suppression d'un congé, pour
 * ne pas laisser ces jours vides (bug découvert en QA : supprimer un congé
 * semaine effaçait les créneaux de l'absente ET de ses remplaçantes sans
 * jamais remettre leur planning normal).
 *
 * Résolution jour par jour, cohérente avec SemaineTypePage::project() et
 * les modèles de calcul : remplacement si un collègue est encore absent ce
 * jour-là et explicitement couvert, sinon la semaine type normale
 * (effectiveWeekType, période active à cette date), sinon 0h si un
 * collègue est absent sans couverture explicite (règle RH "Remplacement
 * simple"). Les jours fériés ne sont jamais touchés.
 */
export async function regenerateNormalSchedule(
  companyId: string,
  employeeDates: { employeeId: string; date: string }[]
): Promise<void> {
  const uniqueKeys = [...new Set(employeeDates.map(ed => `${ed.employeeId}|${ed.date}`))]
  if (uniqueKeys.length === 0) return
  const uniqueEmployeeDates = uniqueKeys.map(k => { const [employeeId, date] = k.split('|'); return { employeeId, date } })

  const dates = uniqueEmployeeDates.map(ed => ed.date)
  const minDate = dates.reduce((a, b) => (a < b ? a : b))
  const maxDate = dates.reduce((a, b) => (a > b ? a : b))
  const year = Number(minDate.slice(0, 4))

  const [planningData, { data: hols }, { data: co }, { data: leaveData }] = await Promise.all([
    loadPlanningData(companyId),
    supabase.from('public_holidays').select('date').eq('company_id', companyId).eq('year', year),
    supabase.from('companies').select('reference_week_date').eq('id', companyId).single(),
    supabase.from('planning_slots').select('employee_id,date')
      .eq('company_id', companyId).gte('date', minDate).lte('date', maxDate)
      .in('slot_type', ['leave_week', 'leave_day']),
  ])
  const holSet = new Set(((hols ?? []) as { date: string }[]).map(h => h.date))
  const refStr = (co)?.reference_week_date as string | null
  const refMonday = refStr ? new Date(refStr + 'T00:00:00') : defaultRefMonday(year)
  const leaveSet = new Set((leaveData ?? []).map((s: { employee_id: string; date: string }) => `${s.employee_id}|${s.date}`))

  const rows: Record<string, unknown>[] = []
  for (const { employeeId, date } of uniqueEmployeeDates) {
    if (holSet.has(date)) continue
    if (leaveSet.has(`${employeeId}|${date}`)) continue // encore en congé : rien à générer
    const dayDate = new Date(date + 'T12:00:00')
    const jsDay = dayDate.getDay()
    if (jsDay < 1 || jsDay > 5) continue

    const { semSlots, replSlots, period } = slotsForDate(planningData.periodSlots, dayDate)
    const weekType = effectiveWeekType(period, dayDate, refMonday)
    const absentColleagues = [...leaveSet]
      .filter(k => k.endsWith(`|${date}`) && !k.startsWith(`${employeeId}|`))
      .map(k => k.slice(0, k.lastIndexOf('|')))

    const dayRepl = replSlots.filter(r => r.present_employee_id === employeeId && r.day_of_week === jsDay && absentColleagues.includes(r.absent_employee_id))
    if (dayRepl.length > 0) {
      for (const r of dayRepl) {
        rows.push({ company_id: companyId, employee_id: employeeId, date, start_minutes: r.start_minutes, end_minutes: r.end_minutes, break_minutes: r.break_minutes, slot_type: r.is_formation ? 'formation' : 'work' })
      }
    } else if (absentColleagues.length === 0) {
      for (const s of semSlots.filter(ss => ss.employee_id === employeeId && ss.week_type === weekType && ss.day_of_week === jsDay)) {
        rows.push({ company_id: companyId, employee_id: employeeId, date, start_minutes: s.start_minutes, end_minutes: s.end_minutes, break_minutes: s.break_minutes, slot_type: s.is_formation ? 'formation' : 'work' })
      }
    }
    // sinon : collègue absent ce jour-là sans créneau de remplacement explicite -> 0h.
  }

  for (const { employeeId, date } of uniqueEmployeeDates) {
    await supabase.from('planning_slots').delete()
      .eq('company_id', companyId).eq('employee_id', employeeId).eq('date', date)
      .in('slot_type', ['work', 'formation'])
  }
  if (rows.length > 0) {
    await supabase.from('planning_slots').insert(rows)
  }
}
