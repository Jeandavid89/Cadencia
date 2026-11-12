import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import { fmtMinutes } from '../types'
import { getWeekType, defaultRefMonday, toDateStr, getMondayOf, getYearWeekMondays } from '../lib/weekUtils'
import { computeSoldeLive } from '../lib/bilanUtils'
import { slotsForDate, isWeekInEmployment } from '../lib/bilanCalc'
import { loadPlanningData } from '../lib/planningData'

interface Employee {
  id: string; first_name: string; last_name: string
  contract_minutes_per_week: number; formation_minutes_per_week: number
  leave_weeks_per_year: number
  entry_date: string; exit_date: string | null
}
interface Row {
  emp: Employee
  T: number              // semaines réelles dans l'année
  effectiveLeave: number
  cible: number          // (T - effectiveLeave) × contrat
  simulatedMin: number   // heures simulées (sem type + remplacement, hors congés)
  holidayMin: number     // fériés tombant sur jours travaillés
  formationMin: number   // formation dans les heures simulées
  solde: number          // simulatedMin - cible + report N-1 (fériés hors solde)
  carryover: number
  carryoverLeave: number
  sixthWkMin: number
  droitConge: number
  leaveMin: number       // congés décomptés (sem type - cap)
  soldeConge: number
  semATotal: number      // total sem type semaine A (hors formation)
  semBTotal: number      // total sem type semaine B (hors formation)
  replWeeksCount: number // nombre de semaines de remplacement effectuées
  replSimMin: number     // heures totales pendant semaines de remplacement
  normalWeeksCount: number
  normalSimMin: number
  normalWeeksCountA: number
  normalSimMinA: number
  normalWeeksCountB: number
  normalSimMinB: number
  replByAbsent: { absentId: string; absentName: string; weeks: number; totalMin: number }[]
  soldeLive: number | null
}
interface SemaineTypeSlot {
  employee_id: string; week_type: 'A' | 'B'; day_of_week: number
  start_minutes: number; end_minutes: number; break_minutes: number; is_formation: boolean
}
interface LeaveSlot { employee_id: string; date: string; slot_type: string; start_minutes?: number | null; end_minutes?: number | null }
interface Carryover { employee_id: string; carryover_minutes: number; carryover_leave_minutes: number }

const fullName = (e: Employee) => `${e.first_name} ${e.last_name}`.trim() || 'Sans nom'
const eff = (start: number, end: number, brk: number) => Math.max(0, end - start - brk)

export default function CalcAnnuelPage() {
  const { user } = useAuthStore()
  const companyId = user?.id ?? ''
  const navigate = useNavigate()

  const [rows, setRows] = useState<Row[]>([])
  const [loaded, setLoaded] = useState(false)
  const [year, setYear] = useState(new Date().getFullYear())
  const [sixthWeek, setSixthWeek] = useState(false)
  const [weekCount, setWeekCount] = useState<number | null>(null)
  const [weekRange, setWeekRange] = useState<{ first: Date; last: Date } | null>(null)
  const [closedForYear, setClosedForYear] = useState(false)
  const [closeStep, setCloseStep] = useState<'idle' | 'confirm' | 'done'>('idle')
  const [closing, setClosing] = useState(false)
  const [confirmUnclose, setConfirmUnclose] = useState(false)
  const [unclosing, setUnclosing] = useState(false)
  const [prevYearOpen, setPrevYearOpen] = useState(false) // bannière rappel

  // Bannière de rappel : année précédente non clôturée, visible tôt dans l'année
  useEffect(() => {
    if (!companyId) return
    const now = new Date()
    if (now.getFullYear() !== year || now.getMonth() > 2) { setPrevYearOpen(false); return } // fenêtre jan-mars
    supabase.from('annual_carryover').select('employee_id').eq('company_id', companyId).eq('year', year - 1)
      .then(({ data }) => setPrevYearOpen(!data || data.length === 0))
  }, [companyId, year])

  async function closeYear() {
    setClosing(true)
    // r.solde et r.soldeConge sont déjà cumulatifs (ils incluent le report
    // entrant de l'année précédente) : ce qu'on archive ici est le solde de
    // fin d'année N, qui devient le report entrant de l'année N+1.
    const rowsToClose = rows.map(r => ({
      company_id: companyId,
      employee_id: r.emp.id,
      year,
      carryover_minutes: Math.round(r.solde),
      carryover_leave_minutes: Math.round(r.soldeConge),
    }))
    const { error } = await supabase.from('annual_carryover').upsert(rowsToClose, { onConflict: 'employee_id,year' })
    setClosing(false)
    if (error) { alert('Erreur lors de la clôture : ' + error.message); return }
    setClosedForYear(true)
    setCloseStep('done')
  }

  async function uncloseYear() {
    setUnclosing(true)
    const { error } = await supabase.from('annual_carryover').delete().eq('company_id', companyId).eq('year', year)
    setUnclosing(false)
    if (error) { alert('Erreur lors de l\'annulation : ' + error.message); return }
    setClosedForYear(false)
    setConfirmUnclose(false)
    setCloseStep('idle')
    load()
  }

  const load = useCallback(async () => {
    setLoaded(false)
    const from = `${year}-01-01`
    const to = `${year}-12-31`

    const [{ data: emps }, { data: hols }, planningData, { data: leaveSlotsRaw }, { data: carryovers }, { data: co }, { data: capRows }, { data: ownClosure }] = await Promise.all([
      // Pas de filtre active=true ici : un employé sorti en cours/avant cette
      // année doit rester visible quand on consulte cette année-là (Prompt 12,
      // bug corrigé - il disparaissait silencieusement des années passées).
      // Le filtrage par fenêtre d'emploi réelle se fait juste en-dessous.
      supabase.from('employees').select('id,first_name,last_name,contract_minutes_per_week,formation_minutes_per_week,leave_weeks_per_year,entry_date,exit_date').eq('company_id', companyId).order('sort_order'),
      supabase.from('public_holidays').select('date').eq('company_id', companyId).eq('year', year),
      loadPlanningData(companyId),
      supabase.from('planning_slots').select('employee_id,date,slot_type,start_minutes,end_minutes').eq('company_id', companyId).gte('date', from).lte('date', to).in('slot_type', ['leave_week', 'leave_day', 'leave_partial']),
      supabase.from('annual_carryover').select('employee_id,carryover_minutes,carryover_leave_minutes').eq('company_id', companyId).eq('year', year - 1),
      supabase.from('companies').select('sixth_week,reference_week_date').eq('id', companyId).single(),
      supabase.from('week_targets').select('employee_id,sixth_week_cap_min').eq('company_id', companyId).eq('year', year),
      supabase.from('annual_carryover').select('employee_id').eq('company_id', companyId).eq('year', year),
    ])
    setClosedForYear((ownClosure ?? []).length > 0)

    const hasSixthWeek: boolean = (co)?.sixth_week ?? false
    setSixthWeek(hasSixthWeek)
    const refStr = (co)?.reference_week_date as string | null
    const refMonday = refStr ? new Date(refStr + 'T00:00:00') : defaultRefMonday(year)

    if (!emps) { setLoaded(true); return }

    // Ne garder que les employés dont la fenêtre d'emploi touche l'année
    // consultée (entrés avant/pendant, et pas sortis avant le 1er janvier) -
    // inclut naturellement les employés actifs (exit_date null) et les
    // anciens employés pertinents pour cette année précise.
    const employees = (emps as Employee[]).filter(e => e.entry_date <= to && (!e.exit_date || e.exit_date >= from))
    const holSet = new Set(((hols ?? []) as { date: string }[]).map(h => h.date))
    const leaveSlots = (leaveSlotsRaw ?? []) as LeaveSlot[]
    const carries = (carryovers ?? []) as Carryover[]
    // Base (planning perpétuel) utilisée pour les totaux purement informatifs
    // (semATotal/semBTotal) qui n'ont pas de date propre - cf. Prompt 11 pour
    // un éventuel sélecteur de période explicite sur cet affichage.
    const basePeriodSlots = planningData.periodSlots.find(ps => ps.period.id === planningData.basePeriodId)
    const baseSemSlots = (basePeriodSlots?.semSlots ?? []) as SemaineTypeSlot[]

    // Taux de cotisation 6e semaine (pour cap congés) - la base fait foi
    // (Prompt 3 : plus de lecture localStorage, cf. ReplacementPage.tsx
    // pour la migration douce des anciens calculs locaux)
    const capMap: Record<string, number> = {}
    for (const r of (capRows ?? []) as { employee_id: string; sixth_week_cap_min: number | null }[]) {
      if (r.sixth_week_cap_min != null) capMap[r.employee_id] = r.sixth_week_cap_min
    }

    // Solde live : même calcul que le Bilan 2026 dans PlanningPage
    const isCurrentYear = year === new Date().getFullYear()
    const soldeLiveMap = isCurrentYear ? await computeSoldeLive(companyId) : {}

    // Semaines de l'année
    const weekMondays: Date[] = getYearWeekMondays(year)
    const T = weekMondays.length
    if (weekMondays.length > 0) {
      const firstMon = weekMondays[0]
      const lastFri = new Date(weekMondays[weekMondays.length - 1])
      lastFri.setDate(lastFri.getDate() + 4)
      setWeekCount(T)
      setWeekRange({ first: firstMon, last: lastFri })
    } else {
      setWeekCount(0)
      setWeekRange(null)
    }

    // Semaines d'absence par employé (leave_week)
    const absentWeeksByEmp: Record<string, Set<string>> = {}
    for (const emp of employees) absentWeeksByEmp[emp.id] = new Set()
    for (const ls of leaveSlots.filter(s => s.slot_type === 'leave_week')) {
      absentWeeksByEmp[ls.employee_id]?.add(toDateStr(getMondayOf(new Date(ls.date + 'T12:00:00'))))
    }

    const result: Row[] = employees.map(emp => {
      // La 6ème semaine est financée par les semaines normales via le lissage → ne pas la
      // soustraire du cible (la simulation l'inclut déjà dans les semaines travaillées).
      const effectiveLeave = emp.leave_weeks_per_year
      const effectiveContract = emp.contract_minutes_per_week - emp.formation_minutes_per_week
      // Semaines complètes dans la fenêtre d'emploi réelle de l'employé
      // (Prompt 12) - un employé entré/sorti en cours d'année a une cible
      // réduite d'autant, sans prorata infra-semaine.
      const employedWeeks = weekMondays.filter(wm => isWeekInEmployment(wm, emp.entry_date, emp.exit_date))
      const T_emp = employedWeeks.length
      const cible = (T_emp - effectiveLeave) * effectiveContract

      const empLeaveSlots = leaveSlots.filter(s => s.employee_id === emp.id)
      const absentWeekMondays = absentWeeksByEmp[emp.id]
      const leaveDayDates = new Set(empLeaveSlots.filter(s => s.slot_type === 'leave_day').map(s => s.date))

      let simulatedMin = 0
      let holidayMin = 0
      let formationMin = 0
      let replWeeksCount = 0
      let replSimMin = 0
      let normalWeeksCount = 0
      let normalSimMin = 0
      let normalWeeksCountA = 0; let normalSimMinA = 0
      let normalWeeksCountB = 0; let normalSimMinB = 0
      const replByAbsent: Record<string, { weeks: Set<string>; totalMin: number }> = {}

      for (const weekMon of weekMondays) {
        if (!isWeekInEmployment(weekMon, emp.entry_date, emp.exit_date)) continue // hors contrat : aucune contribution
        const monKey = toDateStr(weekMon)
        const weekType = getWeekType(weekMon, refMonday)
        const isLeaveWeek = absentWeekMondays.has(monKey)

        // Collègues absents cette semaine (nécessaire même pour semaines de congé)
        const absentColleagues = employees.filter(other =>
          other.id !== emp.id && absentWeeksByEmp[other.id]?.has(monKey)
        )

        let weekIsRepl = false
        let weekReplMin = 0
        let weekNormalMin = 0

        for (let offset = 0; offset <= 4; offset++) {
          const day = new Date(weekMon)
          day.setDate(weekMon.getDate() + offset)
          const ds = toDateStr(day)
          const jsDay = day.getDay()

          const isHoliday = holSet.has(ds)

          // Semaine de congé : seuls les jours fériés sont crédités (assimilés travaillés)
          if (isLeaveWeek && !isHoliday) continue

          // Jour de congé isolé (hors semaine de congé entière)
          if (!isLeaveWeek && leaveDayDates.has(ds)) continue

          // Semaine type/remplacement résolus pour CE jour précis : permet à
          // une période datée de ne couvrir qu'une partie d'une semaine civile.
          const { semSlots: daySemSlots, replSlots: dayReplSlots } = slotsForDate(planningData.periodSlots, day)

          // Remplacement ce jour précis ? (vérifié avant le filtre férié)
          const dayReplMatches = dayReplSlots.filter(r =>
            r.present_employee_id === emp.id &&
            r.day_of_week === jsDay &&
            absentColleagues.some(a => a.id === r.absent_employee_id)
          )

          if (dayReplMatches.length > 0) {
            weekIsRepl = true
            for (const r of dayReplMatches) {
              const mins = eff(r.start_minutes, r.end_minutes, r.break_minutes)
              if (r.is_formation) {
                if (!isLeaveWeek) formationMin += mins
              } else {
                simulatedMin += mins
                if (isHoliday) holidayMin += mins
                if (!isLeaveWeek) {
                  weekReplMin += mins
                  if (!replByAbsent[r.absent_employee_id]) replByAbsent[r.absent_employee_id] = { weeks: new Set(), totalMin: 0 }
                  replByAbsent[r.absent_employee_id].weeks.add(monKey)
                  replByAbsent[r.absent_employee_id].totalMin += mins
                }
              }
            }
          } else {
            // Semaine normale ou férié en semaine de congé : semaine type
            for (const s of daySemSlots.filter(ss => ss.employee_id === emp.id && ss.week_type === weekType && ss.day_of_week === jsDay)) {
              const mins = eff(s.start_minutes, s.end_minutes, s.break_minutes)
              if (s.is_formation) {
                if (!isLeaveWeek) formationMin += mins
              } else {
                simulatedMin += mins
                if (isHoliday) holidayMin += mins
                if (!isLeaveWeek) weekNormalMin += mins
              }
            }
          }
        }

        // Agréger par type de semaine (hors semaines de congé)
        if (!isLeaveWeek) {
          if (weekIsRepl) {
            replWeeksCount++
            replSimMin += weekReplMin + weekNormalMin
          } else {
            normalWeeksCount++
            normalSimMin += weekNormalMin
            if (weekType === 'A') { normalWeeksCountA++; normalSimMinA += weekNormalMin }
            else                  { normalWeeksCountB++; normalSimMinB += weekNormalMin }
          }
        }
      }

      const cEntry = carries.find(c => c.employee_id === emp.id)
      const carryover = cEntry?.carryover_minutes ?? 0
      const carryoverLeave = cEntry?.carryover_leave_minutes ?? 0
      const solde = simulatedMin - cible + carryover

      const replByAbsentArr = Object.entries(replByAbsent)
        .map(([absentId, data]) => {
          const found = employees.find(e => e.id === absentId)
          return { absentId, absentName: found ? fullName(found) : '?', weeks: data.weeks.size, totalMin: data.totalMin }
        })
        .sort((a, b) => b.weeks - a.weeks)

      // Congés payés : décompte basé sur semaine type − cap (pour CongesPage),
      // résolu par la période active à la date du congé (Prompt 9).
      const cap = capMap[emp.id] ?? 0
      const weekTypeTotalForDate = (date: Date, wt: 'A' | 'B') =>
        slotsForDate(planningData.periodSlots, date).semSlots
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
        const dayMin = slotsForDate(planningData.periodSlots, d).semSlots
          .filter(s => s.employee_id === emp.id && s.week_type === wt && s.day_of_week === jsDay && !s.is_formation)
          .reduce((a, s) => a + eff(s.start_minutes, s.end_minutes, s.break_minutes), 0)
        const total = weekTypeTotalForDate(d, wt)
        const k = total > 0 ? (total - cap) / total : 1
        leaveMin += Math.round(dayMin * k)
      }

      // Congés horaires partiels : durée exacte
      for (const ls of empLeaveSlots.filter(s => s.slot_type === 'leave_partial')) {
        if (ls.start_minutes == null || ls.end_minutes == null) continue
        leaveMin += Math.max(0, ls.end_minutes - ls.start_minutes)
      }

      const effectifHebdo = emp.contract_minutes_per_week - emp.formation_minutes_per_week
      const sixthWkMin = hasSixthWeek ? effectifHebdo : 0
      const droitConge = effectifHebdo * emp.leave_weeks_per_year + sixthWkMin + carryoverLeave
      const soldeConge = droitConge - leaveMin

      const semATotal = baseSemSlots.filter(s => s.employee_id === emp.id && s.week_type === 'A' && !s.is_formation && s.start_minutes != null && s.end_minutes != null).reduce((a, s) => a + eff(s.start_minutes, s.end_minutes, s.break_minutes ?? 0), 0)
      const semBTotal = baseSemSlots.filter(s => s.employee_id === emp.id && s.week_type === 'B' && !s.is_formation && s.start_minutes != null && s.end_minutes != null).reduce((a, s) => a + eff(s.start_minutes, s.end_minutes, s.break_minutes ?? 0), 0)

      const soldeLive: number | null = isCurrentYear && soldeLiveMap[emp.id] !== undefined
        ? soldeLiveMap[emp.id]
        : null

      return { emp, T: T_emp, effectiveLeave, cible, simulatedMin, holidayMin, formationMin, solde, carryover, carryoverLeave, sixthWkMin, droitConge, leaveMin, soldeConge, semATotal, semBTotal, replWeeksCount, replSimMin, normalWeeksCount, normalSimMin, normalWeeksCountA, normalSimMinA, normalWeeksCountB, normalSimMinB, replByAbsent: replByAbsentArr, soldeLive }
    })

    setRows(result)
    setLoaded(true)
  }, [companyId, year])

  useEffect(() => { if (companyId) load() }, [companyId, year, load])

  if (!loaded) return <div className="flex items-center justify-center h-full"><div className="w-6 h-6 border-2 border-indigo-200 border-t-indigo-500 rounded-full animate-spin" /></div>

  const EMP_COLORS_LIST = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#0ea5e9']
  const hasFormation = rows.some(r => r.formationMin > 0)
  const hasCarryover = rows.some(r => r.carryover !== 0)

  const signed = (min: number, zeroLabel = 'Équilibré') => ({
    text: min === 0 ? zeroLabel : (min > 0 ? '+' : '−') + fmtMinutes(Math.abs(min)),
    cls: min === 0 ? 'text-emerald-600' : min > 0 ? 'text-amber-600' : 'text-red-500',
  })

  return (
    <div className="min-h-full bg-slate-50">
      <div className="bg-white border-b border-slate-200 px-8 py-4 sticky top-0 z-30 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-slate-800">Calcul Annuel</h1>
          <p className="text-xs text-slate-400">Heures programmées vs objectif contractuel</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/conges')}
            className="px-3 py-1.5 text-xs font-semibold border border-amber-200 rounded-lg bg-amber-50 text-amber-600 hover:bg-amber-100 transition-colors">
            ☀️ Congés →
          </button>
        </div>
      </div>

      <div className="p-8 max-w-6xl space-y-5">
        {prevYearOpen && (
          <div className="px-4 py-3 bg-indigo-50 border border-indigo-200 rounded-xl flex items-center justify-between gap-3">
            <p className="text-xs text-indigo-700">L'année {year - 1} n'a pas encore été clôturée — les soldes ne seront pas reportés sur {year} tant que ce n'est pas fait.</p>
            <button onClick={() => setYear(year - 1)} className="shrink-0 px-3 py-1.5 bg-indigo-600 text-white text-xs font-semibold rounded-lg hover:bg-indigo-700 transition-colors">
              Aller à {year - 1}
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <button onClick={() => setYear(y => y - 1)} className="w-7 h-7 flex items-center justify-center rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-400 text-sm transition-colors">←</button>
            <h2 className="text-3xl font-extrabold text-slate-800">{year}</h2>
            <button onClick={() => setYear(y => y + 1)} className="w-7 h-7 flex items-center justify-center rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-400 text-sm transition-colors">→</button>
          </div>
          {closedForYear ? (
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                Année {year} clôturée
              </span>
              <button onClick={() => setConfirmUnclose(true)}
                className="text-xs text-slate-400 hover:text-red-500 underline transition-colors">
                Annuler
              </button>
            </div>
          ) : (
            <button onClick={() => setCloseStep('confirm')}
              className="px-3 py-1.5 text-xs font-semibold border border-slate-300 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors">
              Clôturer l'année {year}
            </button>
          )}
          {hasCarryover && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-indigo-500 bg-indigo-50 border border-indigo-200 px-3 py-1.5 rounded-full" title={`Report de ${year - 1} inclus dans les soldes ci-dessous`}>
              ↩ Report {year - 1} inclus
            </span>
          )}
          {weekCount !== null && weekRange && (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <span className="font-bold text-slate-700">{weekCount}</span>
              <span>semaines</span>
              <span className="text-slate-300">·</span>
              <span>{weekRange.first.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>
              <span className="text-slate-300">→</span>
              <span>{weekRange.last.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>
            </div>
          )}
        </div>

        {rows.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-sm text-slate-400">
            Aucun employé ou aucune donnée pour {year}.
          </div>
        ) : (<>

          {/* ── Tableau : Résumé année ── */}
          <div className="bg-amber-50 rounded-2xl border border-amber-200 overflow-x-auto">
            <div className="px-6 py-3 bg-amber-200 border-b border-amber-300">
              <p className="text-[11px] font-extrabold text-amber-800 uppercase tracking-widest">Résumé année — Heures de travail</p>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th yellow first rowSpan={2}>Employée</Th>
                  <Th yellow rowSpan={2}>H. Sem<br/>A</Th>
                  <Th yellow rowSpan={2}>H. Sem<br/>B</Th>
                  <Th yellow rowSpan={2}>Total<br/>Normal</Th>
                  <Th yellow center colSpan={rows.length} className="border-b-0">Remplacements</Th>
                  <Th yellow rowSpan={2}>Total<br/>Rempl.</Th>
                  <Th yellow rowSpan={2}>Total<br/>Travaillé</Th>
                  <Th yellow rowSpan={2}>Cible</Th>
                  <Th yellow rowSpan={2}>Solde</Th>
                  <Th yellow rowSpan={2} className="bg-amber-100 border-amber-300">Solde<br/>live</Th>
                </tr>
                <tr>
                  {rows.map(r2 => (
                    <Th yellow key={r2.emp.id} center>{r2.emp.first_name}</Th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-amber-100">
                {rows.map((r, i) => {
                  const totalRepl = r.replByAbsent.reduce((s, ab) => s + ab.totalMin, 0)
                  const theoryA = r.normalWeeksCountA * r.semATotal
                  const theoryB = r.normalWeeksCountB * r.semBTotal
                  const theoryNormal = theoryA + theoryB
                  return (
                    <tr key={r.emp.id} className="hover:bg-amber-100/60">
                      <EmpCell name={fullName(r.emp)} color={EMP_COLORS_LIST[i % 6]} />
                      <Td className="text-right text-slate-600">
                        {fmtMinutes(r.semATotal)}/sem
                        <div className="text-[10px] text-slate-400">{r.normalWeeksCountA}s · {fmtMinutes(theoryA)}</div>
                      </Td>
                      <Td className="text-right text-slate-600">
                        {fmtMinutes(r.semBTotal)}/sem
                        <div className="text-[10px] text-slate-400">{r.normalWeeksCountB}s · {fmtMinutes(theoryB)}</div>
                      </Td>
                      <Td className="text-right text-slate-700 font-semibold">{fmtMinutes(theoryNormal)}</Td>
                      {rows.map(r2 => {
                        if (r2.emp.id === r.emp.id) return <Td key={r2.emp.id} className="text-right text-slate-200">—</Td>
                        const ab = r.replByAbsent.find(a => a.absentId === r2.emp.id)
                        return (
                          <Td key={r2.emp.id} className="text-right text-indigo-600 font-medium">
                            {ab ? (
                              <>
                                {fmtMinutes(ab.totalMin)}
                                <div className="text-[10px] text-indigo-400">{ab.weeks} sem. · {fmtMinutes(Math.round(ab.totalMin / ab.weeks))}/sem</div>
                              </>
                            ) : <span className="text-slate-300">—</span>}
                          </Td>
                        )
                      })}
                      <Td className="text-right text-indigo-700 font-semibold">{totalRepl > 0 ? fmtMinutes(totalRepl) : '—'}</Td>
                      <Td className="text-right font-bold text-emerald-700">{fmtMinutes(r.simulatedMin)}</Td>
                      <Td className="text-right text-slate-600">{fmtMinutes(r.cible)}</Td>
                      {(() => { const s = r.solde; const cls = s > 0 ? 'text-amber-600 font-bold' : s < 0 ? 'text-blue-600 font-bold' : 'text-emerald-600 font-bold'; return <Td className={`text-right ${cls}`}>{s >= 0 ? '+' : '−'}{fmtMinutes(Math.abs(s))}</Td> })()}
                      {r.soldeLive !== null
                        ? (() => { const s = r.soldeLive!; const cls = s > 0 ? 'text-amber-600 font-bold' : s < 0 ? 'text-blue-600 font-bold' : 'text-emerald-600 font-bold'; return (
                            <Td className={`text-right ${cls} bg-amber-100/60`}>
                              {s >= 0 ? '+' : '−'}{fmtMinutes(Math.abs(s))}
                              {r.carryover !== 0 && (
                                <div className="text-[9px] font-normal text-indigo-500" title={`Dont report ${year - 1} : ${r.carryover >= 0 ? '+' : '−'}${fmtMinutes(Math.abs(r.carryover))}`}>
                                  dont report {year - 1}
                                </div>
                              )}
                            </Td>
                          ) })()
                        : <Td className="text-right text-slate-300 bg-amber-100/60">—</Td>
                      }
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* ── Tableau 2 : Congés payés ── */}
          <div className="bg-sky-50 rounded-2xl border border-sky-200 overflow-hidden">
            <div className="px-6 py-3 bg-sky-200 border-b border-sky-300">
              <p className="text-[11px] font-extrabold text-sky-800 uppercase tracking-widest">Congés payés</p>
            </div>
            <table className="w-full">
              <thead>
                <tr>
                  <Th sky first>Employée</Th>
                  <Th sky>Droit légal</Th>
                  {sixthWeek && <Th sky>6ème sem. cap.</Th>}
                  <Th sky>Total droit</Th>
                  <Th sky>Heures posées</Th>
                  <Th sky>Solde congés</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sky-100">
                {rows.map((r, i) => {
                  const sc = signed(r.soldeConge, 'Soldé')
                  return (
                    <tr key={r.emp.id} className="hover:bg-sky-100/60 transition-colors">
                      <EmpCell name={fullName(r.emp)} color={EMP_COLORS_LIST[i % 6]}
                        sub={`${r.emp.leave_weeks_per_year} sem. légales${sixthWeek ? ' + 6ème' : ''}`} />
                      <Td className="text-right text-slate-500">{fmtMinutes((r.emp.contract_minutes_per_week - r.emp.formation_minutes_per_week) * r.emp.leave_weeks_per_year)}</Td>
                      {sixthWeek && <Td className="text-right text-indigo-500 font-semibold">+{fmtMinutes(r.sixthWkMin)}</Td>}
                      <Td className="text-right font-semibold text-slate-700">
                        {fmtMinutes(r.droitConge)}
                        {r.carryoverLeave !== 0 && (
                          <div className="text-[9px] font-normal text-indigo-500" title={`Dont report ${year - 1} : ${r.carryoverLeave >= 0 ? '+' : '−'}${fmtMinutes(Math.abs(r.carryoverLeave))}`}>
                            dont report {year - 1}
                          </div>
                        )}
                      </Td>
                      <Td className="text-right text-blue-600 font-semibold">{r.leaveMin > 0 ? fmtMinutes(r.leaveMin) : '—'}</Td>
                      <Td className={`text-right font-bold ${sc.cls}`}>{sc.text}</Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

        </>)}
      </div>

      {closeStep === 'confirm' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-lg w-full">
            <h3 className="font-bold text-slate-900 text-base mb-1">Clôturer l'année {year} ?</h3>
            <p className="text-sm text-slate-500 mb-1">
              {closedForYear
                ? <>L'année {year} a déjà été clôturée. Relancer <strong>recalcule et remplace</strong> le report archivé.</>
                : <>Les soldes ci-dessous seront archivés et deviendront le report de départ de {year + 1}.</>}
            </p>
            {rows.some(r => r.T === 0) && (
              <p className="text-xs text-amber-600 mb-1">⚠ Certaines employées n'ont aucune donnée de planning pour {year} — vérifiez avant de continuer.</p>
            )}
            <div className="my-4 max-h-56 overflow-y-auto rounded-lg border border-slate-200">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-400 bg-slate-50 border-b border-slate-200">
                    <th className="text-left px-3 py-1.5 font-semibold">Employée</th>
                    <th className="text-right px-3 py-1.5 font-semibold">Solde heures</th>
                    <th className="text-right px-3 py-1.5 font-semibold">Congés restants</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.emp.id} className="border-b border-slate-50 last:border-0">
                      <td className="px-3 py-1.5 text-slate-700">{fullName(r.emp)}</td>
                      <td className={`px-3 py-1.5 text-right font-semibold ${r.solde >= 0 ? 'text-amber-600' : 'text-blue-600'}`}>{r.solde >= 0 ? '+' : '−'}{fmtMinutes(Math.abs(r.solde))}</td>
                      <td className={`px-3 py-1.5 text-right font-semibold ${r.soldeConge >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>{r.soldeConge >= 0 ? '+' : '−'}{fmtMinutes(Math.abs(r.soldeConge))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setCloseStep('idle')} disabled={closing}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
                Annuler
              </button>
              <button onClick={closeYear} disabled={closing}
                className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50">
                {closing ? 'Clôture…' : `Confirmer la clôture de ${year}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {closeStep === 'done' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-sm w-full">
            <h3 className="font-bold text-emerald-700 text-base mb-2">✓ Année {year} clôturée</h3>
            <p className="text-sm text-slate-500 mb-4">Les soldes ont été archivés. L'année {year + 1} démarrera avec ces reports appliqués.</p>
            <button onClick={() => setCloseStep('idle')} className="w-full px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-colors">
              Fermer
            </button>
          </div>
        </div>
      )}

      {confirmUnclose && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-sm w-full">
            <h3 className="font-bold text-slate-900 text-base mb-2">Annuler la clôture de {year} ?</h3>
            <p className="text-sm text-slate-500 mb-4">Le report archivé pour {year} sera supprimé. L'année {year + 1} ne recevra plus ce report tant que {year} n'est pas re-clôturée.</p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setConfirmUnclose(false)} disabled={unclosing}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
                Retour
              </button>
              <button onClick={uncloseYear} disabled={unclosing}
                className="px-4 py-2 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50">
                {unclosing ? 'Suppression…' : 'Annuler la clôture'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const TH_BASE = 'py-2 px-2 text-[10px] font-extrabold uppercase tracking-widest border-b'
function Th({ children, first, center, rowSpan, colSpan, className, yellow, sky }: { children: React.ReactNode; first?: boolean; center?: boolean; rowSpan?: number; colSpan?: number; className?: string; yellow?: boolean; sky?: boolean }) {
  const color = yellow
    ? 'bg-amber-200 border-amber-300 text-amber-800'
    : sky
    ? 'bg-sky-200 border-sky-300 text-sky-800'
    : 'bg-slate-50 border-slate-100 text-slate-500'
  return <th rowSpan={rowSpan} colSpan={colSpan} className={`${TH_BASE} ${color} ${first ? 'text-left' : center ? 'text-center' : 'text-right'} ${className ?? ''}`}>{children}</th>
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`py-2.5 px-2 text-sm whitespace-nowrap ${className ?? ''}`}>{children}</td>
}
function EmpCell({ name, color, sub }: { name: string; color: string; sub?: string }) {
  return (
    <td className="py-2.5 px-2">
      <div className="flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-xl text-white text-xs font-bold flex items-center justify-center shrink-0" style={{ background: color }}>
          {name[0]}
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-700 leading-tight">{name}</p>
          {sub && <p className="text-[10px] text-slate-400 leading-tight">{sub}</p>}
        </div>
      </div>
    </td>
  )
}
