import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import { findOverlappingPeriod, type PlanningPeriod } from '../lib/periods'

const PERIOD_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#0ea5e9']
const MONTHS_FR = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc']

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d} ${MONTHS_FR[m - 1]} ${y}`
}

function dayOfYear(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  const start = Date.UTC(y, 0, 1)
  const cur = Date.UTC(y, m - 1, d)
  return Math.round((cur - start) / 86400000) + 1
}

function CycleModeToggle({ period, onChange }: { period: PlanningPeriod; onChange: (mode: 'ab' | 'single') => void }) {
  return (
    <div className="flex items-center text-[11px] font-semibold border border-slate-200 rounded-lg overflow-hidden" title="Cycle A/B alterné ou une seule semaine type répétée chaque semaine">
      <button onClick={() => onChange('ab')}
        className={`px-2 py-1.5 transition-colors ${period.cycleMode === 'ab' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>
        A/B
      </button>
      <button onClick={() => onChange('single')}
        className={`px-2 py-1.5 transition-colors ${period.cycleMode === 'single' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>
        1 semaine
      </button>
    </div>
  )
}

export default function PeriodesPage() {
  const { user } = useAuthStore()
  const companyId = user?.id ?? ''
  const navigate = useNavigate()

  const [year, setYear] = useState(new Date().getFullYear())
  const [periods, setPeriods] = useState<PlanningPeriod[]>([])
  const [loaded, setLoaded] = useState(false)
  const [yearClosed, setYearClosed] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newStart, setNewStart] = useState('')
  const [newEnd, setNewEnd] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoaded(false)
    const [{ data: periodsRaw }, { data: closure }] = await Promise.all([
      supabase.from('planning_periods').select('id,company_id,label,is_base,start_date,end_date,cycle_mode').eq('company_id', companyId),
      supabase.from('annual_carryover').select('employee_id').eq('company_id', companyId).eq('year', year).limit(1),
    ])
    const all: PlanningPeriod[] = ((periodsRaw ?? []) as { id: string; company_id: string; label: string; is_base: boolean; start_date: string | null; end_date: string | null; cycle_mode: 'ab' | 'single' }[])
      .map(p => ({ id: p.id, companyId: p.company_id, label: p.label, isBase: p.is_base, startDate: p.start_date, endDate: p.end_date, cycleMode: p.cycle_mode }))
    setPeriods(all)
    setYearClosed((closure ?? []).length > 0)
    setLoaded(true)
  }, [companyId, year])

  useEffect(() => { if (companyId) load() }, [companyId, year, load])

  const yearPeriods = periods.filter(p => !p.isBase && p.startDate?.startsWith(String(year)))
  const basePeriod = periods.find(p => p.isBase)

  function resetForm() {
    setCreating(false); setNewLabel(''); setNewStart(''); setNewEnd(''); setFormError(null)
  }

  async function submitNewPeriod() {
    setFormError(null)
    if (!newLabel.trim()) { setFormError('Le libellé est obligatoire.'); return }
    if (!newStart || !newEnd) { setFormError('Les deux dates sont obligatoires.'); return }
    if (newStart > newEnd) { setFormError('La date de début doit précéder la date de fin.'); return }
    if (newStart.slice(0, 4) !== newEnd.slice(0, 4)) { setFormError('Une période doit tenir entièrement dans une seule année civile.'); return }
    if (Number(newStart.slice(0, 4)) !== year) { setFormError(`Les dates doivent être sur l'année ${year} affichée.`); return }

    const overlap = findOverlappingPeriod(periods, { startDate: newStart, endDate: newEnd })
    if (overlap) { setFormError(`Cette période chevauche « ${overlap.label} » (du ${fmtDate(overlap.startDate!)} au ${fmtDate(overlap.endDate!)}).`); return }

    if (yearClosed) { setFormError(`L'année ${year} est déjà clôturée — impossible de créer une période sur cette année.`); return }

    setSaving(true)
    const { error } = await supabase.from('planning_periods').insert({
      company_id: companyId, label: newLabel.trim(), start_date: newStart, end_date: newEnd,
    })
    setSaving(false)
    if (error) {
      // Filets de sécurité DB (contrainte d'exclusion / trigger année clôturée)
      if (error.code === '23P01') setFormError('Cette période chevauche une période existante.')
      else if (error.message.includes('planning_period_year_closed')) setFormError(`L'année ${year} est déjà clôturée — impossible de créer une période sur cette année.`)
      else setFormError('Erreur lors de la création : ' + error.message)
      return
    }
    resetForm()
    load()
  }

  // Bascule pure (Prompt 13 bis) : B n'est jamais lu ni écrit en mode
  // "single" (cf. effectiveWeekType dans les modèles de calcul) - aucune
  // duplication/écrasement ici, pour que l'aller-retour A/B <-> semaine
  // unique soit toujours réversible sans perte.
  async function setCycleMode(period: PlanningPeriod, mode: 'ab' | 'single') {
    if (period.cycleMode === mode) return
    const { error } = await supabase.from('planning_periods').update({ cycle_mode: mode }).eq('id', period.id)
    if (error) { alert('Erreur : ' + error.message); return }
    load()
  }

  async function deletePeriod(id: string) {
    setDeletingId(id)
    const { error } = await supabase.from('planning_periods').delete().eq('id', id)
    setDeletingId(null)
    if (error) { alert('Erreur lors de la suppression : ' + error.message); return }
    load()
  }

  if (!loaded) return <div className="flex items-center justify-center h-full"><div className="w-6 h-6 border-2 border-indigo-200 border-t-indigo-500 rounded-full animate-spin" /></div>

  return (
    <div className="min-h-full bg-slate-50">
      <div className="bg-white border-b border-slate-200 px-8 py-4 sticky top-0 z-30">
        <div>
          <h1 className="text-lg font-bold text-slate-800">Périodes de planning</h1>
          <p className="text-xs text-slate-400">Définissez des semaines types et remplacements différents sur une fenêtre de dates précise, en plus du planning de base valable toute l'année.</p>
        </div>
      </div>

      <div className="p-8 max-w-5xl space-y-6">
        <div className="flex items-center gap-2">
          <button onClick={() => setYear(y => y - 1)} className="w-7 h-7 flex items-center justify-center rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-400 text-sm transition-colors">←</button>
          <h2 className="text-2xl font-extrabold text-slate-800">{year}</h2>
          <button onClick={() => setYear(y => y + 1)} className="w-7 h-7 flex items-center justify-center rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-400 text-sm transition-colors">→</button>
          {yearClosed && (
            <span className="ml-2 flex items-center gap-1.5 text-xs font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
              Année clôturée — aucune nouvelle période possible
            </span>
          )}
        </div>

        {/* Timeline */}
        <div className="bg-white rounded-2xl border border-slate-200 p-6">
          <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Vue d'ensemble de l'année</p>
          <div className="relative h-10 rounded-lg bg-slate-100 overflow-hidden">
            <div className="absolute inset-0 flex items-center px-2 text-[10px] text-slate-400 font-medium">Planning de base</div>
            {yearPeriods.map((p, i) => {
              const totalDays = (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 366 : 365
              const left = ((dayOfYear(p.startDate!) - 1) / totalDays) * 100
              const width = ((dayOfYear(p.endDate!) - dayOfYear(p.startDate!) + 1) / totalDays) * 100
              const color = PERIOD_COLORS[i % PERIOD_COLORS.length]
              return (
                <div key={p.id} title={`${p.label} (${fmtDate(p.startDate!)} → ${fmtDate(p.endDate!)})`}
                  className="absolute inset-y-0 flex items-center justify-center text-[10px] font-semibold text-white overflow-hidden"
                  style={{ left: `${left}%`, width: `${width}%`, background: color }}>
                  <span className="truncate px-1">{p.label}</span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Liste */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/60 flex items-center justify-between">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Périodes de {year}</p>
            {!creating && !yearClosed && (
              <button onClick={() => setCreating(true)}
                className="px-3 py-1.5 bg-indigo-600 text-white text-xs font-semibold rounded-lg hover:bg-indigo-700 transition-colors">
                + Nouvelle période
              </button>
            )}
          </div>

          {creating && (
            <div className="px-6 py-5 border-b border-slate-100 bg-indigo-50/40 space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-slate-500 font-medium">Libellé</label>
                  <input type="text" value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Ex. Horaires d'été"
                    className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 w-56" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-slate-500 font-medium">Début</label>
                  <input type="date" value={newStart} onChange={e => setNewStart(e.target.value)}
                    className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-slate-500 font-medium">Fin</label>
                  <input type="date" value={newEnd} onChange={e => setNewEnd(e.target.value)}
                    className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
                </div>
                <button onClick={submitNewPeriod} disabled={saving}
                  className="px-4 py-2 bg-indigo-600 text-white text-xs font-semibold rounded-xl hover:bg-indigo-700 disabled:opacity-40 transition-colors">
                  {saving ? 'Création…' : 'Créer'}
                </button>
                <button onClick={resetForm} className="px-4 py-2 text-xs font-semibold text-slate-500 hover:text-slate-700 transition-colors">
                  Annuler
                </button>
              </div>
              {formError && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{formError}</p>}
            </div>
          )}

          <div className="divide-y divide-slate-50">
            <div className="px-6 py-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-700">{basePeriod?.label ?? 'Planning de base'}</p>
                <p className="text-xs text-slate-400">Toute l'année, en dehors de toute période ci-dessous</p>
              </div>
              <div className="flex items-center gap-2">
                {basePeriod && <CycleModeToggle period={basePeriod} onChange={m => setCycleMode(basePeriod, m)} />}
                <button onClick={() => navigate(`/semaine-type${basePeriod ? `?period=${basePeriod.id}` : ''}`)}
                  className="px-3 py-1.5 text-xs font-semibold border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 transition-colors">
                  Semaine type →
                </button>
                <button onClick={() => navigate(`/remplacement${basePeriod ? `?period=${basePeriod.id}` : ''}`)}
                  className="px-3 py-1.5 text-xs font-semibold border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 transition-colors">
                  Remplacements →
                </button>
              </div>
            </div>

            {yearPeriods.length === 0 && (
              <div className="px-6 py-8 text-center text-sm text-slate-400">Aucune période spécifique sur {year} — seul le planning de base s'applique.</div>
            )}

            {yearPeriods.map((p, i) => (
              <div key={p.id} className="px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: PERIOD_COLORS[i % PERIOD_COLORS.length] }} />
                  <div>
                    <p className="text-sm font-semibold text-slate-700">{p.label}</p>
                    <p className="text-xs text-slate-400">{fmtDate(p.startDate!)} → {fmtDate(p.endDate!)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <CycleModeToggle period={p} onChange={m => setCycleMode(p, m)} />
                  <button onClick={() => navigate(`/semaine-type?period=${p.id}`)}
                    className="px-3 py-1.5 text-xs font-semibold border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 transition-colors">
                    Semaine type →
                  </button>
                  <button onClick={() => navigate(`/remplacement?period=${p.id}`)}
                    className="px-3 py-1.5 text-xs font-semibold border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 transition-colors">
                    Remplacements →
                  </button>
                  <button onClick={() => { if (confirm(`Supprimer « ${p.label} » ? La semaine type et les remplacements propres à cette période seront définitivement perdus.`)) deletePeriod(p.id) }}
                    disabled={deletingId === p.id}
                    className="px-2 py-1.5 text-xs text-slate-300 hover:text-red-500 transition-colors disabled:opacity-40">
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
