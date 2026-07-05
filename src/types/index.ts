export interface Company {
  id: string
  name: string
  country: string
  sixth_week: boolean
  created_at: string
}

export interface Employee {
  id: string
  company_id: string
  first_name: string
  last_name: string
  contract_hours_per_week: number  // en minutes
  formation_hours_per_week: number // en minutes, peut être 0
  leave_hours_per_year: number     // en minutes
  entry_date: string               // YYYY-MM-DD, défaut 1er janvier de l'année courante
  active: boolean
  created_at: string
}

export interface PublicHoliday {
  id: string
  company_id: string
  date: string       // YYYY-MM-DD
  name: string
  year: number
}

// Semaine A = ISO paire, B = ISO impaire
export type WeekType = 'A' | 'B'

export function getWeekType(isoWeek: number): WeekType {
  return isoWeek % 2 === 0 ? 'A' : 'B'
}

// Formate des minutes en "Xh30" ou "7h00"
export function fmtMinutes(minutes: number, showSign = false): string {
  const sign = minutes < 0 ? '-' : showSign && minutes > 0 ? '+' : ''
  const abs = Math.abs(minutes)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return `${sign}${h}h${m.toString().padStart(2, '0')}`
}
