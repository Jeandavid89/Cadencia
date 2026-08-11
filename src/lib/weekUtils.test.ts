import { describe, it, expect } from 'vitest'
import { getMondayOf, toDateStr, getWeekType, getYearWeekMondays, countYearWeeks, defaultRefMonday } from './weekUtils'

describe('getMondayOf', () => {
  it('renvoie le même jour si déjà lundi', () => {
    const mon = getMondayOf(new Date(2026, 1, 2)) // lundi 2 fevrier 2026
    expect(toDateStr(mon)).toBe('2026-02-02')
  })
  it('recule jusqu\'au lundi précédent pour un jour de semaine', () => {
    const wed = getMondayOf(new Date(2026, 1, 4)) // mercredi
    expect(toDateStr(wed)).toBe('2026-02-02')
  })
  it('recule jusqu\'au lundi précédent pour un dimanche', () => {
    const sun = getMondayOf(new Date(2026, 1, 8)) // dimanche
    expect(toDateStr(sun)).toBe('2026-02-02')
  })
})

describe('toDateStr', () => {
  it('formate en YYYY-MM-DD en heure locale (pas UTC)', () => {
    // 23h locale ne doit pas basculer sur le jour suivant (regression du bug toISOString/UTC)
    const d = new Date(2026, 0, 15, 23, 30)
    expect(toDateStr(d)).toBe('2026-01-15')
  })
})

describe('getWeekType', () => {
  it('alterne A/B toutes les semaines par rapport à la référence', () => {
    const ref = getMondayOf(new Date(2026, 0, 5)) // lundi référence
    expect(getWeekType(ref, ref)).toBe('A')
    const nextWeek = new Date(ref); nextWeek.setDate(nextWeek.getDate() + 7)
    expect(getWeekType(nextWeek, ref)).toBe('B')
    const twoWeeks = new Date(ref); twoWeeks.setDate(twoWeeks.getDate() + 14)
    expect(getWeekType(twoWeeks, ref)).toBe('A')
  })
  it('gère les références antérieures (diff négatif)', () => {
    const ref = getMondayOf(new Date(2026, 5, 1))
    const before = new Date(ref); before.setDate(before.getDate() - 7)
    expect(getWeekType(before, ref)).toBe('B')
  })
})

describe('getYearWeekMondays', () => {
  it('retourne des lundis uniques, triés, couvrant toute l\'année', () => {
    const mondays = getYearWeekMondays(2026)
    const keys = mondays.map(m => m.getTime())
    expect(new Set(keys).size).toBe(keys.length) // pas de doublon
    for (let i = 1; i < mondays.length; i++) expect(mondays[i].getTime()).toBeGreaterThan(mondays[i - 1].getTime())
    // 2026 : 52 ou 53 semaines calendaires selon le positionnement du 1er/31 janvier-décembre
    expect(mondays.length).toBeGreaterThanOrEqual(52)
    expect(mondays.length).toBeLessThanOrEqual(53)
  })
})

describe('countYearWeeks', () => {
  it('nA + nB == total == getYearWeekMondays(year).length', () => {
    const ref = defaultRefMonday(2026)
    const { nA, nB, total } = countYearWeeks(2026, ref)
    expect(nA + nB).toBe(total)
    expect(total).toBe(getYearWeekMondays(2026).length)
  })
})
