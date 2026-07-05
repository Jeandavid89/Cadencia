import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import { fmtMinutes } from '../types'
import { getWeekType, defaultRefMonday, toDateStr, getMondayOf } from '../lib/weekUtils'

interface Employee {
  id: string; first_name: string; last_name: string
  contract_minutes_per_week: number; formation_minutes_per_week: number
  leave_weeks_per_year: number
}
interface Row {
  emp: Employee
  T: number              // semaines réelles dans l'année
  effectiveLeave: number
  cible: number          // (T - effectiveLeave) × contrat
  simulatedMin: number   // heures simulées (sem type + remplacement, hors congés)
  holidayMin: number     // fériés tombant sur jours travaillés
  formationMin: number   // formation dans les heures simulées
  solde: number          // simulatedMin - cible (fériés hors solde)
  carryover: number
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
}
interface SemaineTypeSlot {
  employee_id: string; week_type: 'A' | 'B'; day_of_week: number
  start_minutes: number; end_minutes: number; break_minutes: number; is_formation: boolean
}
interface LeaveSlot { employee_id: string; date: string; slot_type: string; start_minutes?: number | null; end_minutes?: number | null }
interface ReplacementSlot {
  absent_employee_id: string; present_employee_id: string
  day_of_week: number; start_minutes: number; end_minutes: number
  break_minutes: number; is_formation: boolean
}
interface Carryover { employee_id: string; carryover_minutes: number }
interface LissageEntry { id: string; sixthWkMin: number; normalWeeks: number }

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

  useEffect(() => { if (companyId) load() }, [companyId, year])

  async function load() {
    setLoaded(false)
    const from = `${year}-01-01`
    const to = `${year}-12-31`

    const [{ data: emps }, { data: hols }, { data: stSlots }, { data: leaveSlotsRaw }, { data: replSlotsRaw }, { data: carryovers }, { data: co }] = await Promise.all([
      supabase.from('employees').select('id,first_name,last_name,contract_minutes_per_week,formation_minutes_per_week,leave_weeks_per_year').eq('company_id', companyId).eq('active', true).order('sort_order'),
      supabase.from('public_holidays').select('date').eq('company_id', companyId).eq('year', year),
      supabase.from('semaine_type_slots').select('employee_id,week_type,day_of_week,start_minutes,end_minutes,break_minutes,is_formation').eq('company_id', companyId),
      supabase.from('planning_slots').select('employee_id,date,slot_type,start_minutes,end_minutes').eq('company_id', companyId).gte('date', from).lte('date', to).in('slot_type', ['leave_week', 'leave_day', 'leave_partial']),
      supabase.from('replacement_slots').select('absent_employee_id,present_employee_id,day_of_week,start_minutes,end_minutes,break_minutes,is_formation').eq('company_id', companyId),
      supabase.from('annual_carryover').select('employee_id,carryover_minutes').eq('company_id', companyId).eq('year', year - 1),
      supabase.from('companies').select('sixth_week,reference_week_date').eq('id', companyId).single(),
    ])

    const hasSixthWeek: boolean = (co as any)?.sixth_week ?? false
    setSixthWeek(hasSixthWeek)
    const refStr = (co as any)?.reference_week_date as string | null
    const refMonday = refStr ? new Date(refStr + 'T00:00:00') : defaultRefMonday(year)

    if (!emps) { setLoaded(true); return }

    const employees = emps as Employee[]
    const holSet = new Set(((hols ?? []) as { date: string }[]).map(h => h.date))
    const semSlots = (stSlots ?? []) as SemaineTypeSlot[]
    const leaveSlots = (leaveSlotsRaw ?? []) as LeaveSlot[]
    const replSlots = (replSlotsRaw ?? []) as ReplacementSlot[]
    const carries = (carryovers ?? []) as Carryover[]

    // Lissage depuis localStorage (pour cap congés)
    const lissageSaved = localStorage.getItem(`lissage_${companyId}`)
    const lissageMap: Record<string, LissageEntry> = {}
    if (lissageSaved) {
      try {
        const arr = JSON.parse(lissageSaved) as any[]
        for (const r of arr) lissageMap[r.id] = { id: r.id, sixthWkMin: r.sixthWkMin ?? 0, normalWeeks: r.normalWeeks ?? 0 }
      } catch { /* ignore */ }
    }

    // Semaines de l'année (mêmes que countYearWeeks)
    const weekMondays: Date[] = []
    {
      const seen = new Set<number>()
      const d = new Date(from + 'T00:00:00')
      const end = new Date(to + 'T00:00:00')
      while (d <= end) {
        const dow = d.getDay()
        if (dow >= 1 && dow <= 5) {
          const mon = getMondayOf(new Date(d))
          if (!seen.has(mon.getTime())) {
            seen.add(mon.getTime())
            weekMondays.push(new Date(mon))
          }
        }
        d.setDate(d.getDate() + 1)
      }
    }
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
      const cible = (T - effectiveLeave) * effectiveContract

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

          // Remplacement ce jour précis ? (vérifié avant le filtre férié)
          const dayReplSlots = replSlots.filter(r =>
            r.present_employee_id === emp.id &&
            r.day_of_week === jsDay &&
            absentColleagues.some(a => a.id === r.absent_employee_id)
          )

          if (dayReplSlots.length > 0) {
            weekIsRepl = true
            for (const r of dayReplSlots) {
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
            for (const s of semSlots.filter(ss => ss.employee_id === emp.id && ss.week_type === weekType && ss.day_of_week === jsDay)) {
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

      const solde = simulatedMin - cible

      const replByAbsentArr = Object.entries(replByAbsent)
        .map(([absentId, data]) => {
          const found = employees.find(e => e.id === absentId)
          return { absentId, absentName: found ? fullName(found) : '?', weeks: data.weeks.size, totalMin: data.totalMin }
        })
        .sort((a, b) => b.weeks - a.weeks)

      const carryover = carries.find(c => c.employee_id === emp.id)?.carryover_minutes ?? 0

      // Congés payés : décompte basé sur semaine type − cap (pour CongesPage)
      const lis = lissageMap[emp.id]
      const cap = lis && lis.normalWeeks > 0 ? lis.sixthWkMin / lis.normalWeeks : 0
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

      // Congés horaires partiels : durée exacte
      for (const ls of empLeaveSlots.filter(s => s.slot_type === 'leave_partial')) {
        if (ls.start_minutes == null || ls.end_minutes == null) continue
        leaveMin += Math.max(0, ls.end_minutes - ls.start_minutes)
      }

      const effectifHebdo = emp.contract_minutes_per_week - emp.formation_minutes_per_week
      const sixthWkMin = hasSixthWeek ? effectifHebdo : 0
      const droitConge = effectifHebdo * emp.leave_weeks_per_year + sixthWkMin
      const soldeConge = droitConge - leaveMin

      const semATotal = semSlots.filter(s => s.employee_id === emp.id && s.week_type === 'A' && !s.is_formation && s.start_minutes != null && s.end_minutes != null).reduce((a, s) => a + eff(s.start_minutes, s.end_minutes, s.break_minutes ?? 0), 0)
      const semBTotal = semSlots.filter(s => s.employee_id === emp.id && s.week_type === 'B' && !s.is_formation && s.start_minutes != null && s.end_minutes != null).reduce((a, s) => a + eff(s.start_minutes, s.end_minutes, s.break_minutes ?? 0), 0)

      return { emp, T, effectiveLeave, cible, simulatedMin, holidayMin, formationMin, solde, carryover, sixthWkMin, droitConge, leaveMin, soldeConge, semATotal, semBTotal, replWeeksCount, replSimMin, normalWeeksCount, normalSimMin, normalWeeksCountA, normalSimMinA, normalWeeksCountB, normalSimMinB, replByAbsent: replByAbsentArr }
    })

    setRows(result)
    setLoaded(true)
  }

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
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <button onClick={() => setYear(y => y - 1)} className="w-7 h-7 flex items-center justify-center rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-400 text-sm transition-colors">←</button>
            <h2 className="text-3xl font-extrabold text-slate-800">{year}</h2>
            <button onClick={() => setYear(y => y + 1)} className="w-7 h-7 flex items-center justify-center rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-400 text-sm transition-colors">→</button>
          </div>
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
                      <Td className="text-right font-bold text-emerald-700">{fmtMinutes(theoryNormal + totalRepl)}</Td>
                      <Td className="text-right text-slate-600">{fmtMinutes(r.cible)}</Td>
                      {(() => { const s = theoryNormal + totalRepl - r.cible; const cls = s > 0 ? 'text-amber-600 font-bold' : s < 0 ? 'text-blue-600 font-bold' : 'text-emerald-600 font-bold'; return <Td className={`text-right ${cls}`}>{s >= 0 ? '+' : '−'}{fmtMinutes(Math.abs(s))}</Td> })()}
                      <Td className="text-right text-slate-300 bg-amber-100/60">—</Td>
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
                      <Td className="text-right font-semibold text-slate-700">{fmtMinutes(r.droitConge)}</Td>
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
