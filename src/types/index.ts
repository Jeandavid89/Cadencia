export interface Company {
  id: string
  name: string
  country: string
  sixth_week: boolean
  created_at: string
}

export interface PublicHoliday {
  id: string
  company_id: string
  date: string       // YYYY-MM-DD
  name: string
  year: number
}

export type WeekType = 'A' | 'B'

// Formate des minutes en "Xh30" ou "7h00"
export function fmtMinutes(minutes: number, showSign = false): string {
  const sign = minutes < 0 ? '-' : showSign && minutes > 0 ? '+' : ''
  const abs = Math.abs(minutes)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return `${sign}${h}h${m.toString().padStart(2, '0')}`
}
