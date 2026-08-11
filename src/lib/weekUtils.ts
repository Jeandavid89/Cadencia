export function getMondayOf(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function getWeekType(date: Date, refMonday: Date): 'A' | 'B' {
  const monday = getMondayOf(date)
  const diff = Math.round((monday.getTime() - refMonday.getTime()) / (7 * 24 * 60 * 60 * 1000))
  return ((diff % 2) + 2) % 2 === 0 ? 'A' : 'B'
}

// Lundis des semaines de l'année qui contiennent au moins un jour ouvré
// (lun-ven) dans [year-01-01, year-12-31]. Utilisé comme base commune par
// CalcAnnuelPage, PlanningPage et computeSoldeLive pour compter les
// semaines simulées.
export function getYearWeekMondays(year: number): Date[] {
  const mondays: Date[] = []
  const seen = new Set<number>()
  const d = new Date(year, 0, 1)
  const end = new Date(year, 11, 31)
  while (d <= end) {
    const dow = d.getDay()
    if (dow >= 1 && dow <= 5) {
      const mon = getMondayOf(new Date(d))
      const key = mon.getTime()
      if (!seen.has(key)) {
        seen.add(key)
        mondays.push(mon)
      }
    }
    d.setDate(d.getDate() + 1)
  }
  return mondays
}

export function countYearWeeks(year: number, refMonday: Date): { nA: number; nB: number; total: number } {
  let nA = 0, nB = 0
  for (const mon of getYearWeekMondays(year)) {
    if (getWeekType(mon, refMonday) === 'A') { nA++ } else { nB++ }
  }
  return { nA, nB, total: nA + nB }
}

export function defaultRefMonday(year: number): Date {
  return getMondayOf(new Date(year, 0, 4))
}
