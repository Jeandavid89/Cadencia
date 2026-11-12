import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import { fmtMinutes } from '../types'
import WeekPlanner, { EMP_COLORS, eff, type PlannerSlot, type PlannerEmployee, type DayOverlay, type LeavePartialSlot } from '../components/WeekPlanner'
import ExportPanel from '../components/ExportPanel'
import { getWeekType, defaultRefMonday, toDateStr } from '../lib/weekUtils'
import { computeSimplifiedBilan } from '../lib/bilanCalc'
import { loadPlanningData } from '../lib/planningData'

// ─── helpers ISO week ───
function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const ys = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d.getTime() - ys.getTime()) / 86400000) + 1) / 7)
}

function getMondayOf(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  d.setHours(0, 0, 0, 0)
  return d
}

function addDays(d: Date, n: number): Date { const r = new Date(d); r.setDate(r.getDate() + n); return r }
function fmtWeekRange(mon: Date): string {
  const fri = addDays(mon, 4)
  const fmt = (d: Date) => `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}`
  return `${fmt(mon)} – ${fmt(fri)}/${fri.getFullYear()}`
}

// ─── types ───
interface Employee { id: string; first_name: string; last_name: string; contract_minutes_per_week: number; color_index: number | null }
interface WeekTarget { employee_id: string; sem_a_minutes: number; sem_b_minutes: number }
interface DBPlanningSlot {
  id: string; employee_id: string; date: string
  start_minutes: number | null; end_minutes: number | null
  break_minutes: number; slot_type: 'work' | 'formation' | 'leave_day' | 'leave_week' | 'public_holiday' | 'leave_partial'
}
interface DayOverride { employee_id: string; day: number; type: 'leave_day' | 'leave_week' | 'public_holiday'; name?: string }
interface BilanRow { empId: string; name: string; colorIdx: number; soldeHeures: number; soldeCongés: number }

const fullName = (e: Employee) => `${e.first_name} ${e.last_name}`.trim() || 'Sans nom'
const m2t = (m: number) => `${Math.floor(m / 60).toString().padStart(2, '0')}:${(m % 60).toString().padStart(2, '0')}`
const t2m = (t: string) => { const [h, mm] = t.split(':').map(Number); return h * 60 + (mm || 0) }
const DAYS_FR_LONG = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi']

const SLOT_TYPE_LABELS: Record<string, string> = { leave_day: 'Congé', leave_week: 'Congé semaine', public_holiday: 'Férié' }
const SLOT_TYPE_COLORS: Record<string, string> = { leave_day: '#3b82f6', leave_week: '#6366f1', public_holiday: '#94a3b8' }
const DAYS_FR = ['', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven']
const MONTHS_FR_LONG = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre']

const BILAN_COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#0ea5e9']

export default function PlanningPage() {
  const { user } = useAuthStore()
  const companyId = user?.id ?? ''
  const navigate = useNavigate()
  const [weekStart, setWeekStart] = useState<Date>(() => getMondayOf(new Date()))
  const [employees, setEmployees] = useState<Employee[]>([])
  const [targets, setTargets] = useState<WeekTarget[]>([])
  // Référence semaine type par jour : { [empId]: { A: { 1: min, …, 5: min }, B: { … } } }
  const [stRef, setStRef] = useState<Record<string, Record<'A' | 'B', Record<number, number>>>>({})
  const [dbSlots, setDbSlots] = useState<DBPlanningSlot[]>([])
  const [holidays, setHolidays] = useState<{ date: string; name: string }[]>([])
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [replConfig, setReplConfig] = useState<{ absent_employee_id: string; present_employee_id: string; day_of_week: number; start_minutes: number; end_minutes: number; break_minutes: number }[]>([])
  const [refMonday, setRefMonday] = useState<Date>(() => defaultRefMonday(new Date().getFullYear()))
  const [calOpen, setCalOpen] = useState(false)
  const [calMonth, setCalMonth] = useState<Date>(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1) })
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; empId: string; day: number; mode?: 'main' | 'pause' } | null>(null)
  const [bilanOpen, setBilanOpen] = useState(false)
  const [bilanRows, setBilanRows] = useState<BilanRow[]>([])
  const [bilanLoading, setBilanLoading] = useState(false)
  const [leavePartialForm, setLeavePartialForm] = useState<{ empId: string; day: number; startMin: number; endMin: number; x: number; y: number } | null>(null)
  const [exportOpen, setExportOpen] = useState(false)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load employees + targets once
  useEffect(() => {
    if (!companyId) return
    async function init() {
      const year = new Date().getFullYear()
      const [{ data: emps }, { data: tgts }, { data: hols }, planningData, { data: co }] = await Promise.all([
        supabase.from('employees').select('id,first_name,last_name,contract_minutes_per_week,color_index').eq('company_id', companyId).eq('active', true).order('sort_order'),
        supabase.from('week_targets').select('employee_id,sem_a_minutes,sem_b_minutes').eq('company_id', companyId).eq('year', year),
        supabase.from('public_holidays').select('date,name').eq('company_id', companyId).eq('year', year),
        loadPlanningData(companyId),
        supabase.from('companies').select('reference_week_date').eq('id', companyId).single(),
      ])
      const refStr = (co)?.reference_week_date as string | null
      setRefMonday(refStr ? new Date(refStr + 'T00:00:00') : defaultRefMonday(year))
      if (tgts) setTargets(tgts)
      if (hols) setHolidays(hols)
      setReplConfig(planningData.replSlots)
      if (emps) {
        setEmployees(emps)
        // Initialiser stRef : heures par jour pour chaque employé/semaine type
        // TODO (Prompt 9) : résoudre par période/date au lieu de la vue à plat.
        const emptyDays = () => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 })
        const ref: Record<string, Record<'A' | 'B', Record<number, number>>> = {}
        emps.forEach(e => { ref[e.id] = { A: emptyDays(), B: emptyDays() } })
        for (const s of planningData.semSlots) {
          if (ref[s.employee_id]) {
            ref[s.employee_id][s.week_type][s.day_of_week] += Math.max(0, s.end_minutes - s.start_minutes - s.break_minutes)
          }
        }
        setStRef(ref)
      }
    }
    init()
  }, [companyId])

  const loadWeek = useCallback(async () => {
    setLoaded(false)
    const from = toDateStr(weekStart)
    const to = toDateStr(addDays(weekStart, 4))
    const { data } = await supabase.from('planning_slots')
      .select('id,employee_id,date,start_minutes,end_minutes,break_minutes,slot_type')
      .eq('company_id', companyId)
      .gte('date', from).lte('date', to)
    setDbSlots((data as DBPlanningSlot[]) ?? [])
    setLoaded(true)
  }, [companyId, weekStart])

  // Load week slots when weekStart changes
  useEffect(() => {
    if (!companyId || employees.length === 0) return
    loadWeek()
  }, [companyId, weekStart, employees.length, loadWeek])

  // Congés horaires partiels
  const leavePartialSlots: LeavePartialSlot[] = dbSlots
    .filter(s => s.slot_type === 'leave_partial' && s.start_minutes !== null)
    .map(s => {
      const date = new Date(s.date + 'T12:00:00')
      return { id: s.id, employee_id: s.employee_id, day: date.getDay(), start_min: s.start_minutes!, end_min: s.end_minutes ?? s.start_minutes! + 60 }
    })

  // Convert DB slots → PlannerSlot (only work/formation)
  const plannerSlots: PlannerSlot[] = dbSlots
    .filter(s => (s.slot_type === 'work' || s.slot_type === 'formation') && s.start_minutes !== null)
    .map(s => {
      const date = new Date(s.date + 'T12:00:00')
      const jsDay = date.getDay() // 1=Mon...5=Fri
      return {
        id: s.id,
        employee_id: s.employee_id,
        day: jsDay,
        start_min: s.start_minutes!,
        end_min: s.end_minutes ?? s.start_minutes! + 60,
        break_min: s.break_minutes,
        is_formation: s.slot_type === 'formation',
      }
    })

  // Day overrides (leave / holidays) pour le bandeau
  const dayOverrides: DayOverride[] = dbSlots
    .filter(s => s.slot_type === 'leave_day' || s.slot_type === 'leave_week' || s.slot_type === 'public_holiday')
    .map(s => {
      const date = new Date(s.date + 'T12:00:00')
      const jsDay = date.getDay()
      const hol = holidays.find(h => h.date === s.date)
      return { employee_id: s.employee_id, day: jsDay, type: s.slot_type as DayOverride['type'], name: hol?.name }
    })

  // Overlays visuels dans WeekPlanner
  const plannerOverlays: DayOverlay[] = [
    // Jours fériés : affichés pour TOUS les employés (même non travaillés)
    ...[1, 2, 3, 4, 5].flatMap(day => {
      const dayDate = addDays(weekStart, day - 1)
      const ds = toDateStr(dayDate)
      const hol = holidays.find(h => h.date === ds)
      if (!hol) return []
      return [{ employee_id: '*', day, color: '#94a3b8', label: hol.name || 'Férié' }]
    }),
    // Congés : par employé
    ...dbSlots
      .filter(s => s.slot_type === 'leave_day' || s.slot_type === 'leave_week')
      .map(s => {
        const jsDay = new Date(s.date + 'T12:00:00').getDay()
        return { employee_id: s.employee_id, day: jsDay, color: '#3b82f6', label: s.slot_type === 'leave_week' ? 'Congé sem.' : 'Congé' }
      }),
  ]

  const scheduleSave = useCallback((newSlots: PlannerSlot[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setSaving(true)
    saveTimer.current = setTimeout(async () => {
      try {
        const from = toDateStr(weekStart)
        const to = toDateStr(addDays(weekStart, 4))
        const { error: delErr } = await supabase.from('planning_slots')
          .delete()
          .eq('company_id', companyId)
          .gte('date', from).lte('date', to)
          .in('slot_type', ['work', 'formation'])
        if (delErr) throw delErr
        if (newSlots.length > 0) {
          const { error: insErr } = await supabase.from('planning_slots').insert(newSlots.map(s => {
            const dateObj = addDays(weekStart, s.day - 1)
            return {
              company_id: companyId, employee_id: s.employee_id, date: toDateStr(dateObj),
              start_minutes: s.start_min, end_minutes: s.end_min, break_minutes: s.break_min,
              slot_type: s.is_formation ? 'formation' : 'work',
            }
          }))
          if (insErr) throw insErr
        }
      } catch (err: unknown) {
        console.error('Erreur sauvegarde planning:', err)
        const msg = err && typeof err === 'object' && 'message' in err ? (err as { message: string }).message : JSON.stringify(err)
        alert(`Erreur sauvegarde planning:\n${msg}`)
      } finally {
        setSaving(false)
      }
    }, 800)
  }, [companyId, weekStart])

  function handleSlotsChange(newSlots: PlannerSlot[]) {
    // Update local planner slots immediately (merge back with overrides)
    setDbSlots(prev => {
      const overrides = prev.filter(s => s.slot_type !== 'work' && s.slot_type !== 'formation')
      const fakeWork: DBPlanningSlot[] = newSlots.map(s => ({
        id: s.id, employee_id: s.employee_id,
        date: toDateStr(addDays(weekStart, s.day - 1)),
        start_minutes: s.start_min, end_minutes: s.end_min, break_minutes: s.break_min,
        slot_type: s.is_formation ? 'formation' : 'work',
      }))
      return [...overrides, ...fakeWork]
    })
    scheduleSave(newSlots)
  }

  async function markLeave(empId: string, day: number, type: 'leave_day' | 'leave_week') {
    const dateObj = addDays(weekStart, day - 1)
    const ds = toDateStr(dateObj)
    // Remove existing slot for this employee on this day
    await supabase.from('planning_slots').delete().eq('company_id', companyId).eq('employee_id', empId).eq('date', ds)
    await supabase.from('planning_slots').insert({ company_id: companyId, employee_id: empId, date: ds, start_minutes: null, end_minutes: null, break_minutes: 0, slot_type: type })
    setContextMenu(null)
    loadWeek()
  }

  async function markLeaveWeek(empId: string) {
    const wt = weekType
    for (let day = 1; day <= 5; day++) {
      const ds = toDateStr(addDays(weekStart, day - 1))
      if (holidays.find(h => h.date === ds)) continue
      if ((stRef[empId]?.[wt]?.[day] ?? 0) === 0) continue
      await supabase.from('planning_slots').delete().eq('company_id', companyId).eq('employee_id', empId).eq('date', ds)
      await supabase.from('planning_slots').insert({ company_id: companyId, employee_id: empId, date: ds, start_minutes: null, end_minutes: null, break_minutes: 0, slot_type: 'leave_week' })
    }

    // Appliquer les slots de remplacement configurés dans Remplacement & Lissage
    const { data: replSlots } = await supabase.from('replacement_slots')
      .select('present_employee_id,day_of_week,start_minutes,end_minutes,break_minutes,is_formation')
      .eq('company_id', companyId)
      .eq('absent_employee_id', empId)

    if (replSlots && replSlots.length > 0) {
      // Grouper par (present_employee_id, day_of_week) pour gérer les multi-créneaux/jour
      const groups = new Map<string, typeof replSlots>()
      for (const rs of replSlots) {
        const key = `${rs.present_employee_id}|${rs.day_of_week}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(rs)
      }
      for (const slots of groups.values()) {
        const { present_employee_id, day_of_week } = slots[0]
        const ds = toDateStr(addDays(weekStart, day_of_week - 1))
        if (holidays.find(h => h.date === ds)) continue
        await supabase.from('planning_slots').delete()
          .eq('company_id', companyId).eq('employee_id', present_employee_id).eq('date', ds)
          .in('slot_type', ['work', 'formation'])
        await supabase.from('planning_slots').insert(slots.map(rs => ({
          company_id: companyId, employee_id: rs.present_employee_id, date: ds,
          start_minutes: rs.start_minutes, end_minutes: rs.end_minutes, break_minutes: rs.break_minutes,
          slot_type: rs.is_formation ? 'formation' : 'work',
        })))
      }
    }

    setContextMenu(null)
    loadWeek()
  }

  function toggleFormationDay(empId: string, day: number) {
    const daySlots = plannerSlots.filter(s => s.employee_id === empId && s.day === day)
    if (daySlots.length === 0) return
    const allFormation = daySlots.every(s => s.is_formation)
    handleSlotsChange(plannerSlots.map(s =>
      s.employee_id === empId && s.day === day ? { ...s, is_formation: !allFormation } : s
    ))
    setContextMenu(null)
  }

  function setPauseDay(empId: string, day: number, pauseMin: number) {
    handleSlotsChange(plannerSlots.map(s =>
      s.employee_id === empId && s.day === day ? { ...s, break_min: pauseMin } : s
    ))
    setContextMenu(null)
  }

  async function removeOverride(empId: string, day: number) {
    const ds = toDateStr(addDays(weekStart, day - 1))
    await supabase.from('planning_slots').delete().eq('company_id', companyId).eq('employee_id', empId).eq('date', ds).in('slot_type', ['leave_day', 'leave_week', 'public_holiday'])
    setContextMenu(null)
    loadWeek()
  }

  function handleGridRightClick(empId: string, day: number, minuteAt: number, x: number, y: number) {
    setContextMenu(null)
    setLeavePartialForm({ empId, day, startMin: minuteAt, endMin: Math.min(minuteAt + 120, 1200), x, y })
  }

  async function saveLeavePartial() {
    if (!leavePartialForm) return
    const { empId, day, startMin, endMin } = leavePartialForm
    const ds = toDateStr(addDays(weekStart, day - 1))
    const conflict = dbSlots.find(s => s.employee_id === empId && s.date === ds && (s.slot_type === 'leave_day' || s.slot_type === 'leave_week'))
    if (conflict) {
      alert('Ce jour est déjà posé en congé entier. Supprimez-le d\'abord pour poser un congé horaire.')
      return
    }
    const { error } = await supabase.from('planning_slots').insert({ company_id: companyId, employee_id: empId, date: ds, start_minutes: startMin, end_minutes: endMin, break_minutes: 0, slot_type: 'leave_partial' })
    if (error) { alert('Erreur DB : ' + error.message); return }
    setLeavePartialForm(null)
    loadWeek()
  }

  async function deleteLeavePartial(id: string) {
    await supabase.from('planning_slots').delete().eq('id', id)
    loadWeek()
  }

  // Deviation from semaine type target
  const isoWeek = getISOWeek(weekStart)
  const weekType: 'A' | 'B' = getWeekType(weekStart, refMonday)

  function isOnLeaveThisWeek(empId: string): boolean {
    const dayRef = stRef[empId]?.[weekType]
    if (!dayRef) return false
    let hasWorkingDay = false
    for (let d = 1; d <= 5; d++) {
      if ((dayRef[d] ?? 0) === 0) continue
      hasWorkingDay = true
      if (!dayOverrides.some(o => o.employee_id === empId && o.day === d && o.type === 'leave_week')) return false
    }
    return hasWorkingDay
  }

  function getDeviation(empId: string): { onLeave: true } | { onLeave: false; value: number } | null {
    const dayRef = stRef[empId]?.[weekType]
    if (!dayRef) return null
    if (isOnLeaveThisWeek(empId)) return { onLeave: true }
    const absentDays = new Set(dayOverrides.filter(o => o.employee_id === empId).map(o => o.day))
    // Règle RH "Remplacement simple" : dès qu'une collègue est absente cette
    // semaine, la semaine type normale est ignorée - un jour sans créneau de
    // remplacement explicite compte 0, pas le planning normal.
    const weekHasColleagueAbsence = dayOverrides.some(o => o.employee_id !== empId && o.type === 'leave_week')
    let reference = 0
    for (let d = 1; d <= 5; d++) {
      if (absentDays.has(d)) continue
      // Si cet employé remplace une collègue absente ce jour, utiliser les heures de remplacement comme référence
      const replHours = replConfig
        .filter(rs => rs.present_employee_id === empId && rs.day_of_week === d)
        .filter(rs => dayOverrides.some(o => o.employee_id === rs.absent_employee_id && o.day === d && o.type === 'leave_week'))
        .reduce((a, rs) => a + Math.max(0, rs.end_minutes - rs.start_minutes - rs.break_minutes), 0)
      if (replHours > 0) reference += replHours
      else if (!weekHasColleagueAbsence) reference += (dayRef[d] ?? 0)
    }
    const actual = plannerSlots.filter(s => s.employee_id === empId).reduce((a, s) => a + eff(s), 0)
    return { onLeave: false, value: actual - reference }
  }

  function getCalWeeks(monthDate: Date) {
    const year = monthDate.getFullYear(), m = monthDate.getMonth()
    const start = getMondayOf(new Date(year, m, 1))
    const lastDay = new Date(year, m + 1, 0)
    const weeks: { monday: Date; isoWeek: number; weekType: 'A' | 'B' }[] = []
    const cur = new Date(start)
    while (cur <= lastDay) {
      const w = getISOWeek(cur)
      weeks.push({ monday: new Date(cur), isoWeek: w, weekType: getWeekType(cur, refMonday) })
      cur.setDate(cur.getDate() + 7)
    }
    return weeks
  }

  const plannerEmps: PlannerEmployee[] = employees.map((e, i) => ({ id: e.id, name: fullName(e), colorIdx: e.color_index ?? i }))

  function handleRightClick(e: React.MouseEvent, empId: string, day: number) {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, empId, day })
  }

  const cmEmp = contextMenu ? employees.find(e => e.id === contextMenu.empId) : null
  const cmOverride = contextMenu ? dayOverrides.find(o => o.employee_id === contextMenu.empId && o.day === contextMenu.day) : null

  async function loadBilan() {
    if (bilanLoading) return
    setBilanLoading(true)
    const year = new Date().getFullYear()
    const from = `${year}-01-01`
    const to = `${year}-12-31`
    const [{ data: emps }, { data: hols }, planningData, { data: leaveSlots }, { data: carries }, { data: coData }, { data: capRows }] = await Promise.all([
      supabase.from('employees').select('id,first_name,last_name,contract_minutes_per_week,formation_minutes_per_week,leave_weeks_per_year').eq('company_id', companyId).eq('active', true).order('sort_order'),
      supabase.from('public_holidays').select('date').eq('company_id', companyId).eq('year', year),
      loadPlanningData(companyId),
      supabase.from('planning_slots').select('employee_id,date,slot_type,start_minutes,end_minutes').eq('company_id', companyId).gte('date', from).lte('date', to).in('slot_type', ['leave_week','leave_day','leave_partial']),
      supabase.from('annual_carryover').select('employee_id,carryover_minutes,carryover_leave_minutes').eq('company_id', companyId).eq('year', year - 1),
      supabase.from('companies').select('sixth_week,reference_week_date').eq('id', companyId).single(),
      supabase.from('week_targets').select('employee_id,sixth_week_cap_min').eq('company_id', companyId).eq('year', year),
    ])
    if (!emps) { setBilanLoading(false); return }
    const hasSixthWeek: boolean = (coData)?.sixth_week ?? false
    const refStr = (coData)?.reference_week_date as string | null
    const ref = refStr ? new Date(refStr + 'T00:00:00') : defaultRefMonday(year)
    const holSet = new Set(((hols ?? []) as { date: string }[]).map(h => h.date))
    const lSlots = (leaveSlots ?? []) as { employee_id: string; date: string; slot_type: string; start_minutes?: number | null; end_minutes?: number | null }[]
    // Taux de cotisation 6e semaine - la base fait foi (Prompt 3, plus de
    // lecture localStorage ici, cf. migration douce dans ReplacementPage.tsx)
    const capMap: Record<string, number> = {}
    for (const r of (capRows ?? []) as { employee_id: string; sixth_week_cap_min: number | null }[]) {
      if (r.sixth_week_cap_min != null) capMap[r.employee_id] = r.sixth_week_cap_min
    }
    const carryMap: Record<string, { carryover_minutes: number; carryover_leave_minutes: number }> = {}
    for (const c of (carries ?? []) as { employee_id: string; carryover_minutes: number; carryover_leave_minutes: number }[])
      carryMap[c.employee_id] = { carryover_minutes: c.carryover_minutes, carryover_leave_minutes: c.carryover_leave_minutes }

    const simplified = computeSimplifiedBilan({
      year, refMonday: ref, employees: emps, periodSlots: planningData.periodSlots, leaveSlots: lSlots,
      holSet, hasSixthWeek, capMap, carryMap,
    })
    const rows: BilanRow[] = emps.map((emp, i) => {
      const r = simplified[emp.id]
      return { empId: emp.id, name: `${emp.first_name} ${emp.last_name}`.trim(), colorIdx: i, soldeHeures: r.soldeHeures, soldeCongés: r.soldeConges }
    })
    setBilanRows(rows)
    setBilanLoading(false)
  }

  if (!loaded) return <div className="flex items-center justify-center h-full"><div className="w-6 h-6 border-2 border-indigo-200 border-t-indigo-500 rounded-full animate-spin" /></div>

  return (
    <div className="min-h-full bg-slate-50" onClick={() => { setContextMenu(null); setCalOpen(false); setLeavePartialForm(null) }}>

      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-8 py-4 sticky top-0 z-30">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-slate-800">Planning</h1>
            <p className="text-xs text-slate-400">Agenda réel de l'équipe</p>
          </div>
          <div className="flex items-center gap-4">
            {saving && <div className="flex items-center gap-2 text-xs text-slate-400"><div className="w-3.5 h-3.5 border-2 border-slate-200 border-t-indigo-400 rounded-full animate-spin" />Enregistrement…</div>}
            <div className="relative">
              <button onClick={e => { e.stopPropagation(); setExportOpen(v => !v); setBilanOpen(false) }}
                className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-xl bg-white hover:bg-slate-50 transition-colors">
                Exporter PDF
              </button>
              {exportOpen && (
                <ExportPanel
                  companyId={companyId}
                  employees={employees}
                  holidays={holidays}
                  onClose={() => setExportOpen(false)}
                />
              )}
            </div>
            <div className="relative">
              <button onClick={e => { e.stopPropagation(); if (!bilanOpen) loadBilan(); setBilanOpen(v => !v) }}
                className="px-4 py-2 text-xs font-semibold text-amber-700 border border-amber-300 rounded-xl bg-amber-50 hover:bg-amber-100 transition-colors">
                Bilan {new Date().getFullYear()}
              </button>
              {bilanOpen && (
                <div onClick={e => e.stopPropagation()}
                  className="absolute right-0 top-10 z-50 bg-white rounded-2xl shadow-xl border border-slate-200 w-80">
                  <div className="flex items-center justify-between px-4 py-3 bg-amber-50 border-b border-amber-100 rounded-t-2xl">
                    <p className="font-bold text-amber-800 text-sm">Bilan {new Date().getFullYear()}</p>
                    <button onClick={() => setBilanOpen(false)} className="text-slate-400 hover:text-slate-600 text-lg leading-none">×</button>
                  </div>
                  <div className="p-4 space-y-4">
                    {bilanLoading ? (
                      <div className="flex justify-center py-4"><div className="w-5 h-5 border-2 border-amber-200 border-t-amber-500 rounded-full animate-spin" /></div>
                    ) : bilanRows.map(b => {
                      const clsC = b.soldeCongés > 0 ? 'text-amber-600' : b.soldeCongés < 0 ? 'text-blue-600' : 'text-emerald-600'
                      const clsPlan = (v: number) => v > 0 ? 'text-amber-600' : v < 0 ? 'text-red-500' : 'text-emerald-600'
                      const devResult = getDeviation(b.empId)
                      const weekSolde = devResult && !devResult.onLeave ? devResult.value : 0
                      const soldeLive = b.soldeHeures + weekSolde
                      const fmtSolde = (v: number) => `${v >= 0 ? '+' : '−'}${fmtMinutes(Math.abs(v))}`
                      return (
                        <div key={b.empId} className="flex items-start gap-3">
                          <div className="w-7 h-7 rounded-xl text-white text-xs font-bold flex items-center justify-center shrink-0"
                            style={{ background: BILAN_COLORS[b.colorIdx % BILAN_COLORS.length] }}>
                            {b.name[0]}
                          </div>
                          <div className="flex-1">
                            <p className="text-sm font-semibold text-slate-700 leading-tight">{b.name}</p>
                            <div className="grid grid-cols-3 gap-1 mt-1">
                              <div>
                                <p className="text-[9px] text-slate-400 uppercase tracking-wide leading-tight">Déc. annuel</p>
                                <p className="text-xs font-bold text-slate-900">{fmtSolde(b.soldeHeures)}</p>
                              </div>
                              <div>
                                <p className="text-[9px] text-slate-400 uppercase tracking-wide leading-tight">Sem.</p>
                                <p className={`text-xs ${clsPlan(weekSolde)}`}>{fmtSolde(weekSolde)}</p>
                              </div>
                              <div>
                                <p className="text-[9px] text-slate-400 uppercase tracking-wide leading-tight">= Solde live</p>
                                <p className={`text-xs font-bold ${clsPlan(soldeLive)}`}>{fmtSolde(soldeLive)}</p>
                              </div>
                            </div>
                            <div className="mt-1.5">
                              <p className="text-[9px] text-slate-400 uppercase tracking-wide leading-tight">Congés</p>
                              <p className={`text-xs font-bold ${clsC}`}>{b.soldeCongés === 0 ? 'Soldé' : fmtSolde(b.soldeCongés)}</p>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  <div className="px-4 py-3 border-t border-slate-100">
                    <button onClick={() => { setBilanOpen(false); navigate('/calcul-annuel') }}
                      className="w-full text-xs font-semibold text-indigo-600 hover:text-indigo-800 transition-colors">
                      → Ouvrir Bilan annuel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Week nav */}
        <div className="flex items-center gap-4 mt-3">
          <button onClick={() => setWeekStart(d => addDays(d, -7))}
            className="px-3 py-1.5 text-xs text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50">← Sem. préc.</button>
          <div className="text-sm font-semibold text-slate-700">
            Semaine {isoWeek} · {fmtWeekRange(weekStart)}
            <span className={`ml-3 px-2 py-0.5 rounded-full text-xs font-bold ${weekType === 'A' ? 'bg-indigo-100 text-indigo-600' : 'bg-violet-100 text-violet-600'}`}>
              Sem. {weekType}
            </span>
          </div>
          <button onClick={() => setWeekStart(d => addDays(d, 7))}
            className="px-3 py-1.5 text-xs text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50">Sem. suiv. →</button>
          <button onClick={() => setWeekStart(getMondayOf(new Date()))}
            className="px-3 py-1.5 text-xs text-indigo-500 border border-indigo-200 rounded-lg hover:bg-indigo-50">Aujourd'hui</button>

          {/* Mini calendrier mensuel */}
          <div className="relative" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => { setCalMonth(new Date(weekStart.getFullYear(), weekStart.getMonth(), 1)); setCalOpen(v => !v) }}
              className={`px-2.5 py-1.5 text-sm border rounded-lg transition-colors ${calOpen ? 'bg-indigo-50 border-indigo-200 text-indigo-600' : 'border-slate-200 text-slate-400 hover:bg-slate-50'}`}
              title="Calendrier mensuel">
              📅
            </button>
            {calOpen && (
              <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 bg-white border border-slate-200 rounded-2xl shadow-2xl z-[200] p-4 w-60">
                {/* Navigation mois */}
                <div className="flex items-center justify-between mb-3">
                  <button onClick={() => setCalMonth(d => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
                    className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">←</button>
                  <span className="text-xs font-bold text-slate-700">
                    {MONTHS_FR_LONG[calMonth.getMonth()]} {calMonth.getFullYear()}
                  </span>
                  <button onClick={() => setCalMonth(d => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
                    className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">→</button>
                </div>
                {/* En-têtes colonnes */}
                <div className="grid grid-cols-7 mb-1 px-1">
                  <div className="text-[9px] text-slate-300 text-center font-medium">S.</div>
                  {['L','M','M','J','V'].map((d, i) => (
                    <div key={i} className="text-[9px] text-slate-400 text-center font-bold col-span-1">{d}</div>
                  ))}
                  <div className="text-[9px] text-slate-300 text-center font-medium">T.</div>
                </div>
                {/* Lignes semaines */}
                {getCalWeeks(calMonth).map(({ monday, isoWeek, weekType }) => {
                  const isActive = toDateStr(monday) === toDateStr(weekStart)
                  const todayStr = toDateStr(new Date())
                  return (
                    <button key={isoWeek} onClick={() => { setWeekStart(new Date(monday)); setCalOpen(false) }}
                      className={`w-full grid grid-cols-7 py-1 px-1 rounded-lg mb-0.5 transition-colors hover:bg-slate-50 ${isActive ? 'bg-indigo-50 ring-1 ring-inset ring-indigo-200' : ''}`}>
                      <div className={`text-[9px] font-bold text-center self-center ${isActive ? 'text-indigo-500' : 'text-slate-300'}`}>{isoWeek}</div>
                      {[0,1,2,3,4].map(offset => {
                        const day = new Date(monday); day.setDate(monday.getDate() + offset)
                        const ds = toDateStr(day)
                        const inMonth = day.getMonth() === calMonth.getMonth()
                        const isToday = ds === todayStr
                        return (
                          <div key={offset} className={`text-[10px] text-center w-5 h-5 mx-auto flex items-center justify-center rounded-full
                            ${isToday ? 'bg-indigo-600 text-white font-bold text-[9px]'
                              : inMonth ? (isActive ? 'text-indigo-700 font-semibold' : 'text-slate-600')
                              : 'text-slate-200'}`}>
                            {day.getDate()}
                          </div>
                        )
                      })}
                      <div className={`text-[9px] font-bold text-center self-center ${
                        weekType === 'A'
                          ? (isActive ? 'text-indigo-600' : 'text-indigo-200')
                          : (isActive ? 'text-violet-600' : 'text-violet-200')
                      }`}>{weekType}</div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* Deviations */}
        {Object.keys(stRef).length > 0 && (
          <div className="flex flex-wrap gap-3 mt-3">
            {employees.map((emp, i) => {
              const c = EMP_COLORS[(emp.color_index ?? i) % EMP_COLORS.length]
              const devResult = getDeviation(emp.id)
              if (devResult === null) return null
              return (
                <div key={emp.id} className="flex items-center gap-2 text-xs">
                  <div className="w-2 h-2 rounded-full" style={{ background: c.bg }} />
                  <span className="text-slate-600 font-medium">{fullName(emp)}</span>
                  {devResult.onLeave ? (
                    <span className="text-slate-400 font-medium">✕ En congé</span>
                  ) : (
                    <span className={`font-bold ${devResult.value === 0 ? 'text-emerald-600' : devResult.value > 0 ? 'text-amber-600' : 'text-red-500'}`}>
                      {devResult.value === 0 ? '✓ Conforme' : `${devResult.value > 0 ? '+' : '−'}${fmtMinutes(Math.abs(devResult.value))}`}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="p-8 max-w-6xl space-y-4">

        {/* Day overrides banner */}
        {(dayOverrides.length > 0 || leavePartialSlots.length > 0) && (
          <div className="bg-white rounded-2xl border border-slate-200 px-6 py-4">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Absences & fériés cette semaine</p>
            <div className="flex flex-wrap gap-2">
              {employees.map((emp, ei) => {
                const c = EMP_COLORS[ei % EMP_COLORS.length]
                const empOverrides = dayOverrides.filter(o => o.employee_id === emp.id)
                const empPartial = leavePartialSlots.filter(lp => lp.employee_id === emp.id)
                if (empOverrides.length === 0 && empPartial.length === 0) return null
                return (
                  <div key={emp.id} className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-xl border border-slate-100">
                    <div className="w-2 h-2 rounded-full" style={{ background: c.bg }} />
                    <span className="text-xs font-medium text-slate-600">{fullName(emp)}</span>
                    {empOverrides.map((o, oi) => (
                      <span key={oi} className="px-2 py-0.5 rounded-full text-[11px] font-medium text-white"
                        style={{ background: SLOT_TYPE_COLORS[o.type] ?? '#94a3b8' }}>
                        {DAYS_FR[o.day]} — {o.name ?? SLOT_TYPE_LABELS[o.type]}
                      </span>
                    ))}
                    {empPartial.map((lp, lpi) => (
                      <span key={`lp${lpi}`} className="px-2 py-0.5 rounded-full text-[11px] font-medium text-white"
                        style={{ background: '#3b82f6' }}>
                        {DAYS_FR[lp.day]} — {m2t(lp.start_min)}–{m2t(lp.end_min)}
                      </span>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Main planner */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-3 border-b border-slate-100 bg-slate-50/60 flex items-center justify-between">
            <p className="text-xs text-slate-400">Cliquez sur <span className="font-mono text-slate-500">⋯</span> au-dessus d'une colonne pour poser congé</p>
            <p className="text-xs text-slate-400 italic">Cliquer pour ajouter · Glisser · Étirer les bords</p>
          </div>
          {/* Barre de contexte alignée avec WeekPlanner */}
          <div className="flex w-full bg-white">
            <div style={{ width: 40, flexShrink: 0 }} />
            {[1, 2, 3, 4, 5].map(day => (
              <div key={day} className="flex flex-1 border-l border-slate-100">
                {employees.map(emp => (
                  <button key={emp.id}
                    className="flex-1 text-[9px] text-slate-300 hover:text-slate-500 py-1 hover:bg-slate-50 transition-colors border-r border-slate-50 last:border-0"
                    onClick={e => { e.preventDefault(); handleRightClick(e, emp.id, day) }}
                    title={`${fullName(emp)} — ${DAYS_FR[day]} : clic pour congé`}>
                    ⋯
                  </button>
                ))}
              </div>
            ))}
          </div>
          <WeekPlanner
            employees={plannerEmps}
            slots={plannerSlots}
            onChange={handleSlotsChange}
            dayOverlays={plannerOverlays}
            onMarkLeave={(empId, day, type) =>
              type === 'leave_week' ? markLeaveWeek(empId) : markLeave(empId, day, type)
            }
            leavePartialSlots={leavePartialSlots}
            onDeleteLeavePartial={deleteLeavePartial}
            onGridRightClick={handleGridRightClick}
            weekStart={weekStart}
          />
        </div>

        {/* Legend */}
        <div className="flex gap-4 flex-wrap px-2">
          {Object.entries(SLOT_TYPE_LABELS).map(([type, label]) => (
            <div key={type} className="flex items-center gap-1.5 text-xs text-slate-500">
              <div className="w-3 h-3 rounded-full" style={{ background: SLOT_TYPE_COLORS[type] }} />
              {label}
            </div>
          ))}
        </div>

      </div>

      {/* Formulaire congé horaire partiel */}
      {leavePartialForm && (() => {
        const emp = employees.find(e => e.id === leavePartialForm.empId)
        const dayName = DAYS_FR_LONG[leavePartialForm.day]
        const dur = Math.max(0, leavePartialForm.endMin - leavePartialForm.startMin)
        return (
          <div className="fixed z-[200] bg-white border border-blue-200 rounded-2xl shadow-2xl p-4 w-60"
            style={{ left: Math.min(leavePartialForm.x, window.innerWidth - 256), top: Math.min(leavePartialForm.y, window.innerHeight - 220) }}
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-xs font-bold text-slate-700">{emp ? fullName(emp) : ''}</p>
                <p className="text-[10px] text-blue-500 font-semibold uppercase tracking-wide">{dayName} · Congé horaire</p>
              </div>
              <button onClick={() => setLeavePartialForm(null)} className="text-slate-400 hover:text-slate-600 text-lg leading-none">×</button>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-400 w-8">Début</span>
                <input type="time" value={m2t(leavePartialForm.startMin)}
                  onChange={e => setLeavePartialForm(f => f ? { ...f, startMin: t2m(e.target.value) } : null)}
                  className="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200 bg-white" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-400 w-8">Fin</span>
                <input type="time" value={m2t(leavePartialForm.endMin)}
                  onChange={e => setLeavePartialForm(f => f ? { ...f, endMin: t2m(e.target.value) } : null)}
                  className="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200 bg-white" />
              </div>
              {dur > 0 && <p className="text-[10px] text-blue-400 text-center font-medium">{fmtMinutes(dur)} de congé</p>}
            </div>
            <div className="flex gap-2 mt-3">
              <button onClick={() => setLeavePartialForm(null)}
                className="flex-1 px-3 py-1.5 text-xs text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
                Annuler
              </button>
              <button onClick={saveLeavePartial}
                disabled={leavePartialForm.endMin <= leavePartialForm.startMin}
                className="flex-1 px-3 py-1.5 text-xs font-semibold text-white bg-blue-500 rounded-lg hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                Enregistrer
              </button>
            </div>
          </div>
        )
      })()}

      {/* Context menu */}
      {contextMenu && (() => {
        const cmSlots = plannerSlots.filter(s => s.employee_id === contextMenu.empId && s.day === contextMenu.day)
        const hasSlots = cmSlots.length > 0
        const isPauseMode = contextMenu.mode === 'pause'
        return (
          <div className="fixed z-50 bg-white border border-slate-200 rounded-xl shadow-xl py-1 min-w-[200px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={e => e.stopPropagation()}>
            <div className="px-4 py-2 text-xs font-bold text-slate-400 border-b border-slate-100">
              {cmEmp ? fullName(cmEmp) : ''} — {DAYS_FR[contextMenu.day]}
            </div>
            {isPauseMode ? (
              <>
                <div className="px-4 py-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Durée pause</div>
                {[0, 15, 30, 45, 60].map(min => {
                  const isCurrent = (cmSlots[0]?.break_min ?? 0) === min
                  return (
                    <button key={min}
                      onClick={() => setPauseDay(contextMenu.empId, contextMenu.day, min)}
                      className={`w-full text-left px-4 py-1.5 text-xs hover:bg-slate-50 ${isCurrent ? 'font-bold text-indigo-600' : 'text-slate-600'}`}>
                      {isCurrent ? '✓ ' : ''}{min === 0 ? 'Aucune pause' : `${min} min`}
                    </button>
                  )
                })}
                <button onClick={() => setContextMenu(c => c ? { ...c, mode: 'main' } : null)}
                  className="w-full text-left px-4 py-2 text-xs text-slate-400 hover:bg-slate-50 border-t border-slate-100">
                  ← Retour
                </button>
              </>
            ) : (
              <>
                {hasSlots && (
                  <>
                    <button onClick={() => toggleFormationDay(contextMenu.empId, contextMenu.day)}
                      className="w-full text-left px-4 py-2 text-xs text-slate-600 hover:bg-purple-50 hover:text-purple-700">
                      🎓 {cmSlots.every(s => s.is_formation) ? 'Retirer formation' : 'Marquer formation'}
                    </button>
                    <button onClick={() => setContextMenu(c => c ? { ...c, mode: 'pause' } : null)}
                      className="w-full text-left px-4 py-2 text-xs text-slate-600 hover:bg-amber-50 hover:text-amber-700">
                      ☕ Pause{cmSlots[0]?.break_min ? ` (${cmSlots[0].break_min} min)` : ''}
                    </button>
                  </>
                )}
                <button onClick={() => markLeave(contextMenu.empId, contextMenu.day, 'leave_day')}
                  className="w-full text-left px-4 py-2 text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-700">
                  🏖 Congé ce jour
                </button>
                <button onClick={() => markLeaveWeek(contextMenu.empId)}
                  className="w-full text-left px-4 py-2 text-xs text-slate-600 hover:bg-indigo-50 hover:text-indigo-700">
                  📅 Congé toute la semaine
                </button>
                {cmOverride && (
                  <button onClick={() => removeOverride(contextMenu.empId, contextMenu.day)}
                    className="w-full text-left px-4 py-2 text-xs text-red-400 hover:bg-red-50 hover:text-red-600 border-t border-slate-100">
                    ✕ Retirer l'absence
                  </button>
                )}
                <button onClick={() => setContextMenu(null)}
                  className="w-full text-left px-4 py-2 text-xs text-slate-400 hover:bg-slate-50 border-t border-slate-100">
                  Fermer
                </button>
              </>
            )}
          </div>
        )
      })()}

    </div>
  )
}
