import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import { fmtMinutes } from '../types'
import WeekPlanner, { EMP_COLORS, type PlannerSlot, type PlannerEmployee } from '../components/WeekPlanner'
import { countYearWeeks, defaultRefMonday } from '../lib/weekUtils'

interface Employee {
  id: string; first_name: string; last_name: string
  contract_minutes_per_week: number; formation_minutes_per_week: number
  leave_minutes_per_year: number; leave_weeks_per_year: number
  color_index: number | null
}

function fullName(e: Employee) { return `${e.first_name} ${e.last_name}`.trim() || 'Sans nom' }
function eff(e: Employee) { return e.contract_minutes_per_week - e.formation_minutes_per_week }
function slotEff(s: PlannerSlot) { return Math.max(0, s.end_min - s.start_min - s.break_min) }
function fmtAdj(min: number) {
  if (min === 0) return <span className="text-slate-300">0</span>
  const sign = min > 0 ? '+' : '−'
  const abs = Math.abs(min)
  return <span className={min > 0 ? 'text-amber-600 font-semibold' : 'text-emerald-600 font-semibold'}>{sign}{fmtMinutes(abs)}</span>
}

export default function ReplacementPage() {
  const { user } = useAuthStore()
  const companyId = user?.id ?? ''
  const navigate = useNavigate()

  const currentYear = new Date().getFullYear()

  const [employees, setEmployees] = useState<Employee[]>([])
  const [sixthWeek, setSixthWeek] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [yearWeeks, setYearWeeks] = useState<{ nA: number; nB: number; total: number }>(() =>
    countYearWeeks(new Date().getFullYear(), defaultRefMonday(new Date().getFullYear()))
  )

  // Pour chaque employé absent : ses slots de remplacement
  const [planSlots, setPlanSlots] = useState<Record<string, PlannerSlot[]>>({})
  const [leaveWeeks, setLeaveWeeks] = useState<Record<string, number>>({})
  const [computed, setComputed] = useState(false)
  const [stale, setStale] = useState(false)
  const [showExplain, setShowExplain] = useState(false)
  const [results, setResults] = useState<{
    id: string; name: string; normal2w: number; replAnnual: number; sixthWkMin: number; normalWeeks: number; adjustPerCycle: number; semA: number; semB: number; semA_noSixth: number; semB_noSixth: number
  }[]>([])

  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const _uid = useRef(0)
  const resultsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!companyId) return
    async function load() {
      const [{ data: co }, { data: emps }, { data: replSlots }] = await Promise.all([
        supabase.from('companies').select('sixth_week,reference_week_date').eq('id', companyId).single(),
        supabase.from('employees')
          .select('id,first_name,last_name,contract_minutes_per_week,formation_minutes_per_week,leave_minutes_per_year,leave_weeks_per_year,color_index')
          .eq('company_id', companyId).eq('active', true).order('sort_order'),
        supabase.from('replacement_slots')
          .select('absent_employee_id,present_employee_id,day_of_week,start_minutes,end_minutes,break_minutes,is_formation')
          .eq('company_id', companyId),
      ])
      if (co) {
        setSixthWeek(co.sixth_week)
        const year = new Date().getFullYear()
        const ref = co.reference_week_date
          ? new Date(co.reference_week_date + 'T12:00:00')
          : defaultRefMonday(year)
        setYearWeeks(countYearWeeks(year, ref))
      }
      if (emps) {
        setEmployees(emps)
        const initSlots: Record<string, PlannerSlot[]> = {}
        const initLeave: Record<string, number> = {}
        emps.forEach(e => { initSlots[e.id] = []; initLeave[e.id] = e.leave_weeks_per_year ?? 5 })

        // Charger les slots sauvegardés
        if (replSlots) {
          replSlots.forEach((row: { absent_employee_id: string; present_employee_id: string; day_of_week: number; start_minutes: number; end_minutes: number; break_minutes: number; is_formation: boolean }) => {
            if (!initSlots[row.absent_employee_id]) return
            initSlots[row.absent_employee_id].push({
              id: `db_${++_uid.current}`,
              employee_id: row.present_employee_id,
              day: row.day_of_week,
              start_min: row.start_minutes,
              end_min: row.end_minutes,
              break_min: row.break_minutes,
              is_formation: row.is_formation ?? false,
            })
          })
        }

        setPlanSlots(initSlots)
        setLeaveWeeks(initLeave)
      }
      // Restaurer le dernier calcul depuis localStorage
      const saved = localStorage.getItem(`lissage_${companyId}`)
      if (saved) {
        try {
          const data = JSON.parse(saved)
          // Ignorer l'ancien format sans Colonne B (force recalcul)
          if (Array.isArray(data) && data.length > 0 && typeof data[0].semA_noSixth === 'number') {
            setResults(data)
            setComputed(true)
          }
        } catch { /* données corrompues, on ignore */ }
      }
      setLoaded(true)
    }
    load()
  }, [companyId])

  function handleSlotsChange(absentId: string, newSlots: PlannerSlot[]) {
    setPlanSlots(p => ({ ...p, [absentId]: newSlots }))
    setStale(true)

    if (saveTimers.current[absentId]) clearTimeout(saveTimers.current[absentId])
    setSaving(true)
    saveTimers.current[absentId] = setTimeout(async () => {
      try {
        const { error: delErr } = await supabase.from('replacement_slots').delete()
          .eq('company_id', companyId).eq('absent_employee_id', absentId)
        if (delErr) throw delErr
        if (newSlots.length > 0) {
          const { error: insErr } = await supabase.from('replacement_slots').insert(newSlots.map(s => ({
            company_id: companyId,
            absent_employee_id: absentId,
            present_employee_id: s.employee_id,
            day_of_week: s.day,
            start_minutes: s.start_min,
            end_minutes: s.end_min,
            break_minutes: s.break_min,
            is_formation: s.is_formation ?? false,
          })))
          if (insErr) throw insErr
        }
      } catch (err) {
        console.error('Erreur sauvegarde remplacement:', err)
        alert('Erreur lors de la sauvegarde. La table replacement_slots existe-t-elle dans Supabase ?')
      } finally {
        setSaving(false)
      }
    }, 600)
  }

  function getPlannerEmployees(absentId: string): PlannerEmployee[] {
    return employees
      .filter(e => e.id !== absentId)
      .map((e, i) => ({ id: e.id, name: fullName(e), colorIdx: e.color_index ?? i }))
  }

  function getReplWorkHours(absentId: string, presentId: string): number {
    return planSlots[absentId]?.filter(s => s.employee_id === presentId && !s.is_formation).reduce((sum, s) => sum + slotEff(s), 0) ?? 0
  }

  function getReplFormationHours(absentId: string, presentId: string): number {
    return planSlots[absentId]?.filter(s => s.employee_id === presentId && s.is_formation).reduce((sum, s) => sum + slotEff(s), 0) ?? 0
  }

  function compute() {
    const res = employees.map(emp => {
      const effectivePerWeek = eff(emp)
      const normal2w = effectivePerWeek * 2

      // Heures supplémentaires (au-dessus du contrat) + nombre de semaines de remplacement par an
      let replAnnual = 0
      let replWeeksCount = 0
      employees.forEach(absent => {
        if (absent.id === emp.id) return
        const replPerWeek = getReplWorkHours(absent.id, emp.id)
        if (replPerWeek === 0) return
        const extra = replPerWeek - effectivePerWeek
        if (extra > 0) {
          const absentWeeks = (leaveWeeks[absent.id] ?? 0) + (sixthWeek ? 1 : 0)
          replAnnual += extra * absentWeeks
          replWeeksCount += absentWeeks
        }
      })

      const sixthWkMin = sixthWeek ? effectivePerWeek : 0

      // Semaines normales = T − congés propres (6ème incluse si active) − semaines de remplacement
      // C'est sur ces semaines uniquement que s'applique l'ajustement
      const ownLeavePlusSixth = (leaveWeeks[emp.id] ?? 0) + (sixthWeek ? 1 : 0)
      const normalWeeks = Math.max(1, yearWeeks.total - ownLeavePlusSixth - replWeeksCount)

      // Ajustement sur les semaines normales :
      //   6ème sem.     → +heures_contrat / sem. normales  (cotisation pour l'obtenir)
      //   Remplacement  → −heures_supp    / sem. normales  (compenser les pics)
      // Net par cycle (× 2) :
      const adjustPerCycle = Math.round(2 * (sixthWkMin - replAnnual) / normalWeeks)
      const target2w = normal2w + adjustPerCycle

      // Colonne B : sans cotisation 6ème semaine — référence pour le décompte des congés
      // (la 6ème semaine est un gain propre à l'employée ; ses semaines de congé ne doivent pas en bénéficier)
      const ownLeave_B = leaveWeeks[emp.id] ?? 0
      const normalWeeks_B = Math.max(1, yearWeeks.total - ownLeave_B - replWeeksCount)
      const adjustPerCycle_B = Math.round(2 * (0 - replAnnual) / normalWeeks_B)
      const target2w_B = normal2w + adjustPerCycle_B
      const semA_noSixth = Math.ceil(target2w_B / 2)
      const semB_noSixth = Math.floor(target2w_B / 2)

      return {
        id: emp.id,
        name: fullName(emp),
        normal2w,
        replAnnual,
        sixthWkMin,
        normalWeeks,
        adjustPerCycle,
        semA: Math.ceil(target2w / 2),
        semB: Math.floor(target2w / 2),
        semA_noSixth,
        semB_noSixth,
      }
    })
    setResults(res)
    setComputed(true)
    setStale(false)
    localStorage.setItem(`lissage_${companyId}`, JSON.stringify(res))
    setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  async function sendToSemaineType() {
    const year = new Date().getFullYear()
    const rows = results.map(r => ({
      company_id: companyId,
      employee_id: r.id,
      year,
      sem_a_minutes: r.semA,
      sem_b_minutes: r.semB,
      updated_at: new Date().toISOString(),
    }))
    await supabase.from('week_targets').upsert(rows, { onConflict: 'employee_id,year' })

    // Colonne B — nécessite la migration DB (sem_a_no_sixth_minutes, sem_b_no_sixth_minutes)
    const rowsB = results.map(r => ({
      company_id: companyId,
      employee_id: r.id,
      year,
      sem_a_no_sixth_minutes: r.semA_noSixth,
      sem_b_no_sixth_minutes: r.semB_noSixth,
    }))
    await supabase.from('week_targets').upsert(rowsB, { onConflict: 'employee_id,year' })

    navigate('/semaine-type')
  }

  if (!loaded) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-6 h-6 border-2 border-indigo-200 border-t-indigo-500 rounded-full animate-spin" />
    </div>
  )

  if (employees.length === 0) return (
    <div className="p-8 text-sm text-slate-400">Aucun employé configuré — commencez par l'Administration.</div>
  )

  return (
    <div className="min-h-full bg-slate-50">
      <div className="bg-white border-b border-slate-200 px-8 py-4 sticky top-0 z-30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-slate-800">Remplacement & Lissage</h1>
            {saving && <span className="text-xs text-slate-400 animate-pulse">Sauvegarde…</span>}
          </div>
          {!computed && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-slate-400 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0" />
              Lissage non calculé
            </span>
          )}
          {computed && stale && (
            <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-600 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
              À recalculer
            </span>
          )}
          {computed && !stale && (
            <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
              Lissage calculé
            </span>
          )}
        </div>
        <p className="text-xs text-slate-400">Planifiez les semaines de remplacement, puis calculez les cibles de cycle</p>
      </div>

      <div className="p-8 max-w-6xl space-y-6">

        {/* 6ème semaine */}
        <div className={`flex items-center justify-between rounded-xl px-5 py-4 border ${sixthWeek ? 'bg-indigo-50 border-indigo-200' : 'bg-slate-50 border-slate-200'}`}>
          <div>
            <div className={`text-sm font-semibold ${sixthWeek ? 'text-indigo-700' : 'text-slate-500'}`}>6ème semaine de congé auto-financée</div>
            <div className="text-xs text-slate-400 mt-0.5">
              {sixthWeek ? 'Activée — intégrée dans le lissage' : 'Désactivée — à activer dans Administration'}
            </div>
          </div>
          <span className={`text-xs font-bold px-3 py-1 rounded-full ${sixthWeek ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-400'}`}>
            {sixthWeek ? 'ON' : 'OFF'}
          </span>
        </div>

        {/* Un planning par employé absent */}
        {employees.map((absent, absentIdx) => {
          const absentColor = EMP_COLORS[(absent.color_index ?? absentIdx) % EMP_COLORS.length]
          const presentEmps = getPlannerEmployees(absent.id)
          return (
            <div key={absent.id} className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              {/* Header absent */}
              <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/60 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold"
                    style={{ background: absentColor.bg }}>
                    {fullName(absent)[0]}
                  </div>
                  <div>
                    <span className="text-sm font-bold text-slate-700">{fullName(absent)}</span>
                    <span className="ml-2 text-xs text-slate-400">en congé</span>
                    <span className="ml-3 text-xs text-slate-400">·</span>
                    <span className="ml-3 text-xs text-slate-500">{fmtMinutes(eff(absent))}/sem. effectif</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span>Semaines de congé :</span>
                  <input
                    type="number" min={0} max={10} value={leaveWeeks[absent.id] ?? 5}
                    onChange={e => setLeaveWeeks(p => ({ ...p, [absent.id]: parseInt(e.target.value) || 0 }))}
                    className="w-14 border border-slate-200 rounded-lg px-2 py-1 text-sm text-center focus:outline-none focus:ring-2 focus:ring-indigo-200 bg-white"
                  />
                </div>
              </div>

              {/* Totaux temps réel */}
              {presentEmps.length > 0 && (
                <div className="flex flex-wrap gap-3 px-6 py-3 border-b border-slate-100 bg-white">
                  {presentEmps.map(pe => {
                    const c = EMP_COLORS[pe.colorIdx % EMP_COLORS.length]
                    const empObj = employees.find(e => e.id === pe.id)!
                    const normal = eff(empObj)
                    const workTot = getReplWorkHours(absent.id, pe.id)
                    const formTot = getReplFormationHours(absent.id, pe.id)
                    const diff = workTot - normal
                    return (
                      <div key={pe.id} className="flex items-center gap-2.5 px-4 py-2 rounded-xl border"
                        style={{ borderColor: c.bg + '40', background: c.bg + '08' }}>
                        <div className="w-2.5 h-2.5 rounded-full" style={{ background: c.bg }} />
                        <span className="text-xs font-semibold text-slate-600">{pe.name}</span>
                        <span className="text-sm font-black" style={{ color: c.bg }}>{fmtMinutes(workTot)}</span>
                        <span className="text-[10px] text-slate-400">/sem.</span>
                        {formTot > 0 && (
                          <span className="text-[10px] italic text-slate-400">+{fmtMinutes(formTot)} formation</span>
                        )}
                        {diff !== 0 && (
                          <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${diff > 0 ? 'bg-amber-50 text-amber-600' : 'bg-emerald-50 text-emerald-600'}`}>
                            {diff > 0 ? '+' : '−'}{fmtMinutes(Math.abs(diff))}
                          </span>
                        )}
                        {diff === 0 && workTot > 0 && (
                          <span className="text-[10px] text-emerald-500 font-medium">= normal</span>
                        )}
                      </div>
                    )
                  })}
                  {presentEmps.every(pe => getReplWorkHours(absent.id, pe.id) === 0 && getReplFormationHours(absent.id, pe.id) === 0) && (
                    <p className="text-xs text-slate-300 italic">Cliquez dans la grille pour saisir les horaires de remplacement</p>
                  )}
                </div>
              )}

              {/* Planning visuel */}
              <WeekPlanner
                employees={presentEmps}
                slots={planSlots[absent.id] ?? []}
                onChange={newSlots => handleSlotsChange(absent.id, newSlots)}
                showFooter={false}
              />
            </div>
          )
        })}

        {/* Bouton calcul */}
        <div className="flex justify-end items-center gap-4">
          {!computed && (
            <span className="text-xs text-amber-600 font-medium">⚠ Le lissage n'a pas encore été calculé</span>
          )}
          {computed && stale && (
            <span className="text-xs text-amber-600 font-medium">⚠ Le planning a changé — recalcul recommandé</span>
          )}
          {computed && !stale && (
            <span className="text-xs text-emerald-600 font-medium">✓ Lissage à jour</span>
          )}
          <button onClick={compute}
            className="px-6 py-3 bg-indigo-600 text-white text-sm font-semibold rounded-xl hover:bg-indigo-700 transition-colors shadow-sm">
            {computed ? 'Recalculer →' : 'Calculer le lissage →'}
          </button>
        </div>

        {/* Résultats */}
        {computed && (
          <div ref={resultsRef} className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/60 flex items-center justify-between">
              <div>
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Résultats du lissage — {currentYear}</p>
                <p className="text-xs text-slate-400 mt-0.5">{yearWeeks.total} sem. / an · {yearWeeks.nA} sem. A · {yearWeeks.nB} sem. B</p>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={() => setShowExplain(v => !v)}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-500 border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors">
                  <span className="w-4 h-4 rounded-full bg-slate-200 text-slate-600 text-[10px] font-black flex items-center justify-center shrink-0">?</span>
                  {showExplain ? 'Masquer' : 'Comment c\'est calculé ?'}
                </button>
                <button onClick={sendToSemaineType}
                  className="px-4 py-2 bg-emerald-600 text-white text-xs font-semibold rounded-xl hover:bg-emerald-700 transition-colors shadow-sm">
                  Envoyer vers Semaine Type →
                </button>
              </div>
            </div>

            {/* Avertissement si périmé */}
            {stale && (
              <div className="flex items-center gap-3 px-6 py-3 bg-amber-50 border-b border-amber-100">
                <span className="text-amber-500 text-base shrink-0">⚠</span>
                <p className="text-xs text-amber-700">Les horaires de remplacement ont été modifiés — pensez à recalculer le lissage pour mettre les cibles à jour.</p>
                <button onClick={compute} className="ml-auto shrink-0 px-3 py-1.5 bg-amber-500 text-white text-xs font-semibold rounded-lg hover:bg-amber-600 transition-colors">
                  Recalculer →
                </button>
              </div>
            )}

            {/* Explication du calcul */}
            {showExplain && (
              <div className="px-6 py-5 bg-slate-50 border-b border-slate-100 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs text-slate-600">
                <div className="space-y-3">
                  <div className="flex gap-3">
                    <span className="w-5 h-5 rounded-full bg-slate-200 text-slate-600 text-[10px] font-black flex items-center justify-center shrink-0 mt-0.5">1</span>
                    <div>
                      <p className="font-semibold text-slate-700">Cycle normal (2 sem.)</p>
                      <p className="text-slate-400 mt-0.5">Heures de contrat hebdomadaire × 2. Base de référence.</p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <span className="w-5 h-5 rounded-full bg-slate-200 text-slate-600 text-[10px] font-black flex items-center justify-center shrink-0 mt-0.5">2</span>
                    <div>
                      <p className="font-semibold text-slate-700">Supp. remplacement / an</p>
                      <p className="text-slate-400 mt-0.5">Pendant les semaines de remplacement, l'employée travaille <em>plus</em> que son contrat. Cet écart × nombre de semaines d'absence de la collègue{sixthWeek ? ' (congés + 6ème sem.)' : ''} = total annuel des heures supplémentaires.</p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <span className="w-5 h-5 rounded-full bg-slate-200 text-slate-600 text-[10px] font-black flex items-center justify-center shrink-0 mt-0.5">3</span>
                    <div>
                      <p className="font-semibold text-slate-700">Semaines normales</p>
                      <p className="text-slate-400 mt-0.5">{yearWeeks.total} sem. − congés propres{sixthWeek ? ' (6ème incluse)' : ''} − semaines de remplacement. Ce sont les seules semaines où la cible s'applique — ni en congé, ni en remplacement.</p>
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="flex gap-3">
                    <span className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 text-[10px] font-black flex items-center justify-center shrink-0 mt-0.5">4</span>
                    <div>
                      <p className="font-semibold text-slate-700">Ajustement / cycle</p>
                      <p className="text-slate-400 mt-0.5">Deux effets combinés, répartis sur les semaines normales uniquement :</p>
                      {sixthWeek && <p className="text-indigo-500 mt-1">＋ 6ème semaine : chaque employée cotise 1 semaine de ses heures (ex. 35h) répartie sur ses semaines normales → légère hausse de la cible.</p>}
                      <p className="text-amber-600 mt-1">− Remplacement : les semaines de remplacement étant chargées, les semaines normales sont allégées pour que la <strong>moyenne annuelle reste au contrat</strong>.</p>
                      <p className="text-slate-400 mt-1">Formule : (heures 6ème sem. − heures supp. remp.) ÷ sem. normales × 2.</p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <span className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 text-[10px] font-black flex items-center justify-center shrink-0 mt-0.5">5</span>
                    <div>
                      <p className="font-semibold text-slate-700">Cible 2 sem. / Sem. A / Sem. B</p>
                      <p className="text-slate-400 mt-0.5">Cycle normal + ajustement = objectif pour les semaines normales. Pendant les semaines de remplacement, l'employée travaille naturellement plus — c'est ce qui équilibre l'année. Divisé en sem. A et B.</p>
                    </div>
                  </div>
                  {sixthWeek && (
                    <div className="flex gap-3">
                      <span className="w-5 h-5 rounded-full bg-amber-100 text-amber-600 text-[10px] font-black flex items-center justify-center shrink-0 mt-0.5">6</span>
                      <div>
                        <p className="font-semibold text-amber-700">Réf. Congés A / B</p>
                        <p className="text-slate-400 mt-0.5">Cible par semaine <strong>sans</strong> la cotisation 6ème semaine — uniquement l'ajustement remplacement.</p>
                        <p className="text-slate-400 mt-1">C'est cette valeur qui est décomptée du solde de congés lors d'une semaine de congé. Les heures capitalisées pour la 6ème semaine ne sont <em>pas</em> consommées par les congés normaux — elles lui sont réservées.</p>
                        <p className="text-amber-600 mt-1">Exemple Sarah : elle travaille 34h53/sem (avec cotisation ~1h). Quand elle pose une semaine de congé, seules 33h54 sont décomptées.</p>
                      </div>
                    </div>
                  )}
                  <div className="flex gap-3">
                    <span className="w-5 h-5 rounded-full bg-amber-100 text-amber-600 text-[10px] font-black flex items-center justify-center shrink-0 mt-0.5">!</span>
                    <div>
                      <p className="font-semibold text-slate-700">Non pris en compte</p>
                      <p className="text-slate-400 mt-0.5">Les heures de formation, les absences inférieures au contrat normal, et les absences imprévues (maladie, etc.).</p>
                    </div>
                  </div>
                </div>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/40">
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-left text-slate-400">Employé</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-left text-slate-400">Cycle normal</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-left text-slate-400">Supp. remp./an</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-left text-slate-400">Sem. norm.</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-left text-slate-400">Ajust./cycle</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-center text-indigo-500">Cible 2 sem.</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-center text-indigo-500">Col. A sem. A</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-center text-indigo-500">Col. A sem. B</th>
                    {sixthWeek && <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-center text-amber-500">Réf. congés A</th>}
                    {sixthWeek && <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-center text-amber-500">Réf. congés B</th>}
                  </tr>
                </thead>
                <tbody>
                  {results.map(r => (
                    <tr key={r.id} className="border-b border-slate-50 hover:bg-slate-50/50">
                      <td className="px-5 py-4 font-semibold text-slate-700">{r.name}</td>
                      <td className="px-5 py-4 text-slate-500">{fmtMinutes(r.normal2w)}</td>
                      <td className="px-5 py-4">{r.replAnnual > 0 ? <span className="text-amber-600 font-medium">{fmtMinutes(r.replAnnual)}</span> : <span className="text-slate-200">—</span>}</td>
                      <td className="px-5 py-4 text-slate-500">{r.normalWeeks} sem.</td>
                      <td className="px-5 py-4">{fmtAdj(r.adjustPerCycle)}</td>
                      <td className="px-5 py-4 text-center"><span className="bg-slate-100 text-slate-700 font-bold px-3 py-1 rounded-lg">{fmtMinutes(r.semA + r.semB)}</span></td>
                      <td className="px-5 py-4 text-center"><span className="bg-indigo-50 text-indigo-700 font-bold px-3 py-1 rounded-lg">{fmtMinutes(r.semA)}</span></td>
                      <td className="px-5 py-4 text-center"><span className="bg-indigo-50 text-indigo-700 font-bold px-3 py-1 rounded-lg">{fmtMinutes(r.semB)}</span></td>
                      {sixthWeek && <td className="px-5 py-4 text-center"><span className="bg-amber-50 text-amber-700 font-bold px-3 py-1 rounded-lg">{fmtMinutes(r.semA_noSixth ?? 0)}</span></td>}
                      {sixthWeek && <td className="px-5 py-4 text-center"><span className="bg-amber-50 text-amber-700 font-bold px-3 py-1 rounded-lg">{fmtMinutes(r.semB_noSixth ?? 0)}</span></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
