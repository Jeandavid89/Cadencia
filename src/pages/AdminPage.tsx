import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import { fmtMinutes } from '../types'
import { EMP_COLORS } from '../components/WeekPlanner'
import { countYearWeeks, defaultRefMonday, toDateStr } from '../lib/weekUtils'

const FRENCH_HOLIDAYS_2026 = [
  { date: '2026-01-01', name: 'Jour de l\'An' },
  { date: '2026-04-06', name: 'Lundi de Pâques' },
  { date: '2026-05-01', name: 'Fête du Travail' },
  { date: '2026-05-08', name: 'Victoire 1945' },
  { date: '2026-05-14', name: 'Ascension' },
  { date: '2026-05-25', name: 'Lundi de Pentecôte' },
  { date: '2026-07-14', name: 'Fête Nationale' },
  { date: '2026-08-15', name: 'Assomption' },
  { date: '2026-11-01', name: 'Toussaint' },
  { date: '2026-11-11', name: 'Armistice' },
  { date: '2026-12-25', name: 'Noël' },
]

const CURRENT_YEAR = new Date().getFullYear()

interface Holiday { id?: string; date: string; name: string }
interface Employee {
  id: string; first_name: string; last_name: string
  contract_minutes_per_week: number; formation_minutes_per_week: number
  leave_minutes_per_year: number; leave_weeks_per_year: number
  entry_date: string; sort_order: number; color_index: number | null
}

function leaveMinutes(emp: Employee) {
  const effective = emp.contract_minutes_per_week - emp.formation_minutes_per_week
  return effective * emp.leave_weeks_per_year
}

function minutesToDisplay(min: number) {
  return `${Math.floor(min / 60)}h${(min % 60).toString().padStart(2, '0')}`
}
function parseHoursInput(val: string): number | null {
  const s = val.trim().replace(',', '.')

  // "7h30" ou "7h"
  const hm = s.match(/^(\d+)h(\d{0,2})$/i)
  if (hm) {
    const h = parseInt(hm[1]), m = hm[2] ? parseInt(hm[2].padEnd(2, '0')) : 0
    return m >= 60 ? null : h * 60 + m
  }
  // "7.30" ou "7,30" → 7h30 (notation horloge)
  const clock = s.match(/^(\d+)\.(\d{2,})$/)
  if (clock) {
    const h = parseInt(clock[1]), m = parseInt(clock[2].slice(0, 2))
    return m >= 60 ? null : h * 60 + m
  }
  // "7.5" → 7h30 (fraction : 0.5 × 60 = 30)
  const frac = s.match(/^(\d+)\.(\d)$/)
  if (frac) {
    return parseInt(frac[1]) * 60 + parseInt(frac[2]) * 6
  }
  // "35" → 35h00
  if (/^\d+$/.test(s)) return parseInt(s) * 60

  return null
}

function MinuteField({ label, initialMinutes, onSave }: {
  label: string; initialMinutes: number; onSave: (m: number) => void
}) {
  const [raw, setRaw] = useState(minutesToDisplay(initialMinutes))
  const [err, setErr] = useState(false)
  useEffect(() => setRaw(minutesToDisplay(initialMinutes)), [initialMinutes])
  function handleBlur() {
    const p = parseHoursInput(raw)
    if (p !== null) { setRaw(minutesToDisplay(p)); setErr(false); onSave(p) } else setErr(true)
  }
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">{label}</label>
      <input
        className={`w-[88px] rounded-xl border px-3 py-2 text-sm text-center font-mono font-medium transition-all focus:outline-none focus:ring-2 ${
          err ? 'border-red-300 bg-red-50 text-red-500 focus:ring-red-200' : 'border-slate-200 bg-white text-slate-700 hover:border-indigo-300 focus:ring-indigo-200 focus:border-indigo-400'
        }`}
        value={raw} placeholder="7h30"
        onChange={e => { setRaw(e.target.value); setErr(false) }}
        onBlur={handleBlur}
      />
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">{children}</h2>
  )
}

export default function AdminPage() {
  const { user } = useAuthStore()
  const companyId = user?.id ?? ''
  const [sixthWeek, setSixthWeek] = useState(false)
  const [holidays, setHolidays] = useState<Holiday[]>([])
  const [newHoliday, setNewHoliday] = useState({ date: '', name: '' })
  const [employees, setEmployees] = useState<Employee[]>([])
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [refDateStr, setRefDateStr] = useState('')
  const [teamValidatedAt, setTeamValidatedAt] = useState<string | null>(null)
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  useEffect(() => {
    if (!companyId) return
    async function load() {
      const [{ data: co }, { data: emps }, { data: hols }] = await Promise.all([
        supabase.from('companies').select('sixth_week,reference_week_date,team_validated_at').eq('id', companyId).single(),
        supabase.from('employees').select('*').eq('company_id', companyId).eq('active', true).order('sort_order'),
        supabase.from('public_holidays').select('*').eq('company_id', companyId).eq('year', CURRENT_YEAR).order('date'),
      ])
      if (co) {
        setSixthWeek((co as any).sixth_week)
        const ref = (co as any).reference_week_date ?? toDateStr(defaultRefMonday(CURRENT_YEAR))
        setRefDateStr(ref)
        setTeamValidatedAt((co as any).team_validated_at ?? null)
      }
      if (emps) setEmployees(emps)
      if (hols && hols.length > 0) setHolidays(hols)
      else {
        const rows = FRENCH_HOLIDAYS_2026.map(h => ({ ...h, company_id: companyId, year: CURRENT_YEAR }))
        const { data } = await supabase.from('public_holidays').insert(rows).select()
        if (data) setHolidays(data)
      }
      setLoaded(true)
    }
    load()
  }, [companyId])

  async function toggleSixthWeek(val: boolean) {
    setSixthWeek(val)
    await supabase.from('companies').update({ sixth_week: val }).eq('id', companyId)
  }

  async function validateTeam() {
    const now = new Date().toISOString()
    setTeamValidatedAt(now)
    await supabase.from('companies').update({ team_validated_at: now }).eq('id', companyId)
  }

  async function invalidateTeam() {
    setTeamValidatedAt(null)
    await supabase.from('companies').update({ team_validated_at: null }).eq('id', companyId)
  }

  async function addHoliday() {
    if (!newHoliday.date || !newHoliday.name) return
    const { data } = await supabase.from('public_holidays')
      .insert({ company_id: companyId, date: newHoliday.date, name: newHoliday.name, year: CURRENT_YEAR })
      .select().single()
    if (data) { setHolidays(p => [...p, data].sort((a,b) => a.date.localeCompare(b.date))); setNewHoliday({ date:'', name:'' }) }
  }

  async function removeHoliday(id: string) {
    await supabase.from('public_holidays').delete().eq('id', id)
    setHolidays(p => p.filter(h => h.id !== id))
  }

  async function addEmployee() {
    const usedColors = new Set(employees.map(e => e.color_index).filter(c => c !== null))
    const autoColor = [0, 1, 2, 3, 4, 5].find(c => !usedColors.has(c)) ?? employees.length % EMP_COLORS.length
    const { data } = await supabase.from('employees').insert({
      company_id: companyId, first_name: '', last_name: '',
      contract_minutes_per_week: 420, formation_minutes_per_week: 0,
      leave_minutes_per_year: 0, leave_weeks_per_year: 5,
      entry_date: `${CURRENT_YEAR}-01-01`, sort_order: employees.length,
      color_index: autoColor,
    }).select().single()
    if (data) { setEmployees(p => [...p, data]); invalidateTeam() }
  }

  async function removeEmployee(id: string) {
    await supabase.from('employees').update({ active: false }).eq('id', id)
    setEmployees(p => p.filter(e => e.id !== id))
    invalidateTeam()
  }

  function saveDebounced(id: string, patch: Partial<Employee>) {
    setEmployees(p => p.map(e => e.id === id ? { ...e, ...patch } : e))
    clearTimeout(timers.current[id])
    timers.current[id] = setTimeout(async () => {
      setSaving(true)
      try {
        const { error } = await supabase.from('employees').update(patch).eq('id', id)
        if (error) throw error
      } catch (err) {
        console.error('Erreur sauvegarde employé:', err)
      } finally {
        setSaving(false)
      }
    }, 600)
  }

  async function saveNow(id: string, patch: Partial<Employee>) {
    setEmployees(p => p.map(e => e.id === id ? { ...e, ...patch } : e))
    clearTimeout(timers.current[id])
    const { error } = await supabase.from('employees').update(patch).eq('id', id)
    if (error) console.error('Erreur sauvegarde employé:', error)
  }

  if (!loaded) return (
    <div className="flex items-center justify-center h-full bg-slate-50">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-indigo-200 border-t-indigo-500 rounded-full animate-spin" />
        <span className="text-sm text-slate-400">Chargement...</span>
      </div>
    </div>
  )

  return (
    <div className="min-h-full bg-slate-50">
      {/* Top bar */}
      <div className="bg-white border-b border-slate-200 px-8 py-4 flex items-center justify-between sticky top-0 z-10">
        <div>
          <h1 className="text-lg font-bold text-slate-800">Administration</h1>
          <p className="text-xs text-slate-400">Paramètres et profils des employés</p>
        </div>
        {saving && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <div className="w-3 h-3 border border-slate-300 border-t-indigo-500 rounded-full animate-spin" />
            Enregistrement...
          </div>
        )}
      </div>

      <div className="p-8 max-w-5xl">
        <div className="grid grid-cols-1 gap-6">

          {/* Paramètres généraux */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/60">
              <SectionTitle>Paramètres généraux</SectionTitle>
            </div>
            <div className="px-6 py-5">
              {/* Toggle 6ème semaine */}
              <button
                onClick={() => toggleSixthWeek(!sixthWeek)}
                className={`flex items-center justify-between w-full p-4 rounded-xl border-2 transition-all text-left ${
                  sixthWeek ? 'border-indigo-200 bg-indigo-50' : 'border-slate-100 bg-slate-50 hover:border-slate-200'
                }`}
              >
                <div>
                  <div className={`text-sm font-semibold ${sixthWeek ? 'text-indigo-700' : 'text-slate-600'}`}>
                    6ème semaine de congé
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">Applicable à tous les employés</div>
                </div>
                <div className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${sixthWeek ? 'bg-indigo-500' : 'bg-slate-300'}`}>
                  <div className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${sixthWeek ? 'translate-x-5' : ''}`} />
                </div>
              </button>
            </div>
          </div>

          {/* Employés */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/60 flex items-center justify-between">
              <SectionTitle>Équipe</SectionTitle>
              <span className="text-xs bg-indigo-100 text-indigo-600 font-semibold px-2.5 py-1 rounded-full">
                {employees.length} {employees.length > 1 ? 'employés' : 'employé'}
              </span>
            </div>
            <div className="px-6 py-5">
              <div className="flex flex-col gap-3">
                {employees.map((emp, idx) => {
                  const initials = `${emp.first_name?.[0] ?? ''}${emp.last_name?.[0] ?? ''}`.toUpperCase() || String(idx + 1)
                  const colorIdx = emp.color_index ?? idx
                  const empColor = EMP_COLORS[colorIdx % EMP_COLORS.length]
                  return (
                    <div key={emp.id} className="border border-slate-100 rounded-2xl p-5 hover:border-indigo-100 hover:bg-indigo-50/20 transition-all group">
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold shadow-sm"
                            style={{ background: empColor.bg }}>
                            {initials}
                          </div>
                          <div>
                            <div className="text-sm font-semibold text-slate-700">
                              {emp.first_name || emp.last_name ? `${emp.first_name} ${emp.last_name}`.trim() : <span className="text-slate-300 font-normal italic">Nouveau profil</span>}
                            </div>
                            <div className="text-[11px] text-slate-400">
                              {emp.contract_minutes_per_week > 0 ? `${minutesToDisplay(emp.contract_minutes_per_week)}/sem.` : '—'}
                            </div>
                          </div>
                        </div>
                        {employees.length > 1 && (
                          <button onClick={() => removeEmployee(emp.id)}
                            className="opacity-0 group-hover:opacity-100 text-xs text-slate-300 hover:text-red-400 transition-all px-3 py-1.5 rounded-lg hover:bg-red-50">
                            Supprimer
                          </button>
                        )}
                      </div>

                      <div className="flex flex-wrap gap-3 items-end">
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">Prénom</label>
                          <input className="border border-slate-200 rounded-xl px-3 py-2 text-sm w-36 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 transition-all"
                            value={emp.first_name}
                            onChange={e => saveDebounced(emp.id, { first_name: e.target.value })}
                            placeholder="Marie" />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">Nom</label>
                          <input className="border border-slate-200 rounded-xl px-3 py-2 text-sm w-36 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 transition-all"
                            value={emp.last_name}
                            onChange={e => saveDebounced(emp.id, { last_name: e.target.value })}
                            placeholder="Dupont" />
                        </div>
                        <MinuteField label="H/sem. contrat" initialMinutes={emp.contract_minutes_per_week}
                          onSave={v => saveNow(emp.id, { contract_minutes_per_week: v })} />
                        <MinuteField label="Formation/sem." initialMinutes={emp.formation_minutes_per_week}
                          onSave={v => saveNow(emp.id, { formation_minutes_per_week: v })} />
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">Semaines congé/an</label>
                          <input
                            type="number" min={0} max={10} step={1}
                            value={emp.leave_weeks_per_year}
                            onChange={e => {
                              const w = parseInt(e.target.value) || 0
                              saveNow(emp.id, { leave_weeks_per_year: w, leave_minutes_per_year: (emp.contract_minutes_per_week - emp.formation_minutes_per_week) * w })
                            }}
                            className="w-[88px] border border-slate-200 rounded-xl px-3 py-2 text-sm text-center font-medium bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 transition-all"
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">Entrée</label>
                          <input type="date" value={emp.entry_date}
                            onChange={e => saveNow(emp.id, { entry_date: e.target.value })}
                            className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 transition-all" />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">Couleur</label>
                          <div className="flex gap-1.5 items-center h-[38px]">
                            {EMP_COLORS.map((c, ci) => (
                              <button key={ci} title={`Couleur ${ci + 1}`}
                                onClick={() => saveNow(emp.id, { color_index: ci })}
                                className="w-6 h-6 rounded-full transition-all hover:scale-110"
                                style={{
                                  background: c.bg,
                                  outline: colorIdx === ci ? `3px solid ${c.bg}` : 'none',
                                  outlineOffset: 2,
                                  opacity: colorIdx === ci ? 1 : 0.45,
                                }}
                              />
                            ))}
                          </div>
                        </div>
                      </div>

                      {emp.contract_minutes_per_week > 0 && (
                        <div className="mt-4 flex gap-2 flex-wrap">
                          <Pill label="Cycle A+B" value={fmtMinutes(emp.contract_minutes_per_week * 2)} />
                          {emp.formation_minutes_per_week > 0 && <Pill label="Formation" value={`${fmtMinutes(emp.formation_minutes_per_week)}/sem.`} accent />}
                          {emp.leave_weeks_per_year > 0 && <Pill label="Congés" value={`${emp.leave_weeks_per_year} sem. = ${fmtMinutes(leaveMinutes(emp))}/an`} />}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <button onClick={addEmployee}
                className="mt-4 flex items-center justify-center gap-2 w-full px-4 py-3 text-sm font-medium text-indigo-500 border-2 border-dashed border-indigo-200 rounded-2xl hover:border-indigo-400 hover:bg-indigo-50 hover:text-indigo-600 transition-all">
                <span className="text-base">+</span> Ajouter un employé
              </button>

              {/* ── Validation équipe ── */}
              {(() => {
                const refMonday = new Date((refDateStr || toDateStr(defaultRefMonday(CURRENT_YEAR))) + 'T00:00:00')
                const { total: T } = countYearWeeks(CURRENT_YEAR, refMonday)
                const N = employees.length
                const L = sixthWeek ? 6 : 5
                const semNormales = T - N * L
                const semRemplacement = (N - 1) * L
                return (
                  <div className={`mt-5 rounded-2xl border-2 p-5 transition-all ${teamValidatedAt ? 'border-emerald-200 bg-emerald-50/50' : 'border-amber-200 bg-amber-50/50'}`}>
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <p className={`text-sm font-bold ${teamValidatedAt ? 'text-emerald-700' : 'text-amber-700'}`}>
                          {teamValidatedAt ? '✓ Équipe validée' : '⚠ Équipe non validée'}
                        </p>
                        {teamValidatedAt && (
                          <p className="text-[11px] text-slate-400 mt-0.5">
                            le {new Date(teamValidatedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}
                          </p>
                        )}
                        {!teamValidatedAt && (
                          <p className="text-[11px] text-amber-600 mt-0.5">Validez l'équipe pour confirmer la répartition des semaines.</p>
                        )}
                      </div>
                      {!teamValidatedAt && N > 0 && semNormales > 0 && (
                        <button onClick={validateTeam}
                          className="px-4 py-2 text-sm font-semibold bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors shadow-sm">
                          Valider l'équipe
                        </button>
                      )}
                      {teamValidatedAt && (
                        <button onClick={invalidateTeam}
                          className="px-3 py-1.5 text-xs font-medium text-slate-400 border border-slate-200 rounded-lg hover:bg-slate-100 transition-colors">
                          Re-valider
                        </button>
                      )}
                    </div>
                    {N > 0 && semNormales > 0 && (
                      <>
                        <div className="grid grid-cols-4 gap-3 text-center">
                          <MiniStat label="Employés" value={`${N}`} />
                          <MiniStat label="Sem. congé / employé" value={`${L}`} sub={sixthWeek ? '5+1 cap.' : '5 légales'} />
                          <MiniStat label="Sem. normales" value={`${semNormales}`} sub={`${T}−${N}×${L}`} accent="indigo" />
                          <MiniStat label="Sem. remplacement" value={`${semRemplacement}`} sub={`(${N}−1)×${L}`} accent="violet" />
                        </div>
                        <p className="text-[11px] text-slate-400 mt-3 text-center">
                          T = {T} sem. pour {CURRENT_YEAR}
                          {T === 53 && <span className="ml-1 text-amber-500 font-semibold">(année à 53 semaines)</span>}
                          {' · '}52 ou 53 selon l'année — voir <span className="text-indigo-500 font-medium">Règles RH</span>
                        </p>
                      </>
                    )}
                  </div>
                )
              })()}
            </div>
          </div>
          {/* Jours fériés */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/60 flex items-center justify-between">
              <SectionTitle>Jours fériés {CURRENT_YEAR}</SectionTitle>
              <span className="text-xs text-slate-400 font-medium">{holidays.length} jours</span>
            </div>
            <div className="px-6 py-5">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-5">
                {holidays.map(h => (
                  <div key={h.id ?? h.date} className="flex items-center justify-between bg-slate-50 border border-slate-100 rounded-xl px-3 py-2.5 group">
                    <div>
                      <div className="text-xs font-semibold text-slate-700">
                        {new Date(h.date + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}
                      </div>
                      <div className="text-[11px] text-slate-400">{h.name}</div>
                    </div>
                    {h.id && (
                      <button onClick={() => removeHoliday(h.id!)}
                        className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-red-400 text-lg leading-none ml-2 transition-all">×</button>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex gap-2 items-end pt-4 border-t border-slate-100">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">Date</label>
                  <input type="date" value={newHoliday.date}
                    onChange={e => setNewHoliday(p => ({ ...p, date: e.target.value }))}
                    className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 bg-white" />
                </div>
                <div className="flex flex-col gap-1.5 flex-1">
                  <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">Nom</label>
                  <input type="text" value={newHoliday.name}
                    onChange={e => setNewHoliday(p => ({ ...p, name: e.target.value }))}
                    onKeyDown={e => e.key === 'Enter' && addHoliday()}
                    placeholder="Ex : Pont du 8 mai"
                    className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 bg-white" />
                </div>
                <button onClick={addHoliday} disabled={!newHoliday.date || !newHoliday.name}
                  className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shadow-sm">
                  + Ajouter
                </button>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}

function MiniStat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: 'indigo' | 'violet' }) {
  const cls = accent === 'indigo' ? 'bg-indigo-50 border-indigo-100 text-indigo-700'
    : accent === 'violet' ? 'bg-violet-50 border-violet-100 text-violet-700'
    : 'bg-white border-slate-100 text-slate-700'
  return (
    <div className={`border rounded-xl px-3 py-2.5 ${cls}`}>
      <p className="text-[10px] font-bold uppercase tracking-widest opacity-50 mb-1 leading-tight">{label}</p>
      <p className="text-xl font-extrabold leading-none">{value}</p>
      {sub && <p className="text-[10px] opacity-40 mt-0.5">{sub}</p>}
    </div>
  )
}

function Pill({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium rounded-full px-3 py-1 ${
      accent ? 'bg-violet-50 text-violet-600 border border-violet-100' : 'bg-slate-100 text-slate-500 border border-slate-200'
    }`}>
      <span className="text-slate-400 font-normal">{label}</span>
      {value}
    </span>
  )
}
