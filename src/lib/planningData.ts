import { supabase } from './supabase'
import type { PlanningPeriod } from './periods'
import type { SemaineTypeSlot, ReplacementSlot, PeriodSlots } from './bilanCalc'

// Lignes réellement renvoyées par Supabase : le `id` de la ligne et son
// `period_id` sont présents en plus des champs "purs" consommés par
// bilanCalc.ts (dont les fonctions ne doivent connaître ni l'un ni l'autre).
export type SemaineTypeSlotRow = SemaineTypeSlot & { id: string; period_id: string }
export type ReplacementSlotRow = ReplacementSlot & { id: string; period_id: string }

export interface PlanningData {
  periods: PlanningPeriod[]
  basePeriodId: string
  periodSlots: PeriodSlots[]
  // Vues à plat (toutes périodes confondues) - comportement identique à avant
  // l'introduction des périodes, consommé par les pages pas encore migrées
  // vers une résolution par période (Prompt 9).
  semSlots: SemaineTypeSlotRow[]
  replSlots: ReplacementSlotRow[]
}

/**
 * Charge les périodes de planning d'un cabinet ainsi que les semaines types
 * et remplacements, groupés par période. Remplace les lectures dupliquées de
 * `semaine_type_slots`/`replacement_slots` auparavant faites indépendamment
 * dans SemaineTypePage, PlanningPage (x2), CongesPage, CalcAnnuelPage et
 * bilanUtils.computeSoldeLive.
 */
export async function loadPlanningData(companyId: string): Promise<PlanningData> {
  const [{ data: periodsRaw }, { data: semRaw }, { data: replRaw }] = await Promise.all([
    supabase.from('planning_periods').select('id,company_id,label,is_base,start_date,end_date').eq('company_id', companyId),
    supabase.from('semaine_type_slots').select('id,employee_id,week_type,day_of_week,start_minutes,end_minutes,break_minutes,is_formation,period_id').eq('company_id', companyId),
    supabase.from('replacement_slots').select('id,absent_employee_id,present_employee_id,day_of_week,start_minutes,end_minutes,break_minutes,is_formation,period_id').eq('company_id', companyId),
  ])

  const periods: PlanningPeriod[] = ((periodsRaw ?? []) as { id: string; company_id: string; label: string; is_base: boolean; start_date: string | null; end_date: string | null }[])
    .map(p => ({ id: p.id, companyId: p.company_id, label: p.label, isBase: p.is_base, startDate: p.start_date, endDate: p.end_date }))

  const base = periods.find(p => p.isBase)
  if (!base) throw new Error(`loadPlanningData: aucune période de base trouvée pour company_id=${companyId}`)

  const semSlots = (semRaw ?? []) as SemaineTypeSlotRow[]
  const replSlots = (replRaw ?? []) as ReplacementSlotRow[]

  const periodSlots: PeriodSlots[] = periods.map(period => ({
    period,
    semSlots: semSlots.filter(s => s.period_id === period.id),
    replSlots: replSlots.filter(r => r.period_id === period.id),
  }))

  return { periods, basePeriodId: base.id, periodSlots, semSlots, replSlots }
}
