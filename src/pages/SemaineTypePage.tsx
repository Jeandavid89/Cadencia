import { useState, useEffect, useRef, useCallback, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import { fmtMinutes } from '../types'
import WeekPlanner, { EMP_COLORS, eff, type PlannerSlot, type PlannerEmployee } from '../components/WeekPlanner'
import { getWeekType, defaultRefMonday } from '../lib/weekUtils'

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

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface Employee {
  id: string; first_name: string; last_name: string
  contract_minutes_per_week: number; formation_minutes_per_week: number
  color_index: number | null
}
interface WeekTarget { employee_id: string; sem_a_minutes: number; sem_b_minutes: number }
interface LissageEntry { id: string; sixthWkMin: number; normalWeeks: number }
interface DBSlot {
  id: string; employee_id: string; week_type: 'A' | 'B'
  day_of_week: number; start_minutes: number; end_minutes: number
  break_minutes: number; is_formation: boolean
}

const fullName = (e: Employee) => `${e.first_name} ${e.last_name}`.trim() || 'Sans nom'
const dbToPlanner = (s: DBSlot): PlannerSlot => ({ id: s.id, employee_id: s.employee_id, day: s.day_of_week, start_min: s.start_minutes, end_min: s.end_minutes, break_min: s.break_minutes, is_formation: s.is_formation })

const DAY_NAMES = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven']

export default function SemaineTypePage() {
  const { user } = useAuthStore()
  const companyId = user?.id ?? ''

  const [employees, setEmployees] = useState<Employee[]>([])
  const [targets, setTargets] = useState<WeekTarget[]>([])
  const [lissageData, setLissageData] = useState<LissageEntry[]>([])
  const [slotsA, setSlotsA] = useState<PlannerSlot[]>([])
  const [slotsB, setSlotsB] = useState<PlannerSlot[]>([])
  const [holidays, setHolidays] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<'A' | 'B'>('A')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [projecting, setProjecting] = useState(false)
  const [projStartDate, setProjStartDate] = useState(() => toDateStr(new Date()))
  const [projEndDate, setProjEndDate] = useState(() => { const y = new Date().getFullYear(); return `${y}-12-31` })
  const [projDone, setProjDone] = useState(false)
  const [refMonday, setRefMonday] = useState<Date>(() => defaultRefMonday(new Date().getFullYear()))
  const [isoRuleLabel, setIsoRuleLabel] = useState<{ A: string; B: string }>({ A: 'sem. ISO paires', B: 'sem. ISO impaires' })

  const saveTimers = useRef<{ A: ReturnType<typeof setTimeout> | null; B: ReturnType<typeof setTimeout> | null }>({ A: null, B: null })
  const stateRef = useRef({ A: slotsA, B: slotsB, employees, holidays })
  stateRef.current = { A: slotsA, B: slotsB, employees, holidays }

  useEffect(() => { if (companyId) load() }, [companyId])

  async function load() {
    const year = new Date().getFullYear()
    const [{ data: emps }, { data: tgts }, { data: dbSlots }, { data: hols }, { data: co }] = await Promise.all([
      supabase.from('employees').select('id,first_name,last_name,contract_minutes_per_week,formation_minutes_per_week,color_index').eq('company_id', companyId).eq('active', true).order('sort_order'),
      supabase.from('week_targets').select('employee_id,sem_a_minutes,sem_b_minutes').eq('company_id', companyId).eq('year', year),
      supabase.from('semaine_type_slots').select('id,employee_id,week_type,day_of_week,start_minutes,end_minutes,break_minutes,is_formation').eq('company_id', companyId),
      supabase.from('public_holidays').select('date').eq('company_id', companyId).eq('year', year),
      supabase.from('companies').select('reference_week_date').eq('id', companyId).single(),
    ])
    const refStr = (co as any)?.reference_week_date as string | null
    const ref = refStr ? new Date(refStr + 'T00:00:00') : defaultRefMonday(year)
    setRefMonday(ref)
    // Déterminer si sem A = ISO paires ou impaires pour cette année
    const jan4 = new Date(year, 0, 4)
    const week1Type = getWeekType(jan4, ref)
    setIsoRuleLabel(week1Type === 'A'
      ? { A: 'sem. ISO impaires', B: 'sem. ISO paires' }
      : { A: 'sem. ISO paires', B: 'sem. ISO impaires' }
    )
    if (emps) setEmployees(emps)
    if (tgts) setTargets(tgts)
    if (hols) setHolidays((hols as { date: string }[]).map(h => h.date))
    if (dbSlots) {
      const all = dbSlots as DBSlot[]
      setSlotsA(all.filter(s => s.week_type === 'A').map(dbToPlanner))
      setSlotsB(all.filter(s => s.week_type === 'B').map(dbToPlanner))
    }
    const lissageSaved = localStorage.getItem(`lissage_${companyId}`)
    if (lissageSaved) {
      try {
        const arr = JSON.parse(lissageSaved)
        setLissageData(arr.map((r: any) => ({ id: r.id, sixthWkMin: r.sixthWkMin ?? 0, normalWeeks: r.normalWeeks ?? 0 })))
      } catch { setLissageData([]) }
    }
    setLoaded(true)
  }

  const scheduleSave = useCallback((weekType: 'A' | 'B', slots: PlannerSlot[]) => {
    if (saveTimers.current[weekType]) clearTimeout(saveTimers.current[weekType]!)
    setSaving(true)
    saveTimers.current[weekType] = setTimeout(async () => {
      try {
        const { error: delErr } = await supabase.from('semaine_type_slots')
          .delete().eq('company_id', companyId).eq('week_type', weekType)
        if (delErr) throw delErr
        if (slots.length > 0) {
          const { error: insErr } = await supabase.from('semaine_type_slots').insert(slots.map(s => ({
            company_id: companyId, employee_id: s.employee_id, week_type: weekType,
            day_of_week: s.day, start_minutes: s.start_min, end_minutes: s.end_min,
            break_minutes: s.break_min, is_formation: s.is_formation ?? false,
          })))
          if (insErr) throw insErr
        }
      } catch (err: unknown) {
        console.error('Erreur sauvegarde semaine type:', err)
        const msg = err && typeof err === 'object' && 'message' in err ? (err as { message: string }).message : JSON.stringify(err)
        alert(`Erreur sauvegarde semaine type:\n${msg}`)
      } finally {
        setSaving(false)
      }
    }, 800)
  }, [companyId])

  function handleChange(wt: 'A' | 'B', slots: PlannerSlot[]) {
    if (wt === 'A') setSlotsA(slots)
    else setSlotsB(slots)
    scheduleSave(wt, slots)
    setProjDone(false)
  }

  async function project() {
    if (!projStartDate || !projEndDate) return
    setProjecting(true); setProjDone(false)
    const { A, B, employees: emps, holidays: hols } = stateRef.current
    const start = getMondayOf(new Date(projStartDate + 'T00:00:00'))
    const end = new Date(projEndDate + 'T23:59:59')
    const holSet = new Set(hols)
    const startStr = toDateStr(start)
    const endStr = toDateStr(end)

    // Charger les congés existants + config remplacements
    const [{ data: leaveData }, { data: replData }] = await Promise.all([
      supabase.from('planning_slots')
        .select('employee_id,date')
        .eq('company_id', companyId)
        .gte('date', startStr).lte('date', endStr)
        .in('slot_type', ['leave_week', 'leave_day']),
      supabase.from('replacement_slots')
        .select('absent_employee_id,present_employee_id,day_of_week,start_minutes,end_minutes,break_minutes,is_formation')
        .eq('company_id', companyId),
    ])
    const leaveSet = new Set((leaveData ?? []).map(s => `${s.employee_id}|${s.date}`))
    const replCfg = replData ?? []

    const weekCur = new Date(start)
    while (weekCur <= end) {
      const weekMon = new Date(weekCur)
      const weekMonStr = toDateStr(weekMon)
      const weekFri = new Date(weekCur); weekFri.setDate(weekCur.getDate() + 4)
      const weekFriStr = toDateStr(weekFri)

      // Pass 1 : identifier absentes et remplaçantes de la semaine
      // absentByDay : jsDay → Set d'IDs d'absentes
      // replacingSet : "empId|date" des remplaçantes actives (ne reçoivent pas d'horaires normaux)
      const absentByDay = new Map<number, Set<string>>()
      const replacingSet = new Set<string>()
      for (let offset = 0; offset <= 4; offset++) {
        const day = new Date(weekMon); day.setDate(weekMon.getDate() + offset)
        if (day > end) break
        const jsDay = day.getDay()
        if (jsDay < 1 || jsDay > 5) continue
        const ds = toDateStr(day)
        if (holSet.has(ds)) continue
        for (const emp of emps) {
          if (leaveSet.has(`${emp.id}|${ds}`)) {
            if (!absentByDay.has(jsDay)) absentByDay.set(jsDay, new Set())
            absentByDay.get(jsDay)!.add(emp.id)
            for (const rs of replCfg.filter(r => r.absent_employee_id === emp.id && r.day_of_week === jsDay)) {
              if (!leaveSet.has(`${rs.present_employee_id}|${ds}`)) {
                replacingSet.add(`${rs.present_employee_id}|${ds}`)
              }
            }
          }
        }
      }

      // Pass 2 : construire les rows
      const rows: Record<string, unknown>[] = []
      for (let offset = 0; offset <= 4; offset++) {
        const day = new Date(weekMon); day.setDate(weekMon.getDate() + offset)
        if (day > end) break
        const jsDay = day.getDay()
        if (jsDay < 1 || jsDay > 5) continue
        const ds = toDateStr(day)
        const wt: 'A' | 'B' = getWeekType(day, refMonday)
        const typeSlots = wt === 'A' ? A : B
        if (holSet.has(ds)) {
          for (const emp of emps) {
            if (!leaveSet.has(`${emp.id}|${ds}`)) {
              rows.push({ company_id: companyId, employee_id: emp.id, date: ds, start_minutes: null, end_minutes: null, break_minutes: 0, slot_type: 'public_holiday' })
            }
          }
        } else {
          for (const emp of emps) {
            const key = `${emp.id}|${ds}`
            if (leaveSet.has(key)) continue // absente : son slot leave_week survit au delete
            if (replacingSet.has(key)) continue // remplaçante : ajoutée juste après
            for (const ts of typeSlots.filter(s => s.employee_id === emp.id && s.day === jsDay)) {
              rows.push({ company_id: companyId, employee_id: emp.id, date: ds, start_minutes: ts.start_min, end_minutes: ts.end_min, break_minutes: ts.break_min, slot_type: ts.is_formation ? 'formation' : 'work' })
            }
          }
          // Slots de remplacement pour ce jour
          const absents = absentByDay.get(jsDay)
          if (absents) {
            for (const absentId of absents) {
              for (const rs of replCfg.filter(r => r.absent_employee_id === absentId && r.day_of_week === jsDay)) {
                if (!leaveSet.has(`${rs.present_employee_id}|${ds}`)) {
                  rows.push({ company_id: companyId, employee_id: rs.present_employee_id, date: ds, start_minutes: rs.start_minutes, end_minutes: rs.end_minutes, break_minutes: rs.break_minutes, slot_type: rs.is_formation ? 'formation' : 'work' })
                }
              }
            }
          }
        }
      }

      // Supprimer PUIS insérer (semaine entière — comme avant)
      const { error: delErr } = await supabase.from('planning_slots').delete()
        .eq('company_id', companyId)
        .gte('date', weekMonStr).lte('date', weekFriStr)
        .in('slot_type', ['work', 'formation', 'public_holiday'])
      if (delErr) {
        setProjecting(false)
        alert(`Erreur semaine du ${weekMonStr} (suppression) : ${delErr.message}`)
        return
      }

      if (rows.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: insErr } = await supabase.from('planning_slots').insert(rows as any[])
        if (insErr) {
          setProjecting(false)
          alert(`Erreur semaine du ${weekMonStr} (insertion) : ${insErr.message}`)
          return
        }
      }

      weekCur.setDate(weekCur.getDate() + 7)
    }

    // Vérification post-génération : tous les jours Lun-Ven sont-ils dans la DB ?
    const { data: verifyData } = await supabase.from('planning_slots')
      .select('date')
      .eq('company_id', companyId)
      .gte('date', startStr).lte('date', endStr)
      .in('slot_type', ['work', 'formation', 'public_holiday'])
      .limit(10000)

    const foundDates = new Set((verifyData ?? []).map(s => s.date as string))
    const missingDates: string[] = []
    const scanDay = new Date(start)
    while (scanDay <= end) {
      const jsDay = scanDay.getDay()
      if (jsDay >= 1 && jsDay <= 5) {
        const ds = toDateStr(scanDay)
        const allOnLeave = emps.length > 0 && emps.every(emp => leaveSet.has(`${emp.id}|${ds}`))
        if (!allOnLeave && !foundDates.has(ds)) missingDates.push(ds)
      }
      scanDay.setDate(scanDay.getDate() + 1)
    }

    setProjecting(false)
    if (missingDates.length > 0) {
      const byWeek = new Map<number, string[]>()
      for (const d of missingDates) {
        const w = getISOWeek(new Date(d + 'T00:00:00'))
        if (!byWeek.has(w)) byWeek.set(w, [])
        byWeek.get(w)!.push(d)
      }
      const lines = [...byWeek.entries()].map(([w, dates]) => `S${w} (${dates[0]} → ${dates[dates.length - 1]})`)
      alert(`⚠ Planning incomplet — ${missingDates.length} jour(s) manquant(s) :\n${lines.join('\n')}\n\nRelancez la génération sur ces semaines.`)
      setProjDone(false)
    } else {
      setProjDone(true)
    }
  }

  const plannerEmps: PlannerEmployee[] = employees.map((e, i) => ({ id: e.id, name: fullName(e), colorIdx: e.color_index ?? i }))
  const getTarget = (empId: string, wt: 'A' | 'B') => { const t = targets.find(x => x.employee_id === empId); return wt === 'A' ? t?.sem_a_minutes : t?.sem_b_minutes }
  const getActual = (empId: string, wt: 'A' | 'B') => (wt === 'A' ? slotsA : slotsB).filter(s => s.employee_id === empId && !s.is_formation).reduce((a, s) => a + eff(s), 0)
  const getActualForm = (empId: string, wt: 'A' | 'B') => (wt === 'A' ? slotsA : slotsB).filter(s => s.employee_id === empId && s.is_formation).reduce((a, s) => a + eff(s), 0)

  if (!loaded) return <div className="flex items-center justify-center h-full"><div className="w-6 h-6 border-2 border-indigo-200 border-t-indigo-500 rounded-full animate-spin" /></div>

  return (
    <div className="min-h-full bg-slate-50">
      <div className="bg-white border-b border-slate-200 px-8 py-4 sticky top-0 z-30 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-slate-800">Semaine Type</h1>
          <p className="text-xs text-slate-400">Définissez les horaires habituels — semaine A ({isoRuleLabel.A}) et B ({isoRuleLabel.B})</p>
        </div>
        {saving && <div className="flex items-center gap-2 text-xs text-slate-400"><div className="w-3.5 h-3.5 border-2 border-slate-200 border-t-indigo-400 rounded-full animate-spin" />Enregistrement…</div>}
      </div>

      <div className="p-8 max-w-6xl space-y-6">

        {/* Cibles */}
        {targets.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 px-6 py-4">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Cibles issues du lissage</p>
            <div className="flex flex-wrap gap-3">
              {employees.map((emp, i) => {
                const c = EMP_COLORS[(emp.color_index ?? i) % EMP_COLORS.length]
                return (
                  <div key={emp.id} className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-slate-50 border border-slate-100">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: c.bg }} />
                    <span className="text-xs font-semibold text-slate-700">{fullName(emp)}</span>
                    {(() => {
                      const tA = getTarget(emp.id, 'A')
                      const tB = getTarget(emp.id, 'B')
                      if (tA === undefined || tB === undefined) return null
                      const aA = getActual(emp.id, 'A')
                      const aB = getActual(emp.id, 'B')
                      const fA = getActualForm(emp.id, 'A')
                      const fB = getActualForm(emp.id, 'B')
                      const actual2w = aA + aB
                      const form2w = fA + fB
                      const target2w = tA + tB
                      const ok = actual2w === target2w
                      return (
                        <span className="flex items-center gap-1">
                          <span className={`px-2 py-0.5 rounded-full text-xs ${ok ? 'bg-emerald-50' : 'bg-slate-100'}`}>
                            <span className={ok ? 'font-bold text-emerald-700' : 'font-normal text-red-500'}>{fmtMinutes(actual2w)}</span>
                            <span className="text-slate-400"> / </span>
                            <span className="font-bold text-slate-700">{fmtMinutes(target2w)}</span>
                            <span className="text-slate-400"> (2 sem.)</span>
                          </span>
                          {form2w > 0 && <span className="text-[10px] italic text-slate-400">+{fmtMinutes(form2w)} form.</span>}
                        </span>
                      )
                    })()}
                    {(['A', 'B'] as const).map(wt => {
                      const t = getTarget(emp.id, wt)
                      const a = getActual(emp.id, wt)
                      const f = getActualForm(emp.id, wt)
                      if (t === undefined) return null
                      const ok = a === t
                      return (
                        <span key={wt} className="flex items-center gap-1">
                          <span className={`px-2 py-0.5 rounded-full text-xs ${ok ? 'bg-emerald-50' : 'bg-slate-100'}`}>
                            <span className="text-slate-400">{wt} : </span>
                            <span className={ok ? 'font-bold text-emerald-700' : 'font-normal text-red-500'}>{fmtMinutes(a)}</span>
                            <span className="text-slate-400"> / </span>
                            <span className="font-bold text-slate-700">{fmtMinutes(t)}</span>
                          </span>
                          {f > 0 && <span className="text-[10px] italic text-slate-400">+{fmtMinutes(f)} form.</span>}
                        </span>
                      )
                    })}
                  </div>
                )
              })}
            </div>
            {employees.some(e => e.formation_minutes_per_week > 0) && (
              <div className="mt-3 flex items-center gap-2 text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
                <span>⚠</span>
                <span>Certains employés ont des heures de formation — cochez "Formation" sur les créneaux concernés</span>
              </div>
            )}
          </div>
        )}

        {/* Planner */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="flex border-b border-slate-100">
            {(['A', 'B'] as const).map(t => (
              <button key={t} onClick={() => setActiveTab(t)}
                className={`flex-1 py-3 text-sm font-semibold transition-colors ${activeTab === t ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}>
                Semaine {t} <span className="text-[11px] font-normal opacity-70">({isoRuleLabel[t]})</span>
              </button>
            ))}
          </div>
          {employees.length === 0
            ? <p className="p-8 text-sm text-slate-400 text-center">Aucun employé — configurez-les dans Administration.</p>
            : <WeekPlanner employees={plannerEmps} slots={activeTab === 'A' ? slotsA : slotsB} onChange={s => handleChange(activeTab, s)} />}
        </div>

        {/* Tableau récap */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/60">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Récapitulatif par jour</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/40">
                  <th className="px-5 py-3 text-left text-slate-400 font-semibold w-40">Employé</th>
                  {(['A', 'B'] as const).map(wt =>
                    [...DAY_NAMES, 'Total'].map((d, di) => (
                      <th key={`${wt}${di}`} className={`px-3 py-3 text-center font-semibold ${d === 'Total' ? 'text-indigo-500 border-r border-slate-200' : 'text-slate-400'}`}>
                        {di === 0 ? <><span className="text-indigo-400 font-bold">Sem {wt} — </span>{d}</> : d}
                      </th>
                    ))
                  )}
                </tr>
              </thead>
              <tbody>
                {employees.map((emp, i) => {
                  const c = EMP_COLORS[(emp.color_index ?? i) % EMP_COLORS.length]
                  return (
                    <tr key={emp.id} className="border-b border-slate-50 hover:bg-slate-50/50">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full" style={{ background: c.bg }} />
                          <span className="font-medium text-slate-700">{fullName(emp)}</span>
                        </div>
                      </td>
                      {(['A', 'B'] as const).map(wt => {
                        const sl = (wt === 'A' ? slotsA : slotsB).filter(s => s.employee_id === emp.id)
                        const days = [1, 2, 3, 4, 5].map(d => sl.filter(s => s.day === d).reduce((a, s) => a + eff(s), 0))
                        const tot = days.reduce((a, x) => a + x, 0)
                        return (
                          <Fragment key={wt}>
                            {days.map((d, di) => (
                              <td key={`${wt}d${di}`} className="px-3 py-3 text-center text-slate-500">
                                {d > 0 ? fmtMinutes(d) : <span className="text-slate-200">—</span>}
                              </td>
                            ))}
                            <td key={`${wt}tot`} className={`px-3 py-3 text-center font-bold border-r border-slate-200 ${tot > 0 ? 'text-indigo-600' : 'text-slate-200'}`}>
                              {tot > 0 ? fmtMinutes(tot) : '—'}
                            </td>
                          </Fragment>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Référence décompte congés */}
        {lissageData.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 bg-amber-50/60">
              <p className="text-xs font-bold text-amber-700 uppercase tracking-widest">Référence décompte congés</p>
              <p className="text-[11px] text-amber-500 mt-0.5">Heures déduites lors de la pose d'un congé (semaine type − capitalisation 6ème semaine)</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/40">
                    <th className="px-5 py-3 text-left text-slate-400 font-semibold w-40">Employé</th>
                    <th className="px-3 py-3 text-center text-slate-400 font-semibold">Base Sem A</th>
                    <th className="px-3 py-3 text-center text-indigo-500 font-semibold border-r border-slate-200">Déduction Sem A</th>
                    <th className="px-3 py-3 text-center text-slate-400 font-semibold">Base Sem B</th>
                    <th className="px-3 py-3 text-center text-violet-500 font-semibold border-r border-slate-200">Déduction Sem B</th>
                    <th className="px-3 py-3 text-center text-amber-500 font-semibold">Capitalisation/sem.</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((emp, i) => {
                    const c = EMP_COLORS[(emp.color_index ?? i) % EMP_COLORS.length]
                    const lis = lissageData.find(r => r.id === emp.id)
                    if (!lis) return null
                    const cap = lis.normalWeeks > 0 ? lis.sixthWkMin / lis.normalWeeks : 0
                    const baseA = getActual(emp.id, 'A')
                    const baseB = getActual(emp.id, 'B')
                    const dedA = Math.max(0, baseA - cap)
                    const dedB = Math.max(0, baseB - cap)
                    return (
                      <tr key={emp.id} className="border-b border-slate-50 hover:bg-slate-50/50">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full" style={{ background: c.bg }} />
                            <span className="font-medium text-slate-700">{fullName(emp)}</span>
                          </div>
                        </td>
                        <td className="px-3 py-3 text-center text-slate-500">{baseA > 0 ? fmtMinutes(baseA) : '—'}</td>
                        <td className="px-3 py-3 text-center font-bold text-indigo-600 border-r border-slate-200">{dedA > 0 ? fmtMinutes(Math.round(dedA)) : '—'}</td>
                        <td className="px-3 py-3 text-center text-slate-500">{baseB > 0 ? fmtMinutes(baseB) : '—'}</td>
                        <td className="px-3 py-3 text-center font-bold text-violet-600 border-r border-slate-200">{dedB > 0 ? fmtMinutes(Math.round(dedB)) : '—'}</td>
                        <td className="px-3 py-3 text-center text-amber-600 font-medium">{cap > 0 ? fmtMinutes(Math.round(cap)) : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Projection */}
        <div className="bg-white rounded-2xl border border-slate-200 p-6">
          <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Projeter sur le planning</p>
          <p className="text-xs text-slate-400 mb-4">Génère le planning réel semaine par semaine (cycle A/B). Les jours fériés sont marqués automatiquement.</p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-slate-500 font-medium">Début</label>
              <input type="date" value={projStartDate} onChange={e => { setProjStartDate(e.target.value); setProjDone(false) }}
                className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-slate-500 font-medium">Jusqu'au</label>
              <input type="date" value={projEndDate} onChange={e => { setProjEndDate(e.target.value); setProjDone(false) }}
                className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
            </div>
            {projStartDate && projEndDate && (() => {
              const ms = new Date(projEndDate).getTime() - new Date(projStartDate).getTime()
              const weeks = ms > 0 ? Math.round(ms / (7 * 86400000)) + 1 : 0
              return weeks > 0 ? (
                <span className="text-xs text-slate-500 bg-slate-50 border border-slate-200 px-3 py-2 rounded-xl">
                  <span className="font-bold text-slate-700">{weeks}</span> semaine{weeks > 1 ? 's' : ''}
                </span>
              ) : null
            })()}
            <button onClick={project} disabled={!projStartDate || !projEndDate || projecting}
              className="px-5 py-2.5 bg-indigo-600 text-white text-xs font-semibold rounded-xl hover:bg-indigo-700 disabled:opacity-40 transition-colors shadow-sm">
              {projecting ? 'Génération…' : 'Générer →'}
            </button>
            {projDone && <span className="text-xs text-emerald-600 font-semibold bg-emerald-50 px-3 py-2 rounded-lg">✓ Planning généré avec succès</span>}
          </div>
        </div>

      </div>
    </div>
  )
}
