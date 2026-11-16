import { describe, it, expect } from 'vitest'
import { resolveActivePeriod, findOverlappingPeriod, countPeriodWeeks, type PlanningPeriod } from './periods'
import { getYearWeekMondays, defaultRefMonday, countYearWeeks } from './weekUtils'

const base: PlanningPeriod = { id: 'base', companyId: 'c1', label: 'Planning de base', isBase: true, startDate: null, endDate: null, cycleMode: 'ab' }
const ete: PlanningPeriod = { id: 'ete', companyId: 'c1', label: 'Été 2026', isBase: false, startDate: '2026-06-12', endDate: '2026-09-13', cycleMode: 'ab' }
const noel: PlanningPeriod = { id: 'noel', companyId: 'c1', label: 'Vacances Noël', isBase: false, startDate: '2026-12-01', endDate: '2026-12-20', cycleMode: 'ab' }

describe('resolveActivePeriod', () => {
  it('retourne la base si aucune période datée ne couvre la date', () => {
    expect(resolveActivePeriod([base], new Date(2026, 2, 15)).id).toBe('base')
    expect(resolveActivePeriod([base, ete], new Date(2026, 2, 15)).id).toBe('base')
  })

  it('retourne la période datée qui couvre la date', () => {
    expect(resolveActivePeriod([base, ete], new Date(2026, 6, 1)).id).toBe('ete') // 1er juillet
  })

  it('bornes incluses : le premier et le dernier jour de la période comptent', () => {
    expect(resolveActivePeriod([base, ete], new Date(2026, 5, 12)).id).toBe('ete') // 12 juin
    expect(resolveActivePeriod([base, ete], new Date(2026, 8, 13)).id).toBe('ete') // 13 sept
  })

  it('le jour juste avant/après la période retombe sur la base', () => {
    expect(resolveActivePeriod([base, ete], new Date(2026, 5, 11)).id).toBe('base') // 11 juin
    expect(resolveActivePeriod([base, ete], new Date(2026, 8, 14)).id).toBe('base') // 14 sept
  })

  it('un trou entre deux périodes non adjacentes retourne la base', () => {
    expect(resolveActivePeriod([base, ete, noel], new Date(2026, 9, 15)).id).toBe('base') // 15 oct, entre été et Noël
  })

  it('lève une erreur explicite si aucune période de base n\'est fournie', () => {
    // date hors de `ete` pour forcer le repli sur la base (absente ici)
    expect(() => resolveActivePeriod([ete], new Date(2026, 2, 15))).toThrow()
  })
})

describe('findOverlappingPeriod', () => {
  it('détecte un chevauchement total', () => {
    const r = findOverlappingPeriod([base, ete], { startDate: '2026-07-01', endDate: '2026-07-31' })
    expect(r?.id).toBe('ete')
  })

  it('détecte un chevauchement partiel en début', () => {
    const r = findOverlappingPeriod([base, ete], { startDate: '2026-06-01', endDate: '2026-06-15' })
    expect(r?.id).toBe('ete')
  })

  it('détecte un chevauchement partiel en fin', () => {
    const r = findOverlappingPeriod([base, ete], { startDate: '2026-09-10', endDate: '2026-09-30' })
    expect(r?.id).toBe('ete')
  })

  it('aucun conflit en cas d\'adjacence exacte sans chevauchement', () => {
    const r = findOverlappingPeriod([base, ete], { startDate: '2026-09-14', endDate: '2026-10-15' })
    expect(r).toBeNull()
  })

  it('excludeId permet d\'éditer une période existante sans se bloquer elle-même', () => {
    const r = findOverlappingPeriod([base, ete], { startDate: '2026-06-12', endDate: '2026-09-13', excludeId: 'ete' })
    expect(r).toBeNull()
  })

  it('ignore la période de base', () => {
    const r = findOverlappingPeriod([base], { startDate: '2026-01-01', endDate: '2026-12-31' })
    expect(r).toBeNull()
  })
})

describe('countPeriodWeeks', () => {
  it('la somme des semaines de chaque période (base incluse) égale countYearWeeks', () => {
    const ref = defaultRefMonday(2026)
    const mondays = getYearWeekMondays(2026)
    const periods = [base, ete, noel]
    const totalBase = countPeriodWeeks(mondays, periods, 'base', ref).total
    const totalEte = countPeriodWeeks(mondays, periods, 'ete', ref).total
    const totalNoel = countPeriodWeeks(mondays, periods, 'noel', ref).total
    const expected = countYearWeeks(2026, ref).total
    expect(totalBase + totalEte + totalNoel).toBe(expected)
  })

  it('nA + nB == total pour une période donnée', () => {
    const ref = defaultRefMonday(2026)
    const mondays = getYearWeekMondays(2026)
    const { nA, nB, total } = countPeriodWeeks(mondays, [base, ete], 'ete', ref)
    expect(nA + nB).toBe(total)
    expect(total).toBeGreaterThan(0)
  })
})
