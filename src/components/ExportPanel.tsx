import { useState } from 'react'
import { supabase } from '../lib/supabase'

interface Employee {
  id: string
  first_name: string
  last_name: string
  color_index: number | null
}

interface Slot {
  employee_id: string
  date: string
  start_minutes: number | null
  end_minutes: number | null
  break_minutes: number
  slot_type: string
}

interface Props {
  companyId: string
  employees: Employee[]
  holidays: { date: string; name: string }[]
  onClose: () => void
}

const EMP_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#0ea5e9']
const DAYS_FR = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi']
const MONTHS_LONG = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre']
const MONTHS_SHORT = ['jan.','fév.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.']

function getMondayOf(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  d.setHours(0, 0, 0, 0)
  return d
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d); r.setDate(r.getDate() + n); return r
}

function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const ys = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d.getTime() - ys.getTime()) / 86400000) + 1) / 7)
}

function getWeeksInRange(from: Date, to: Date): Date[] {
  const weeks: Date[] = []
  let cur = getMondayOf(from)
  const end = getMondayOf(to)
  while (cur <= end) { weeks.push(new Date(cur)); cur = addDays(cur, 7) }
  return weeks
}

function fmtTime(m: number) {
  return `${Math.floor(m / 60)}h${(m % 60).toString().padStart(2, '0')}`
}

// ─── Option A : HTML texte ────────────────────────────────────────────────────

function buildPrintHTML(weeks: Date[], slots: Slot[], employees: Employee[], holSet: Set<string>): string {
  const weekBlocks = weeks.map(weekMon => {
    const fri = addDays(weekMon, 4)
    const isoW = getISOWeek(weekMon)

    const headerCols = [0,1,2,3,4].map(o => {
      const d = addDays(weekMon, o)
      return `<th>${DAYS_FR[o]}<br><small>${d.getDate().toString().padStart(2,'0')} ${MONTHS_LONG[d.getMonth()]}</small></th>`
    }).join('')

    const rows = employees.map(emp => {
      const cells = [0,1,2,3,4].map(o => {
        const day = addDays(weekMon, o)
        const ds = toLocalDateStr(day)
        const daySlots = slots.filter(s => s.employee_id === emp.id && s.date === ds)
        if (holSet.has(ds)) return `<td class="special hol">Férié</td>`
        if (daySlots.some(s => s.slot_type === 'leave_week' || s.slot_type === 'leave_day'))
          return `<td class="special cg">Congé</td>`
        const work = daySlots.filter(s => (s.slot_type === 'work' || s.slot_type === 'formation') && s.start_minutes != null)
        if (work.length === 0) return `<td class="empty">—</td>`
        const lines = work.map(s =>
          `<span class="${s.slot_type === 'formation' ? 'form' : ''}">${fmtTime(s.start_minutes!)} – ${fmtTime(s.end_minutes!)}</span>`
        ).join('<br>')
        return `<td>${lines}</td>`
      }).join('')
      return `<tr><td class="name">${emp.first_name} ${emp.last_name}</td>${cells}</tr>`
    }).join('')

    return `<div class="week-block">
      <div class="week-title">
        <strong>Planning — Semaine ${isoW}</strong>
        <span>${weekMon.getDate().toString().padStart(2,'0')} ${MONTHS_LONG[weekMon.getMonth()]} → ${fri.getDate().toString().padStart(2,'0')} ${MONTHS_LONG[fri.getMonth()]} ${fri.getFullYear()}</span>
      </div>
      <table>
        <thead><tr><th class="emp-col">Employée</th>${headerCols}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`
  }).join('')

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box }
  body { font-family:system-ui,sans-serif; font-size:12px; color:#1e293b; padding:10mm }
  .week-block { page-break-inside:avoid; margin-bottom:20px }
  .week-title { margin-bottom:8px }
  .week-title strong { font-size:15px; font-weight:800; display:block }
  .week-title span { color:#64748b; font-size:11px }
  table { width:100%; border-collapse:collapse }
  th, td { border:1px solid #e2e8f0; padding:5px 7px; vertical-align:top }
  th { background:#f8fafc; font-size:10px; font-weight:700; color:#334155; text-align:center }
  th small { font-weight:400; color:#94a3b8; display:block; font-size:9px }
  th.emp-col { text-align:left }
  td.name { font-weight:600; color:#475569; white-space:nowrap; width:90px }
  td.empty { color:#cbd5e1; text-align:center }
  td.special { text-align:center; font-size:10px; font-weight:600 }
  td.hol { background:#f1f5f9; color:#94a3b8 }
  td.cg  { background:#eff6ff; color:#3b82f6 }
  span.form { color:#8b5cf6 }
  @media print { @page { size:A4 portrait; margin:8mm } body { padding:0 } }
</style></head><body>${weekBlocks}</body></html>`
}

// ─── Option B : Canvas visuel ─────────────────────────────────────────────────

function fillRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.arcTo(x + w, y, x + w, y + radius, radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius)
  ctx.lineTo(x + radius, y + h)
  ctx.arcTo(x, y + h, x, y + h - radius, radius)
  ctx.lineTo(x, y + radius)
  ctx.arcTo(x, y, x + radius, y, radius)
  ctx.closePath()
  ctx.fill()
}

function drawWeekOnCanvas(canvas: HTMLCanvasElement, weekMon: Date, employees: Employee[], slots: Slot[], holSet: Set<string>) {
  const W = 1122
  const H = 794
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  const G_START = 420
  const G_END   = 1140
  const TITLE_H = 56
  const DAY_H   = 32
  const TIME_W  = 44
  const GRID_H  = H - TITLE_H - DAY_H
  const GRID_W  = W - TIME_W
  const DAY_W   = GRID_W / 5
  const EMP_W   = DAY_W / employees.length
  const PX_MIN  = GRID_H / (G_END - G_START)

  // Fond blanc
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)

  // Titre
  const isoW = getISOWeek(weekMon)
  const fri  = addDays(weekMon, 4)
  ctx.fillStyle = '#1e293b'
  ctx.font = 'bold 18px Arial'
  ctx.fillText('CADENCIA — Planning', 14, 24)
  ctx.fillStyle = '#64748b'
  ctx.font = '13px Arial'
  ctx.fillText(`Semaine ${isoW}  ·  ${weekMon.getDate().toString().padStart(2,'0')} ${MONTHS_SHORT[weekMon.getMonth()]} → ${fri.getDate().toString().padStart(2,'0')} ${MONTHS_SHORT[fri.getMonth()]} ${fri.getFullYear()}`, 14, 44)

  // En-têtes jours
  const dayY = TITLE_H
  ctx.fillStyle = '#f8fafc'
  ctx.fillRect(TIME_W, dayY, GRID_W, DAY_H)

  for (let di = 0; di < 5; di++) {
    const day = addDays(weekMon, di)
    const x = TIME_W + di * DAY_W
    ctx.strokeStyle = '#e2e8f0'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(x, dayY); ctx.lineTo(x, H); ctx.stroke()
    ctx.fillStyle = '#334155'
    ctx.font = 'bold 11px Arial'
    ctx.textAlign = 'center'
    ctx.fillText(DAYS_FR[di].toUpperCase(), x + DAY_W / 2, dayY + 14)
    ctx.fillStyle = '#94a3b8'
    ctx.font = '10px Arial'
    ctx.fillText(`${day.getDate().toString().padStart(2,'0')} ${MONTHS_SHORT[day.getMonth()]}`, x + DAY_W / 2, dayY + 27)
  }
  ctx.textAlign = 'left'

  // Séparateur axe temps
  ctx.strokeStyle = '#e2e8f0'
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(TIME_W, TITLE_H); ctx.lineTo(TIME_W, H); ctx.stroke()

  // Lignes horaires
  const gridY = TITLE_H + DAY_H
  for (let h = 7; h <= 19; h++) {
    const y = gridY + (h * 60 - G_START) * PX_MIN
    ctx.strokeStyle = h % 2 === 0 ? '#e2e8f0' : '#f8fafc'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(TIME_W, y); ctx.lineTo(W, y); ctx.stroke()
    ctx.fillStyle = '#94a3b8'
    ctx.font = '9px Arial'
    ctx.fillText(`${h}h`, 4, y + 3)
  }

  // Bordure grille
  ctx.strokeStyle = '#e2e8f0'
  ctx.lineWidth = 1
  ctx.strokeRect(TIME_W, gridY, GRID_W, GRID_H)

  // Slots
  for (let di = 0; di < 5; di++) {
    const day = addDays(weekMon, di)
    const ds  = toLocalDateStr(day)
    const x0  = TIME_W + di * DAY_W

    if (holSet.has(ds)) {
      ctx.fillStyle = '#f8fafc'
      ctx.fillRect(x0, gridY, DAY_W, GRID_H)
      ctx.fillStyle = '#94a3b8'
      ctx.font = '10px Arial'
      ctx.textAlign = 'center'
      ctx.fillText('Jour férié', x0 + DAY_W / 2, gridY + GRID_H / 2)
      ctx.textAlign = 'left'
      continue
    }

    employees.forEach((emp, ei) => {
      const empX  = x0 + ei * EMP_W
      const color = EMP_COLORS[(emp.color_index ?? ei) % EMP_COLORS.length]
      const daySlots = slots.filter(s => s.employee_id === emp.id && s.date === ds)
      const isLeave = daySlots.some(s => s.slot_type === 'leave_week' || s.slot_type === 'leave_day')

      if (isLeave) {
        ctx.fillStyle = '#eff6ff'
        ctx.fillRect(empX + 1, gridY, EMP_W - 2, GRID_H)
        ctx.fillStyle = '#3b82f6'
        ctx.font = 'bold 8px Arial'
        ctx.textAlign = 'center'
        ctx.fillText('Congé', empX + EMP_W / 2, gridY + GRID_H / 2)
        ctx.textAlign = 'left'
        return
      }

      daySlots
        .filter(s => (s.slot_type === 'work' || s.slot_type === 'formation') && s.start_minutes != null)
        .forEach(s => {
          const top    = gridY + (s.start_minutes! - G_START) * PX_MIN
          const height = Math.max(6, (s.end_minutes! - s.start_minutes!) * PX_MIN)
          ctx.fillStyle = s.slot_type === 'formation' ? '#8b5cf6' : color
          fillRoundRect(ctx, empX + 1, top, EMP_W - 2, height, 3)

          if (height > 14) {
            ctx.fillStyle = 'rgba(255,255,255,0.92)'
            ctx.font = `bold ${height > 20 ? 9 : 7}px Arial`
            ctx.textAlign = 'center'
            ctx.fillText(emp.first_name.slice(0, 4).toUpperCase(), empX + EMP_W / 2, top + 10)
            if (height > 24) {
              ctx.font = '7px Arial'
              ctx.fillText(fmtTime(s.start_minutes!), empX + EMP_W / 2, top + 20)
            }
            ctx.textAlign = 'left'
          }
        })
    })
  }
}

function buildVisualHTML(canvases: HTMLCanvasElement[]): string {
  const imgs = canvases.map(c =>
    `<div class="page"><img src="${c.toDataURL('image/jpeg', 0.92)}"></div>`
  ).join('')
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box }
  body { background:#fff }
  .page { page-break-after:always }
  img { display:block; width:297mm; height:210mm }
  @media print { @page { size:A4 landscape; margin:0 } }
</style></head><body>${imgs}</body></html>`
}

// ─── Composant ────────────────────────────────────────────────────────────────

export default function ExportPanel({ companyId, employees, holidays, onClose }: Props) {
  const todayMon = toLocalDateStr(getMondayOf(new Date()))
  const [fromDate, setFromDate] = useState(todayMon)
  const [toDate,   setToDate]   = useState(todayMon)
  const [loading,  setLoading]  = useState(false)
  const [progress, setProgress] = useState('')

  const holSet = new Set(holidays.map(h => h.date))

  async function fetchSlots(from: Date, to: Date): Promise<Slot[]> {
    const { data } = await supabase
      .from('planning_slots')
      .select('employee_id,date,start_minutes,end_minutes,break_minutes,slot_type')
      .eq('company_id', companyId)
      .gte('date', toLocalDateStr(from))
      .lte('date', toLocalDateStr(addDays(to, 4)))
    return (data ?? []) as Slot[]
  }

  async function handlePrintText() {
    setLoading(true); setProgress('Chargement...')
    try {
      const from  = getMondayOf(new Date(fromDate + 'T00:00:00'))
      const to    = getMondayOf(new Date(toDate   + 'T00:00:00'))
      const weeks = getWeeksInRange(from, to)
      const slots = await fetchSlots(from, to)
      const html  = buildPrintHTML(weeks, slots, employees, holSet)
      const w = window.open('', '_blank')
      if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 300) }
    } finally { setLoading(false); setProgress('') }
  }

  async function handlePrintVisual() {
    setLoading(true)
    try {
      const from  = getMondayOf(new Date(fromDate + 'T00:00:00'))
      const to    = getMondayOf(new Date(toDate   + 'T00:00:00'))
      const weeks = getWeeksInRange(from, to)
      const canvases: HTMLCanvasElement[] = []

      for (let i = 0; i < weeks.length; i++) {
        setProgress(`Génération semaine ${i + 1} / ${weeks.length}…`)
        const weekMon = weeks[i]
        const { data } = await supabase
          .from('planning_slots')
          .select('employee_id,date,start_minutes,end_minutes,break_minutes,slot_type')
          .eq('company_id', companyId)
          .gte('date', toLocalDateStr(weekMon))
          .lte('date', toLocalDateStr(addDays(weekMon, 4)))
        const canvas = document.createElement('canvas')
        drawWeekOnCanvas(canvas, weekMon, employees, (data ?? []) as Slot[], holSet)
        canvases.push(canvas)
      }

      setProgress('Ouverture...')
      const html = buildVisualHTML(canvases)
      const w = window.open('', '_blank')
      if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 500) }
    } finally { setLoading(false); setProgress('') }
  }

  return (
    <div className="absolute right-0 top-12 z-50 bg-white rounded-2xl shadow-xl border border-slate-200 w-72 p-4" onClick={e => e.stopPropagation()}>
      <div className="flex items-center justify-between mb-4">
        <p className="font-bold text-slate-700 text-sm">Exporter le planning</p>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none">×</button>
      </div>

      <div className="space-y-3 mb-4">
        <div>
          <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">De la semaine du</label>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
            className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div>
          <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Au</label>
          <input type="date" value={toDate} min={fromDate} onChange={e => setToDate(e.target.value)}
            className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
        </div>
      </div>

      {progress && <p className="text-xs text-indigo-600 text-center mb-3 font-medium">{progress}</p>}

      <div className="space-y-2">
        <button onClick={handlePrintText} disabled={loading}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-slate-700 border border-slate-200 rounded-xl hover:bg-slate-50 disabled:opacity-40 transition-colors">
          🖨️ Imprimer — Tableau texte
        </button>
        <button onClick={handlePrintVisual} disabled={loading}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-indigo-700 border border-indigo-200 rounded-xl bg-indigo-50 hover:bg-indigo-100 disabled:opacity-40 transition-colors">
          🎨 Imprimer — Visuel coloré
        </button>
      </div>

      <p className="text-[10px] text-slate-400 text-center mt-3">Dans la boîte d'impression → "Enregistrer en PDF"</p>
    </div>
  )
}
