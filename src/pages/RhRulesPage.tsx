import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import { getMondayOf, toDateStr, getWeekType, countYearWeeks, defaultRefMonday } from '../lib/weekUtils'

interface YearRow {
  year: number
  nA: number
  nB: number
  isoRule: string
  totalWeeks: number
}

function computeYearRow(year: number, refMonday: Date): YearRow {
  const { nA, nB, total } = countYearWeeks(year, refMonday)
  const jan4 = new Date(year, 0, 4)
  const week1Type = getWeekType(jan4, refMonday)
  const isoRule = week1Type === 'A' ? 'Sem A = ISO impaires' : 'Sem A = ISO paires'
  return { year, nA, nB, isoRule, totalWeeks: total }
}

export default function RhRulesPage() {
  const { user } = useAuthStore()
  const companyId = user?.id ?? ''
  const currentYear = new Date().getFullYear()

  const [loaded, setLoaded] = useState(false)
  const [refDate, setRefDate] = useState('')
  const [sixthWeek, setSixthWeek] = useState(false)
  const [saving, setSaving] = useState(false)
  const [yearRows, setYearRows] = useState<YearRow[]>([])
  const [windowStart, setWindowStart] = useState(currentYear - 1)
  const [employeeCount, setEmployeeCount] = useState(0)
  const [teamValidatedAt, setTeamValidatedAt] = useState<string | null>(null)

  useEffect(() => { if (companyId) load() }, [companyId])

  async function load() {
    const [{ data: co }, { count }] = await Promise.all([
      supabase.from('companies').select('reference_week_date,sixth_week,team_validated_at').eq('id', companyId).single(),
      supabase.from('employees').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('active', true),
    ])
    let ref = (co as any)?.reference_week_date as string | null
    if (!ref) ref = toDateStr(defaultRefMonday(currentYear))
    setRefDate(ref)
    setSixthWeek((co as any)?.sixth_week ?? false)
    setTeamValidatedAt((co as any)?.team_validated_at ?? null)
    setEmployeeCount(count ?? 0)
    setLoaded(true)
  }

  useEffect(() => {
    if (!refDate) return
    const refMonday = new Date(refDate + 'T00:00:00')
    const rows: YearRow[] = []
    for (let y = currentYear - 1; y <= 2070; y++) rows.push(computeYearRow(y, refMonday))
    setYearRows(rows)
  }, [refDate])

  async function saveRefDate(val: string) {
    if (!val) return
    const mon = getMondayOf(new Date(val + 'T00:00:00'))
    const mondayStr = toDateStr(mon)
    setRefDate(mondayStr)
    setSaving(true)
    await supabase.from('companies').update({ reference_week_date: mondayStr }).eq('id', companyId)
    setSaving(false)
  }

  async function toggleSixthWeek(val: boolean) {
    setSixthWeek(val)
    await supabase.from('companies').update({ sixth_week: val }).eq('id', companyId)
  }

  if (!loaded) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-6 h-6 border-2 border-indigo-200 border-t-indigo-500 rounded-full animate-spin" />
    </div>
  )

  const refMonday = new Date(refDate + 'T00:00:00')
  const { total: T } = countYearWeeks(currentYear, refMonday)
  const N = employeeCount
  const L = sixthWeek ? 6 : 5
  const semNormales = T - N * L
  const semRemplacement = (N - 1) * L
  const semConge = L
  const isValid = semNormales > 0

  return (
    <div className="min-h-full bg-slate-50">
      <div className="bg-white border-b border-slate-200 px-8 py-4 sticky top-0 z-30 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-slate-800">Règles RH</h1>
          <p className="text-xs text-slate-400">Paramètres de planification et règles de calcul</p>
        </div>
        {saving && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <div className="w-3 h-3 border border-slate-300 border-t-indigo-500 rounded-full animate-spin" />
            Enregistrement...
          </div>
        )}
      </div>

      <div className="p-8 max-w-4xl space-y-6">

        {/* ── Cycle A/B ── */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/60">
            <SectionTitle>Cycle A / B — Semaine de référence</SectionTitle>
          </div>
          <div className="px-6 py-5 space-y-5">
            <p className="text-sm text-slate-500 leading-relaxed">
              Choisissez le lundi qui définit la <span className="font-semibold text-indigo-600">Semaine A</span> de référence.
              Le logiciel calcule automatiquement le type de chaque semaine pour toutes les années.
              Si la date choisie n'est pas un lundi, elle est ajustée au lundi de cette semaine.
            </p>
            <div className="flex items-end gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">Lundi de référence — Semaine A</label>
                <input type="date" value={refDate} onChange={e => saveRefDate(e.target.value)}
                  className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 transition-all" />
              </div>
              {refDate && (
                <p className="text-sm text-slate-400 pb-2">
                  → <span className="font-medium text-indigo-600">Sem A</span> à partir du{' '}
                  {new Date(refDate + 'T00:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                </p>
              )}
            </div>

            {yearRows.length > 0 && (() => {
              const visible = yearRows.filter(r => r.year >= windowStart && r.year < windowStart + 5)
              const canPrev = windowStart > currentYear - 1
              const canNext = windowStart + 5 <= 2070
              return (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <button onClick={() => setWindowStart(w => Math.max(currentYear - 1, w - 1))} disabled={!canPrev}
                      className="w-7 h-7 flex items-center justify-center rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-400 text-sm transition-colors disabled:opacity-30">←</button>
                    <span className="text-xs text-slate-400">{windowStart} – {windowStart + 4}</span>
                    <button onClick={() => setWindowStart(w => Math.min(2066, w + 1))} disabled={!canNext}
                      className="w-7 h-7 flex items-center justify-center rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-400 text-sm transition-colors disabled:opacity-30">→</button>
                  </div>
                  <div className="rounded-xl overflow-hidden border border-slate-100">
                    <table className="w-full">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-100">
                          <Th first>Année</Th>
                          <Th>Sem A</Th>
                          <Th>Sem B</Th>
                          <Th>Total</Th>
                          <Th>Règle ISO</Th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {visible.map(r => (
                          <tr key={r.year} className={r.year === currentYear ? 'bg-indigo-50/40' : 'hover:bg-slate-50/60 transition-colors'}>
                            <td className="px-4 py-3 text-sm font-semibold text-slate-700">
                              {r.year}
                              {r.year === currentYear && <span className="ml-2 text-[10px] bg-indigo-100 text-indigo-600 font-bold px-1.5 py-0.5 rounded">Actuel</span>}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className="inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700">{r.nA} sem.</span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className="inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold bg-violet-100 text-violet-700">{r.nB} sem.</span>
                            </td>
                            <td className="px-4 py-3 text-center text-sm font-medium text-slate-600">
                              {r.totalWeeks}
                              {r.totalWeeks === 53 && <span className="ml-1.5 text-[10px] bg-amber-100 text-amber-600 font-bold px-1.5 py-0.5 rounded">53 sem.</span>}
                            </td>
                            <td className="px-4 py-3 text-xs text-slate-400">{r.isoRule}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })()}
          </div>
        </div>

        {/* ── Répartition annuelle ── */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/60 flex items-center justify-between">
            <SectionTitle>Répartition annuelle des semaines</SectionTitle>
            {teamValidatedAt && (
              <span className="text-[10px] text-emerald-600 font-semibold bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full">
                Équipe validée
              </span>
            )}
          </div>
          <div className="px-6 py-5 space-y-5">
            <div className="grid grid-cols-3 gap-3 text-sm text-slate-500">
              <FormulaBox label="N — Employés" value={`${N}`} sub="issu de l'Administration" />
              <FormulaBox label="L — Sem. congé/employé" value={`${L}`} sub={sixthWeek ? '5 légales + 1 capitalisée' : '5 légales'} />
              <FormulaBox label="T — Sem. dans l'année" value={`${T}`} sub={`${currentYear} · depuis la référence`} />
            </div>

            {N === 0 ? (
              <p className="text-sm text-amber-600 bg-amber-50 border border-amber-100 rounded-xl px-4 py-3">
                Aucun employé enregistré. Validez d'abord l'équipe dans Administration.
              </p>
            ) : !isValid ? (
              <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3">
                Configuration incohérente : N × L ({N} × {L} = {N * L}) dépasse T ({T}). Réduisez le nombre de semaines de congé ou vérifiez le nombre d'employés.
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                <StatBox label="Sem. normales" value={semNormales} formula={`${T} − ${N}×${L}`} color="indigo" />
                <StatBox label="Sem. remplacement" value={semRemplacement} formula={`(${N}−1) × ${L}`} color="violet" />
                <StatBox label="Sem. congé" value={semConge} formula={`= L`} color="amber" />
              </div>
            )}

            <div className="text-xs text-slate-400 bg-slate-50 rounded-xl px-4 py-3 border border-slate-100">
              <span className="font-semibold text-slate-500">Formule : </span>
              Sem. normales = T − N × L &nbsp;·&nbsp; Sem. remplacement = (N−1) × L &nbsp;·&nbsp; Total = {N > 0 ? semNormales + semRemplacement + semConge : '—'} sem.
            </div>
          </div>
        </div>

        {/* ── 6ème semaine ── */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/60">
            <SectionTitle>Congés — 6ème semaine capitalisée</SectionTitle>
          </div>
          <div className="px-6 py-5 space-y-4">
            <button onClick={() => toggleSixthWeek(!sixthWeek)}
              className={`flex items-center justify-between w-full p-4 rounded-xl border-2 transition-all text-left ${sixthWeek ? 'border-indigo-200 bg-indigo-50' : 'border-slate-100 bg-slate-50 hover:border-slate-200'}`}>
              <div>
                <div className={`text-sm font-semibold ${sixthWeek ? 'text-indigo-700' : 'text-slate-600'}`}>6ème semaine de congé capitalisée</div>
                <div className="text-xs text-slate-400 mt-0.5">Applicable à tous les employés — passe L de 5 à 6</div>
              </div>
              <div className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${sixthWeek ? 'bg-indigo-500' : 'bg-slate-300'}`}>
                <div className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${sixthWeek ? 'translate-x-5' : ''}`} />
              </div>
            </button>
            <div className="space-y-2">
              <Rule title="Calcul de la capitalisation" text="Chaque semaine normale, l'employé capitalise (contrat − formation) heures. Exemple : contrat 30h dont 7h30 formation → 22h30 capitalisés par semaine." />
              <Rule title="Valeur de la 6ème semaine" text="La 6ème semaine vaut (contrat − formation) heures. Les heures de formation sont exclues car prises en charge séparément." />
            </div>
          </div>
        </div>

        {/* ── Décompte des congés payés ── */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/60">
            <SectionTitle>Décompte des congés payés</SectionTitle>
          </div>
          <div className="px-6 py-5 space-y-2">
            <Rule title="Droit annuel" text={`Droit = (heures contrat − heures formation) × ${L} semaines. La formation est exclue car prise en charge séparément, hors du lieu de travail habituel. Le droit est individualisé selon le contrat de chaque employée.`} />
            <Rule title="Formation exclue du décompte" text="Les heures de formation ne sont jamais incluses dans les heures déduites lors des congés posés. Seules les heures de travail réel entrent dans le calcul — la formation n'a aucun impact sur le solde congés." />
            <Rule title="Semaine entière posée" text="Les heures décomptées correspondent aux heures réelles de travail de la semaine type (A ou B), formation exclue. Cela tient compte naturellement du planning de remplacement : les heures de l'absente sont déduites selon son propre planning semaine type." />
            <Rule title="Jour isolé posé" text="Les heures décomptées correspondent aux heures réelles de la semaine type pour ce jour précis (semaine A ou B), formation exclue. C'est la méthode la plus juste pour les absences à la journée." />
            <Rule title={`Années à 52 ou 53 semaines (T = ${T} en ${currentYear})`} text={`Le nombre de semaines dans l'année (T) est de ${T} pour ${currentYear} — visible dans le tableau Cycle A/B ci-dessus. T = 53 arrive environ tous les 5 ans et élargit les semaines normales disponibles pour le lissage. Le droit à congés reste exprimé en semaines et n'est pas affecté par T.`} />
          </div>
        </div>

        {/* ── Règles de remplacement ── */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/60">
            <SectionTitle>Règles de remplacement & lissage</SectionTitle>
          </div>
          <div className="px-6 py-5 space-y-2">
            <Rule title="Remplacement simple" text="Lors d'une semaine de congé d'un employé, les présents suivent uniquement leur planning de remplacement. La semaine type normale est ignorée cette semaine-là." />
            <Rule title="Double absence" text="Si deux employés sont absents simultanément (cas non planifié), le planning de remplacement avec le plus d'heures est appliqué pour les employés présents." />
            <Rule title="Lissage" text="Les heures supplémentaires des semaines de remplacement sont lissées sur les semaines normales, afin que le total annuel reste égal au contrat. Le calcul tient compte du nombre réel de semaines A et B dans l'année (52 ou 53 semaines)." />
          </div>
        </div>

        {/* ── Technique ── */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/60">
            <SectionTitle>Technique</SectionTitle>
          </div>
          <div className="px-6 py-5 space-y-2">
            <Rule title="Frontend" text="React + TypeScript + Tailwind, déployé sur Vercel (cadencia-iota.vercel.app)." />
            <Rule title="Base de données" text="Supabase (PostgreSQL en ligne)." />
            <Rule title="Déploiement" text="Automatique à chaque git push vers GitHub." />
          </div>
        </div>

      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest">{children}</h2>
}

function Th({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return <th className={`py-2.5 px-4 text-[10px] font-extrabold text-slate-500 uppercase tracking-widest whitespace-nowrap ${first ? 'text-left' : 'text-center'}`}>{children}</th>
}

function FormulaBox({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-3">
      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">{label}</p>
      <p className="text-2xl font-extrabold text-slate-700">{value}</p>
      <p className="text-[11px] text-slate-400 mt-0.5">{sub}</p>
    </div>
  )
}

function StatBox({ label, value, formula, color }: { label: string; value: number; formula: string; color: 'indigo' | 'violet' | 'amber' }) {
  const cls = {
    indigo: 'bg-indigo-50 border-indigo-100 text-indigo-700',
    violet: 'bg-violet-50 border-violet-100 text-violet-700',
    amber: 'bg-amber-50 border-amber-100 text-amber-700',
  }[color]
  return (
    <div className={`border rounded-xl px-4 py-3 ${cls}`}>
      <p className="text-[10px] font-bold uppercase tracking-widest opacity-60 mb-1">{label}</p>
      <p className="text-3xl font-extrabold">{value}</p>
      <p className="text-[11px] opacity-50 mt-0.5">{formula}</p>
    </div>
  )
}

function Rule({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex gap-3 p-4 bg-slate-50 rounded-xl border border-slate-100">
      <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 mt-1.5 shrink-0" />
      <div>
        <p className="text-sm font-semibold text-slate-700">{title}</p>
        <p className="text-sm text-slate-400 mt-0.5 leading-relaxed">{text}</p>
      </div>
    </div>
  )
}
