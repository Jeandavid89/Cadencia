export function getMondayOf(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

export function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function getWeekType(date: Date, refMonday: Date): 'A' | 'B' {
  const monday = getMondayOf(date)
  const diff = Math.round((monday.getTime() - refMonday.getTime()) / (7 * 24 * 60 * 60 * 1000))
  return ((diff % 2) + 2) % 2 === 0 ? 'A' : 'B'
}

export function countYearWeeks(year: number, refMonday: Date): { nA: number; nB: number; total: number } {
  const seen = new Set<number>()
  let nA = 0, nB = 0
  const d = new Date(year, 0, 1)
  const end = new Date(year, 11, 31)
  while (d <= end) {
    const dow = d.getDay()
    if (dow >= 1 && dow <= 5) {
      const mon = getMondayOf(new Date(d))
      const key = mon.getTime()
      if (!seen.has(key)) {
        seen.add(key)
        if (getWeekType(d, refMonday) === 'A') { nA++ } else { nB++ }
      }
    }
    d.setDate(d.getDate() + 1)
  }
  return { nA, nB, total: nA + nB }
}

export function defaultRefMonday(year: number): Date {
  return getMondayOf(new Date(year, 0, 4))
}
