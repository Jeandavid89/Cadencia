import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import { fmtMinutes } from '../types'
import { getWeekType, defaultRefMonday } from '../lib/weekUtils'
import { loadPlanningData } from '../lib/planningData'
import { regenerateNormalSchedule } from '../lib/scheduleGen'
import { slotsForDate, type PeriodSlots } from '../lib/bilanCalc'
import { effectiveWeekType } from '../lib/periods'
import { useRefetchOnFocus } from '../lib/useRefetchOnFocus'

interface Employee {
  id: string; first_name: string; last_name: string
  contract_minutes_per_week: number; formation_minutes_per_week: number
  leave_weeks_per_year: number; color_index?: number
}
interface SemaineTypeSlot {
  employee_id: string; week_type: 'A' | 'B'; day_of_week: number
  start_minutes: number; end_minutes: number; break_minutes: number; is_formation: boolean
}
interface LeaveSlot {
  id: string; employee_id: string; date: string
  slot_type: 'leave_day' | 'leave_week' | 'leave_partial'
  start_minutes?: number | null; end_minutes?: number | null
}
interface PublicHoliday { date: string }
interface LeaveEntry {
  key: string; type: 'week' | 'day' | 'partial'
  isoWeek: number; weekType: 'A' | 'B'; dates: string[]
  label: string; dateRange: string; totalMin: number
  slotId?: string; startMin?: number; endMin?: number
  holidayMin?: number
}

const EMP_COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#0ea5e9']
const MONTHS_FR = ['jan.','fév.','mar.','avr.','mai','juin','juil.','août','sep.','oct.','nov.','déc.']
const DAYS_SHORT = ['','Lun','Mar','Mer','Jeu','Ven','Sam','Dim']

function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const ys = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d.getTime() - ys.getTime()) / 86400000) + 1) / 7)
}
function getMondayOf(d: Date): Date {
  const day = d.getDay() || 7
  const mon = new Date(d); mon.setDate(d.getDate() - (day - 1)); return mon
}
function toStr(d: Date): string { return d.toISOString().split('T')[0] }
function fmtShort(d: Date): string { return `${d.getDate()} ${MONTHS_FR[d.getMonth()]}` }
function fmtDayFull(d: Date): string {
  const jsDay = d.getDay() || 7
  return `${DAYS_SHORT[jsDay]} ${d.getDate()} ${MONTHS_FR[d.getMonth()]}`
}
const fullName = (e: Employee) => `${e.first_name} ${e.last_name}`.trim() || 'Sans nom'
const stEff = (s: SemaineTypeSlot) => Math.max(0, s.end_minutes - s.start_minutes - s.break_minutes)

export default function CongesPage() {
  const { user } = useAuthStore()
  const companyId = user?.id ?? ''
  const navigate = useNavigate()

  const [year, setYear] = useState(new Date().getFullYear())
  const [employees, setEmployees] = useState<Employee[]>([])
  const [leaveSlots, setLeaveSlots] = useState<LeaveSlot[]>([])
  const [periodSlots, setPeriodSlots] = useState<PeriodSlots[]>([])
  const [holidays, setHolidays] = useState<PublicHoliday[]>([])
  const [sixthWeek, setSixthWeek] = useState(false)
  const [capMap, setCapMap] = useState<Record<string, number>>({})
  const [loaded, setLoaded] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [refMonday, setRefMonday] = useState<Date>(() => defaultRefMonday(new Date().getFullYear()))

  const load = useCallback(async () => {
    setLoaded(false)
    const from = `${year}-01-01`, to = `${year}-12-31`
    const [{ data: emps }, { data: ls }, planningData, { data: hols }, { data: co }, { data: capRows }] = await Promise.all([
      supabase.from('employees').select('id,first_name,last_name,contract_minutes_per_week,formation_minutes_per_week,leave_weeks_per_year,color_index').eq('company_id', companyId).eq('active', true).order('sort_order'),
      supabase.from('planning_slots').select('id,employee_id,date,slot_type,start_minutes,end_minutes').eq('company_id', companyId).gte('date', from).lte('date', to).in('slot_type', ['leave_day', 'leave_week', 'leave_partial']),
      loadPlanningData(companyId),
      supabase.from('public_holidays').select('date').eq('company_id', companyId).eq('year', year),
      supabase.from('companies').select('sixth_week,reference_week_date').eq('id', companyId).single(),
      supabase.from('week_targets').select('employee_id,sixth_week_cap_min').eq('company_id', companyId).eq('year', year),
    ])
    setEmployees((emps ?? []) as Employee[])
    setLeaveSlots((ls ?? []) as LeaveSlot[])
    setPeriodSlots(planningData.periodSlots)
    setHolidays((hols ?? []) as PublicHoliday[])
    setSixthWeek((co)?.sixth_week ?? false)
    const refStr = (co)?.reference_week_date as string | null
    setRefMonday(refStr ? new Date(refStr + 'T00:00:00') : defaultRefMonday(year))
    // Taux de cotisation 6e semaine - la base fait foi (Prompt 3, plus de
    // lecture localStorage ici, cf. migration douce dans ReplacementPage.tsx)
    const cm: Record<string, number> = {}
    for (const r of (capRows ?? []) as { employee_id: string; sixth_week_cap_min: number | null }[]) {
      if (r.sixth_week_cap_min != null) cm[r.employee_id] = r.sixth_week_cap_min
    }
    setCapMap(cm)
    setLoaded(true)
  }, [companyId, year])

  useEffect(() => { if (companyId) load() }, [companyId, load])
  useRefetchOnFocus(load)

  if (!loaded) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-6 h-6 border-2 border-indigo-200 border-t-indigo-500 rounded-full animate-spin" />
    </div>
  )

  const holSet = new Set(holidays.map(h => h.date))

  // Heures travail réelles d'un jour selon semaine type (formation exclue),
  // résolu par la période active à cette date et son mode de cycle A/B vs
  // semaine unique (effectiveWeekType) - corrige un bug où ce calcul
  // ignorait complètement les périodes et le mode de cycle (audit du
  // 2026-11-16).
  function slotMin(empId: string, date: string): number {
    if (holSet.has(date)) return 0
    const d = new Date(date + 'T12:00:00')
    const jsDay = d.getDay()
    if (jsDay < 1 || jsDay > 5) return 0
    const { semSlots, period } = slotsForDate(periodSlots, d)
    const wt = effectiveWeekType(period, d, refMonday)
    return semSlots.filter(s => s.employee_id === empId && s.week_type === wt && s.day_of_week === jsDay && !s.is_formation).reduce((a, s) => a + stEff(s), 0)
  }

  // Total heures semaine type (formation exclue) pour un employé, résolu
  // par la période active à `date` (pas seulement le type de semaine brut).
  function weekTypeTotalForDate(empId: string, date: Date): number {
    const { semSlots, period } = slotsForDate(periodSlots, date)
    const wt = effectiveWeekType(period, date, refMonday)
    return semSlots
      .filter(s => s.employee_id === empId && s.week_type === wt && !s.is_formation)
      .reduce((a, s) => a + stEff(s), 0)
  }

  // Capitalisation 6ème semaine répartie sur les semaines normales
  function weeklyCapitalisation(empId: string): number {
    return capMap[empId] ?? 0
  }

  // K = proportion du temps réel (hors cotisation 6ème semaine) pour un jour isolé
  function kCoeff(empId: string, date: Date): number {
    const total = weekTypeTotalForDate(empId, date)
    if (total === 0) return 1
    const cap = weeklyCapitalisation(empId)
    return (total - cap) / total
  }

  function getStats(emp: Employee) {
    const effectif = emp.contract_minutes_per_week - emp.formation_minutes_per_week
    const sixthWkMin = sixthWeek ? effectif : 0
    const droitConge = effectif * emp.leave_weeks_per_year + sixthWkMin
    const droitSem = emp.leave_weeks_per_year + (sixthWeek ? 1 : 0)

    const empLeaveSlots = leaveSlots.filter(s => s.employee_id === emp.id)
    const fullWeekSlots = empLeaveSlots.filter(s => s.slot_type === 'leave_week')
    const daySlots = empLeaveSlots.filter(s => s.slot_type === 'leave_day')
    const partialSlots = empLeaveSlots.filter(s => s.slot_type === 'leave_partial')

    let leaveMin = 0
    const cap = weeklyCapitalisation(emp.id)

    // Semaines entières : heures semaine type réelle − capitalisation
    const processedWeeks = new Set<number>()
    for (const s of fullWeekSlots) {
      const d = new Date(s.date + 'T12:00:00')
      const isoWeek = getISOWeek(d)
      if (processedWeeks.has(isoWeek)) continue
      processedWeeks.add(isoWeek)
      leaveMin += Math.round(Math.max(0, weekTypeTotalForDate(emp.id, d) - cap))
    }

    // Jours isolés : heures semaine type × K (retire cotisation 6ème semaine)
    for (const s of daySlots) {
      const d = new Date(s.date + 'T12:00:00')
      leaveMin += Math.round(slotMin(emp.id, s.date) * kCoeff(emp.id, d))
    }

    // Congés horaires partiels : durée exacte
    for (const s of partialSlots) {
      if (s.start_minutes != null && s.end_minutes != null)
        leaveMin += Math.max(0, s.end_minutes - s.start_minutes)
    }

    const solde = droitConge - leaveMin
    const equivSem = effectif > 0 ? leaveMin / effectif : 0
    return { droitConge, droitSem, leaveMin, solde, equivSem }
  }

  function buildGroups(emp: Employee): LeaveEntry[] {
    const empSlots = leaveSlots.filter(s => s.employee_id === emp.id)
    const weekMap = new Map<number, LeaveSlot[]>()
    const dayList: LeaveSlot[] = []

    for (const s of empSlots) {
      if (s.slot_type === 'leave_week') {
        const w = getISOWeek(new Date(s.date + 'T12:00:00'))
        if (!weekMap.has(w)) weekMap.set(w, [])
        weekMap.get(w)!.push(s)
      } else if (s.slot_type === 'leave_day') {
        dayList.push(s)
      }
      // leave_partial traité séparément ci-dessous
    }

    const entries: LeaveEntry[] = []

    const cap = weeklyCapitalisation(emp.id)
    for (const [isoWeek, slots] of weekMap) {
      const dates = slots.map(s => s.date).sort()
      const mon = getMondayOf(new Date(dates[0] + 'T12:00:00'))
      const fri = new Date(mon); fri.setDate(mon.getDate() + 4)
      // Label informatif (parité calendaire réelle) - distinct du calcul,
      // qui résout toujours la période/le mode de cycle actifs à la date.
      const weekType: 'A' | 'B' = getWeekType(new Date(dates[0] + 'T12:00:00'), refMonday)
      const totalMin = Math.round(Math.max(0, weekTypeTotalForDate(emp.id, new Date(dates[0] + 'T12:00:00')) - cap))
      let holidayMin = 0
      for (let offset = 0; offset <= 4; offset++) {
        const day = new Date(mon); day.setDate(mon.getDate() + offset)
        const ds = toStr(day)
        if (!holSet.has(ds)) continue
        const jsDay = day.getDay()
        const { semSlots: daySemSlots, period } = slotsForDate(periodSlots, day)
        const dayWt = effectiveWeekType(period, day, refMonday)
        holidayMin += daySemSlots
          .filter(s => s.employee_id === emp.id && s.week_type === dayWt && s.day_of_week === jsDay && !s.is_formation)
          .reduce((a, s) => a + stEff(s), 0)
      }
      entries.push({
        key: `w-${emp.id}-${isoWeek}`,
        type: 'week', isoWeek, weekType, dates,
        label: `Semaine ${isoWeek}`,
        dateRange: `${fmtShort(mon)} – ${fmtShort(fri)}`,
        totalMin,
        holidayMin: holidayMin > 0 ? holidayMin : undefined,
      })
    }

    for (const s of dayList) {
      const d = new Date(s.date + 'T12:00:00')
      const isoWeek = getISOWeek(d)
      const weekType: 'A' | 'B' = getWeekType(d, refMonday) // label informatif seulement
      entries.push({
        key: `d-${s.id}`,
        type: 'day', isoWeek, weekType, dates: [s.date],
        label: fmtDayFull(d), dateRange: '',
        totalMin: Math.round(slotMin(emp.id, s.date) * kCoeff(emp.id, d)),
      })
    }

    // Congés horaires partiels (ignorés si le jour est déjà en congé entier)
    const leaveDayDates = new Set(empSlots.filter(s => s.slot_type === 'leave_day').map(s => s.date))
    const fmtT = (m: number) => { const h = Math.floor(m / 60); const mn = m % 60; return mn > 0 ? `${h}h${String(mn).padStart(2, '0')}` : `${h}h` }
    const fmtDur = (m: number) => { const h = Math.floor(m / 60); const mn = m % 60; return mn > 0 ? `${h}h${String(mn).padStart(2, '0')}` : `${h}h` }
    for (const s of empSlots.filter(x => x.slot_type === 'leave_partial')) {
      if (leaveDayDates.has(s.date)) continue
      if (s.start_minutes == null || s.end_minutes == null) continue
      const d = new Date(s.date + 'T12:00:00')
      const isoWeek = getISOWeek(d)
      const weekType: 'A' | 'B' = getWeekType(d, refMonday)
      const dur = Math.max(0, s.end_minutes - s.start_minutes)
      entries.push({
        key: `p-${s.id}`,
        type: 'partial', isoWeek, weekType, dates: [s.date],
        label: `${fmtDayFull(d)} · ${fmtT(s.start_minutes)}–${fmtT(s.end_minutes)}`,
        dateRange: '',
        totalMin: dur,
        slotId: s.id, startMin: s.start_minutes, endMin: s.end_minutes,
      })
    }

    return entries.sort((a, b) => a.dates[0].localeCompare(b.dates[0]))
  }

  async function deleteEntry(emp: Employee, entry: LeaveEntry) {
    setDeleting(entry.key)
    if (entry.type === 'week') {
      const mon = getMondayOf(new Date(entry.dates[0] + 'T12:00:00'))
      const fri = new Date(mon); fri.setDate(mon.getDate() + 4)
      const weekDates = [0, 1, 2, 3, 4].map(o => { const d = new Date(mon); d.setDate(mon.getDate() + o); return toStr(d) })

      // Supprimer les congés de l'absente
      await supabase.from('planning_slots').delete()
        .eq('company_id', companyId).eq('employee_id', emp.id)
        .gte('date', toStr(mon)).lte('date', toStr(fri))
        .eq('slot_type', 'leave_week')

      // Supprimer les slots de remplacement des collègues présentes
      const { data: replSlots } = await supabase.from('replacement_slots')
        .select('present_employee_id,day_of_week')
        .eq('company_id', companyId)
        .eq('absent_employee_id', emp.id)

      // Régénère le planning normal (bug QA : la suppression laissait ces
      // jours vides, pour l'absente ET ses remplaçantes) - cf. scheduleGen.ts
      const toRegenerate: { employeeId: string; date: string }[] = weekDates.map(date => ({ employeeId: emp.id, date }))

      if (replSlots && replSlots.length > 0) {
        const byPresent = new Map<string, string[]>()
        for (const rs of replSlots) {
          const d = new Date(mon)
          d.setDate(mon.getDate() + (rs.day_of_week - 1))
          const ds = toStr(d)
          if (!byPresent.has(rs.present_employee_id)) byPresent.set(rs.present_employee_id, [])
          if (!byPresent.get(rs.present_employee_id)!.includes(ds)) byPresent.get(rs.present_employee_id)!.push(ds)
        }
        for (const [presentEmpId, dates] of byPresent) {
          await supabase.from('planning_slots').delete()
            .eq('company_id', companyId).eq('employee_id', presentEmpId)
            .in('date', dates).in('slot_type', ['work', 'formation'])
          for (const date of dates) toRegenerate.push({ employeeId: presentEmpId, date })
        }
      }
      await regenerateNormalSchedule(companyId, toRegenerate)
    } else if (entry.type === 'partial' && entry.slotId) {
      await supabase.from('planning_slots').delete()
        .eq('company_id', companyId).eq('id', entry.slotId)
    } else {
      // Jour isolé : pas de slots de remplacement
      await supabase.from('planning_slots').delete()
        .eq('company_id', companyId).eq('employee_id', emp.id)
        .in('date', entry.dates)
      await regenerateNormalSchedule(companyId, entry.dates.map(date => ({ employeeId: emp.id, date })))
    }
    setDeleting(null)
    load()
  }

  const TH = 'py-2.5 px-4 text-[10px] font-extrabold text-slate-500 uppercase tracking-widest bg-slate-50 border-b border-slate-100'

  return (
    <div className="min-h-full bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-8 py-4 sticky top-0 z-30 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate('/calcul-annuel')}
            className="text-xs text-slate-400 hover:text-slate-600 px-3 py-1.5 border border-slate-200 rounded-lg hover:bg-slate-50">
            ← Calcul annuel
          </button>
          <div>
            <h1 className="text-lg font-bold text-slate-800">Congés</h1>
            <p className="text-xs text-slate-400">Suivi et gestion des congés posés</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setYear(y => y - 1)} className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-500">←</button>
          <span className="text-sm font-bold text-slate-700 w-12 text-center">{year}</span>
          <button onClick={() => setYear(y => y + 1)} className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-500">→</button>
        </div>
      </div>

      <div className="p-8 max-w-4xl space-y-6">

        {/* Récapitulatif */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-3 bg-amber-50 border-b border-amber-100 flex items-baseline gap-3">
            <p className="text-[11px] font-extrabold text-amber-700 uppercase tracking-widest">Récapitulatif</p>
            <p className="text-[10px] text-amber-400">semaines posées vs droit annuel</p>
          </div>
          <table className="w-full">
            <thead>
              <tr>
                <th className={`${TH} text-left`}>Employée</th>
                <th className={`${TH} text-right`}>Droit</th>
                <th className={`${TH} text-right`}>Droit (h)</th>
                <th className={`${TH} text-right`}>Posées (h)</th>
                <th className={`${TH} text-right`}>Équiv. sem.</th>
                <th className={`${TH} text-right`}>Écart</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {employees.map((emp, i) => {
                const { droitConge, droitSem, leaveMin, solde, equivSem } = getStats(emp)
                const ok = Math.abs(solde) < 30
                return (
                  <tr key={emp.id} className="hover:bg-slate-50/60">
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-xl text-white text-xs font-bold flex items-center justify-center shrink-0"
                          style={{ background: EMP_COLORS[(emp.color_index ?? i) % 6] }}>
                          {fullName(emp)[0]}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-slate-700">{fullName(emp)}</p>
                          <p className="text-[10px] text-slate-400">{fmtMinutes(emp.contract_minutes_per_week)}/sem.</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <p className="text-sm font-semibold text-slate-600">{emp.leave_weeks_per_year} sem.</p>
                      {sixthWeek && <p className="text-[10px] text-indigo-500 font-medium">+ 1 capitalisée</p>}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-500 text-sm">{fmtMinutes(droitConge)}</td>
                    <td className="py-3 px-4 text-right text-blue-600 font-semibold text-sm">{leaveMin > 0 ? fmtMinutes(leaveMin) : '—'}</td>
                    <td className="py-3 px-4 text-right text-sm">
                      <span className={`font-semibold ${Math.abs(equivSem - droitSem) < 0.1 ? 'text-emerald-600' : equivSem < droitSem ? 'text-amber-600' : 'text-red-500'}`}>
                        {equivSem > 0 ? equivSem.toFixed(1) + ' sem.' : '—'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right text-sm">
                      {ok
                        ? <span className="text-emerald-600 font-bold">✓ Soldé</span>
                        : <span className={`font-bold ${solde > 0 ? 'text-amber-600' : 'text-red-500'}`}>
                            {solde > 0 ? '+' : '−'}{fmtMinutes(Math.abs(solde))}
                            <span className="text-[10px] font-normal ml-1 text-slate-400">{solde > 0 ? 'à poser' : 'en trop'}</span>
                          </span>
                      }
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Détail par employée */}
        {employees.map((emp, i) => {
          const groups = buildGroups(emp)
          if (groups.length === 0) return null
          return (
            <div key={emp.id} className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-6 py-3 border-b border-slate-100 bg-slate-50/60 flex items-center gap-3">
                <div className="w-7 h-7 rounded-xl text-white text-xs font-bold flex items-center justify-center shrink-0"
                  style={{ background: EMP_COLORS[(emp.color_index ?? i) % 6] }}>
                  {fullName(emp)[0]}
                </div>
                <p className="text-sm font-bold text-slate-700">{fullName(emp)}</p>
                <span className="text-xs text-slate-400">— {groups.length} entrée{groups.length > 1 ? 's' : ''}</span>
              </div>
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={`${TH} text-left w-32`}>Type</th>
                    <th className={`${TH} text-left`}>Période</th>
                    <th className={`${TH} text-right`}>Heures</th>
                    <th className={`${TH} w-24`} />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {groups.map(entry => (
                    <tr key={entry.key} className="hover:bg-slate-50/60 transition-colors">
                      <td className="py-2.5 px-4">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                          entry.type === 'week' ? 'bg-indigo-50 text-indigo-600' : 'bg-amber-50 text-amber-600'
                        }`}>
                          {entry.type === 'week' ? '📅 Semaine' : '☀️ Jour isolé'}
                        </span>
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-slate-700">{entry.label}</p>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${entry.weekType === 'A' ? 'bg-indigo-100 text-indigo-600' : 'bg-violet-100 text-violet-600'}`}>
                            Sem {entry.weekType}
                          </span>
                        </div>
                        {entry.dateRange && <p className="text-[11px] text-slate-400 mt-0.5">{entry.dateRange}</p>}
                      </td>
                      <td className="py-2.5 px-4 text-right text-sm font-medium text-slate-600">
                        {entry.totalMin > 0 ? fmtMinutes(entry.totalMin) : '—'}
                        {entry.holidayMin && entry.holidayMin > 0 ? (
                          <div className="text-[10px] text-orange-400 font-normal mt-0.5">
                            dont {fmtMinutes(entry.holidayMin)} férié
                          </div>
                        ) : null}
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        <button
                          onClick={() => deleteEntry(emp, entry)}
                          disabled={deleting === entry.key}
                          className="text-xs text-red-400 hover:text-red-600 hover:bg-red-50 px-2.5 py-1 rounded-lg transition-colors disabled:opacity-40 font-medium">
                          {deleting === entry.key ? '…' : 'Supprimer'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        })}

        {employees.length > 0 && employees.every(emp => buildGroups(emp).length === 0) && (
          <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-sm text-slate-400">
            Aucun congé posé pour {year}.
          </div>
        )}

      </div>
    </div>
  )
}
