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

// Lundis des semaines "rattachées" à l'année. Une semaine (lun-ven) est
// rattachée à l'année qui contient son mercredi (jour central des 5 jours
// ouvrés) - une semaine à cheval sur deux années n'est donc jamais comptée
// deux fois (ni dans les deux années, ni dans aucune). Utilisé comme base
// commune par CalcAnnuelPage, PlanningPage et computeSoldeLive pour compter
// les semaines simulées.
export function getYearWeekMondays(year: number): Date[] {
  const mondays: Date[] = []
  let mon = getMondayOf(new Date(year, 0, 1))
  while (true) {
    const wed = new Date(mon)
    wed.setDate(wed.getDate() + 2)
    const wedYear = wed.getFullYear()
    if (wedYear === year) mondays.push(new Date(mon))
    else if (wedYear > year) break
    mon = new Date(mon)
    mon.setDate(mon.getDate() + 7)
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
