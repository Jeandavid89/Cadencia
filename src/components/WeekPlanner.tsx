import { useState, useRef, useEffect } from 'react'

const PX_MIN = 0.65
const G_START = 420          // 7h00
const G_END   = 1200         // 20h00
const G_H     = Math.round((G_END - G_START) * PX_MIN)  // 507px — 7h-20h visible sans scroll
const COL_W   = 80
const H_DAY   = 34
const H_EMP   = 28

const DAYS = [
  { n: 1, l: 'Lundi' }, { n: 2, l: 'Mardi' }, { n: 3, l: 'Mercredi' },
  { n: 4, l: 'Jeudi' }, { n: 5, l: 'Vendredi' },
]
const HOURS = Array.from({ length: 14 }, (_, i) => i + 7)  // 7h → 20h

export const EMP_COLORS = [
  { bg: '#6366f1' }, { bg: '#10b981' }, { bg: '#f59e0b' },
  { bg: '#ef4444' }, { bg: '#8b5cf6' }, { bg: '#0ea5e9' },
]

export interface PlannerSlot {
  id: string
  employee_id: string
  day: number
  start_min: number
  end_min: number
  break_min: number
  is_formation?: boolean
}

export interface PlannerEmployee {
  id: string
  name: string
  colorIdx: number
}

export interface DayOverlay {
  employee_id: string  // '*' = tous les employés
  day: number          // 1=Lun ... 5=Ven
  color: string
  label: string
}

export interface LeavePartialSlot {
  id: string
  employee_id: string
  day: number
  start_min: number
  end_min: number
}

interface Props {
  employees: PlannerEmployee[]
  slots: PlannerSlot[]
  onChange: (s: PlannerSlot[]) => void
  onMarkLeave?: (empId: string, day: number, type: 'leave_day' | 'leave_week') => void
  maxHeight?: number   // défaut : assez grand pour voir 7h-19h sans scroll
  readOnly?: boolean
  dayOverlays?: DayOverlay[]
  showFooter?: boolean  // défaut true
  leavePartialSlots?: LeavePartialSlot[]
  onDeleteLeavePartial?: (id: string) => void
  onGridRightClick?: (empId: string, day: number, minuteAt: number, x: number, y: number) => void
  weekStart?: Date
}

let _uid = 0
const uid = () => `s${++_uid}_${Date.now()}`
const snap = (m: number) => Math.round(m / 5) * 5
const y2m  = (y: number) => snap(G_START + y / PX_MIN)
const m2y  = (m: number) => (m - G_START) * PX_MIN
const fmtM = (m: number) => `${Math.floor(m / 60)}h${(m % 60).toString().padStart(2, '0')}`
const m2t  = (m: number) => `${Math.floor(m / 60).toString().padStart(2, '0')}:${(m % 60).toString().padStart(2, '0')}`
const t2m  = (t: string) => { const [h, mm] = t.split(':').map(Number); return h * 60 + mm }
export const eff = (s: PlannerSlot) => Math.max(0, s.end_min - s.start_min - s.break_min)

type Drag = { type: 'move' | 'top' | 'bot'; id: string; startY: number; origStart: number; origEnd: number } | null
type CtxMenu = { x: number; y: number; slotId: string } | null

const MONTHS_FR = ['jan.','fév.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.']

export default function WeekPlanner({ employees, slots, onChange, onMarkLeave, maxHeight = G_H + H_DAY + H_EMP + 20, readOnly = false, dayOverlays = [], showFooter = true, leavePartialSlots = [], onDeleteLeavePartial, onGridRightClick, weekStart }: Props) {
  const [editId, setEditId] = useState<string | null>(null)
  const [ctxMenu, setCtxMenu] = useState<CtxMenu>(null)
  const drag = useRef<Drag>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  function addSlot(empId: string, day: number, e: React.MouseEvent<HTMLDivElement>) {
    if (readOnly || drag.current) return
    if ((e.target as HTMLElement).closest('[data-slot]')) return
    if (dayOverlays.some(o => (o.employee_id === '*' || o.employee_id === empId) && o.day === day)) return
    const rect = e.currentTarget.getBoundingClientRect()
    const sm = Math.max(G_START, Math.min(G_END - 90, snap(y2m(e.clientY - rect.top))))
    const s: PlannerSlot = { id: uid(), employee_id: empId, day, start_min: sm, end_min: sm + 90, break_min: 30, is_formation: false }
    onChange([...slots, s])
    setEditId(s.id)
  }

  function patchSlot(id: string, patch: Partial<PlannerSlot>) {
    onChange(slots.map(s => s.id === id ? { ...s, ...patch } : s))
  }

  function startDrag(type: 'move' | 'top' | 'bot', id: string, e: React.MouseEvent) {
    if (readOnly) return
    e.stopPropagation(); e.preventDefault()
    const s = slots.find(x => x.id === id)!
    drag.current = { type, id, startY: e.clientY, origStart: s.start_min, origEnd: s.end_min }
  }

  function onMove(e: React.MouseEvent) {
    if (!drag.current) return
    const { type, id, startY, origStart, origEnd } = drag.current
    const dmin = snap((e.clientY - startY) / PX_MIN)
    const dur = origEnd - origStart
    onChange(slots.map(s => {
      if (s.id !== id) return s
      if (type === 'move') { const ns = Math.max(G_START, Math.min(G_END - dur, origStart + dmin)); return { ...s, start_min: ns, end_min: ns + dur } }
      if (type === 'bot') return { ...s, end_min: Math.max(s.start_min + 15, Math.min(G_END, origEnd + dmin)) }
      return { ...s, start_min: Math.min(s.end_min - 15, Math.max(G_START, origStart + dmin)) }
    }))
  }

  const editSlot = editId ? slots.find(s => s.id === editId) ?? null : null

  const ctxSlot = ctxMenu ? slots.find(s => s.id === ctxMenu.slotId) ?? null : null

  return (
    <div className="select-none" onMouseMove={onMove} onMouseUp={() => { drag.current = null }} onMouseLeave={() => { drag.current = null }} onClick={() => setCtxMenu(null)}>

      {/* Scrollable container — sticky headers work inside overflow-y: auto */}
      <div ref={scrollRef} style={{ maxHeight, overflowY: 'auto' }} className="relative">

        {/* Sticky day header */}
        <div className="sticky top-0 z-20 flex w-full bg-white border-b border-slate-200" style={{ height: H_DAY }}>
          <div style={{ width: 40, flexShrink: 0 }} className="border-r border-slate-100" />
          {DAYS.map(d => {
            const dayDate = weekStart ? new Date(weekStart.getTime() + (d.n - 1) * 86400000) : null
            const dateLabel = dayDate ? ` ${dayDate.getDate().toString().padStart(2, '0')} ${MONTHS_FR[dayDate.getMonth()]}` : ''
            return (
              <div key={d.n} className="flex-1 border-l border-slate-200 flex items-center justify-center gap-1.5">
                <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">{d.l}</span>
                {dateLabel && <span className="text-[11px] text-slate-400 font-medium">{dateLabel}</span>}
              </div>
            )
          })}
        </div>

        {/* Sticky employee sub-header */}
        <div className="sticky z-10 flex w-full bg-slate-50 border-b border-slate-200" style={{ top: H_DAY, height: H_EMP }}>
          <div style={{ width: 40, flexShrink: 0 }} className="border-r border-slate-100" />
          {DAYS.map(d => (
            <div key={d.n} className="flex flex-1 border-l border-slate-200">
              {employees.map(emp => {
                const c = EMP_COLORS[emp.colorIdx % EMP_COLORS.length]
                const workDay = slots.filter(s => s.employee_id === emp.id && s.day === d.n && !s.is_formation).reduce((a, s) => a + eff(s), 0)
                const formDay = slots.filter(s => s.employee_id === emp.id && s.day === d.n && s.is_formation).reduce((a, s) => a + eff(s), 0)
                return (
                  <div key={emp.id} className="flex flex-1 flex-col items-center justify-center border-r border-slate-100 last:border-0">
                    <span className="text-[9px] font-bold leading-none" style={{ color: c.bg }}>{emp.name.split(' ')[0].toUpperCase().slice(0, 4)}</span>
                    {workDay > 0 && <span className="text-[8px] text-slate-400 leading-none">{fmtM(workDay)}</span>}
                    {formDay > 0 && <span className="text-[7px] text-slate-300 leading-none italic">{fmtM(formDay)} f.</span>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        {/* Grid body */}
        <div className="flex w-full" style={{ height: G_H }}>
          {/* Hour labels */}
          <div className="relative shrink-0 border-r border-slate-100 bg-white" style={{ width: 40 }}>
            {HOURS.map(h => (
              <div key={h} className="absolute right-1 text-[9px] text-slate-300 leading-none" style={{ top: m2y(h * 60) - 5 }}>{h}h</div>
            ))}
          </div>

          {/* Day columns */}
          {DAYS.map(d => (
            <div key={d.n} className="flex flex-1 border-l border-slate-200">
              {employees.map(emp => {
                const c = EMP_COLORS[emp.colorIdx % EMP_COLORS.length]
                const colSlots = slots.filter(s => s.employee_id === emp.id && s.day === d.n)
                return (
                  <div key={emp.id}
                    className={`relative flex-1 border-r border-slate-100 last:border-0 ${readOnly ? 'cursor-default' : 'cursor-crosshair group'}`}
                    style={{ height: G_H }}
                    onClick={ev => addSlot(emp.id, d.n, ev)}
                    onContextMenu={ev => {
                      if ((ev.target as HTMLElement).closest('[data-slot]')) return
                      ev.preventDefault()
                      if (onGridRightClick && !readOnly) {
                        const rect = ev.currentTarget.getBoundingClientRect()
                        const minuteAt = Math.max(G_START, Math.min(G_END - 30, snap(y2m(ev.clientY - rect.top))))
                        onGridRightClick(emp.id, d.n, minuteAt, ev.clientX, ev.clientY)
                      }
                    }}
                  >
                    {HOURS.map(h => <div key={h} className="absolute w-full border-t border-slate-100 pointer-events-none" style={{ top: m2y(h * 60) }} />)}
                    {HOURS.map(h => <div key={`hh${h}`} className="absolute w-full border-t border-slate-50 pointer-events-none" style={{ top: m2y(h * 60 + 30) }} />)}

                    {/* Day overlays : congé / férié */}
                    {dayOverlays.filter(o => (o.employee_id === '*' || o.employee_id === emp.id) && o.day === d.n).map((o, oi) => (
                      <div key={oi} className="absolute inset-0 z-[5] flex flex-col items-center justify-center gap-1"
                        style={{ background: `${o.color}1a`, borderLeft: `3px solid ${o.color}40` }}
                        onClick={ev => ev.stopPropagation()}>
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ color: o.color, background: `${o.color}22` }}>{o.label}</span>
                      </div>
                    ))}

                    {!readOnly && colSlots.length === 0 && dayOverlays.filter(o => (o.employee_id === '*' || o.employee_id === emp.id) && o.day === d.n).length === 0 && (
                      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                        <span className="text-[9px] text-slate-300">+ ajouter</span>
                      </div>
                    )}

                    {leavePartialSlots.filter(lp => lp.employee_id === emp.id && lp.day === d.n).map(lp => {
                      const top = m2y(lp.start_min)
                      const height = Math.max(16, (lp.end_min - lp.start_min) * PX_MIN)
                      return (
                        <div key={lp.id} data-slot="true"
                          className="absolute left-0.5 right-0.5 rounded-lg overflow-hidden group/slot"
                          style={{ top, height, zIndex: 4, background: 'repeating-linear-gradient(45deg,#93c5fd 0px,#93c5fd 3px,#eff6ff 3px,#eff6ff 9px)', border: '1.5px solid #3b82f6', boxShadow: '0 1px 3px rgba(59,130,246,0.2)' }}
                          onContextMenu={ev => { ev.preventDefault(); ev.stopPropagation() }}
                        >
                          <div className="flex flex-col items-center justify-center h-full pointer-events-none gap-px">
                            {height > 16 && <span className="text-[7px] font-bold text-blue-700 leading-none uppercase tracking-wide">Congé</span>}
                            {height > 28 && <span className="text-[8px] text-blue-600 leading-none font-semibold">{m2t(lp.start_min)}–{m2t(lp.end_min)}</span>}
                            {height > 48 && <span className="text-[7px] text-blue-400 leading-none">{fmtM(lp.end_min - lp.start_min)}</span>}
                          </div>
                          {!readOnly && onDeleteLeavePartial && (
                            <button
                              className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-white/0 hover:bg-white/90 text-[10px] font-black text-blue-600 hover:text-red-500 leading-none flex items-center justify-center opacity-0 group-hover/slot:opacity-100 transition-all z-20 cursor-pointer"
                              onMouseDown={ev => ev.stopPropagation()}
                              onClick={ev => { ev.stopPropagation(); onDeleteLeavePartial(lp.id) }}
                              title="Supprimer ce congé horaire"
                            >×</button>
                          )}
                        </div>
                      )
                    })}

                    {colSlots.map(slot => {
                      const top = m2y(slot.start_min)
                      const height = Math.max(16, (slot.end_min - slot.start_min) * PX_MIN)
                      const isEdit = editId === slot.id
                      const isForm = !!slot.is_formation
                      const borderColor = '#94a3b8'
                      return (
                        <div key={slot.id} data-slot="true"
                          className={`absolute left-0.5 right-0.5 rounded-lg overflow-hidden ${readOnly ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'} group/slot`}
                          style={{
                            top, height, zIndex: isEdit ? 10 : 2,
                            background: isForm
                              ? 'repeating-linear-gradient(45deg,#e2e8f0 0px,#e2e8f0 3px,#f8fafc 3px,#f8fafc 9px)'
                              : c.bg,
                            border: isForm ? `1.5px solid ${borderColor}` : undefined,
                            boxShadow: isEdit
                              ? `0 0 0 2px white, 0 0 0 3px ${isForm ? borderColor : c.bg}, 0 4px 12px rgba(0,0,0,0.15)`
                              : '0 1px 3px rgba(0,0,0,0.12)',
                          }}
                          onMouseDown={ev => { ev.stopPropagation(); startDrag('move', slot.id, ev) }}
                          onClick={ev => { ev.stopPropagation(); if (!readOnly) setEditId(isEdit ? null : slot.id) }}
                          onContextMenu={ev => { ev.preventDefault(); ev.stopPropagation(); if (!readOnly) { setCtxMenu({ x: ev.clientX, y: ev.clientY, slotId: slot.id }); setEditId(null) } }}
                        >
                          {!readOnly && <div className={`absolute inset-x-0 top-0 h-2 cursor-ns-resize z-10 ${isForm ? 'hover:bg-slate-400/20' : 'hover:bg-white/20'}`}
                            onMouseDown={ev => { ev.stopPropagation(); startDrag('top', slot.id, ev) }} />}
                          <div className="flex flex-col items-center justify-center h-full pointer-events-none gap-px">
                            {isForm ? (<>
                              {height > 18 && <span className="text-[8px] font-bold text-slate-500 leading-none uppercase tracking-wide">Formation</span>}
                              {height > 34 && <span className="text-[8px] text-slate-400 leading-none">{fmtM(eff(slot))}</span>}
                            </>) : (<>
                              {height > 30 && <span className="text-[9px] font-semibold leading-none text-white">{m2t(slot.start_min)}</span>}
                              {height > 46 && <span className="text-[9px] leading-none text-white opacity-70">{fmtM(eff(slot))}</span>}
                              {height > 62 && <span className="text-[9px] font-semibold leading-none text-white">{m2t(slot.end_min)}</span>}
                            </>)}
                          </div>
                          {!readOnly && <div className={`absolute inset-x-0 bottom-0 h-2 cursor-ns-resize z-10 ${isForm ? 'hover:bg-slate-400/20' : 'hover:bg-white/20'}`}
                            onMouseDown={ev => { ev.stopPropagation(); startDrag('bot', slot.id, ev) }} />}
                          {/* Bouton × de suppression rapide */}
                          {!readOnly && (
                            <button
                              className={`absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-white/0 hover:bg-white/90 text-[10px] font-black leading-none flex items-center justify-center opacity-0 group-hover/slot:opacity-100 transition-all z-20 cursor-pointer ${isForm ? 'text-slate-500 hover:text-red-500' : 'text-white hover:text-red-500'}`}
                              onMouseDown={ev => ev.stopPropagation()}
                              onClick={ev => {
                                ev.stopPropagation()
                                onChange(slots.filter(s => s.id !== slot.id))
                                setEditId(null)
                              }}
                              title="Supprimer ce créneau"
                            >
                              ×
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Edit panel */}
      {editSlot && !readOnly && (
        <div className="border-t border-slate-100 bg-slate-50 px-5 py-3 flex flex-wrap items-center gap-4">
          <span className="text-xs font-semibold text-slate-600">
            {employees.find(e => e.id === editSlot.employee_id)?.name}
          </span>
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-slate-400">Début</span>
            <input type="time" value={m2t(editSlot.start_min)}
              onChange={e => onChange(slots.map(s => s.id === editSlot.id ? { ...s, start_min: t2m(e.target.value) } : s))}
              className="border border-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-200 bg-white" />
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-slate-400">Fin</span>
            <input type="time" value={m2t(editSlot.end_min)}
              onChange={e => onChange(slots.map(s => s.id === editSlot.id ? { ...s, end_min: t2m(e.target.value) } : s))}
              className="border border-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-200 bg-white" />
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-slate-400">Pause</span>
            <input type="number" min={0} max={120} value={editSlot.break_min}
              onChange={e => onChange(slots.map(s => s.id === editSlot.id ? { ...s, break_min: parseInt(e.target.value) || 0 } : s))}
              className="w-14 border border-slate-200 rounded-lg px-2 py-1 text-xs text-center focus:outline-none focus:ring-2 focus:ring-indigo-200 bg-white" />
            <span className="text-slate-300 text-xs">min</span>
          </div>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="checkbox" checked={!!editSlot.is_formation}
              onChange={e => onChange(slots.map(s => s.id === editSlot.id ? { ...s, is_formation: e.target.checked } : s))}
              className="rounded" />
            <span className="text-slate-500">Formation</span>
          </label>
          <span className="text-xs font-bold text-slate-700">= {fmtM(eff(editSlot))} net</span>
          <div className="ml-auto flex gap-2">
            <button onClick={() => { onChange(slots.filter(s => s.id !== editSlot.id)); setEditId(null) }}
              className="text-xs text-red-400 hover:text-red-600 px-3 py-1.5 rounded-lg hover:bg-red-50 transition-colors">
              Supprimer
            </button>
            <button onClick={() => setEditId(null)}
              className="text-xs text-slate-400 hover:text-slate-600 px-3 py-1.5 rounded-lg hover:bg-slate-50 transition-colors">
              ✕ Fermer
            </button>
          </div>
        </div>
      )}

      {/* Footer totals */}
      {showFooter && <div className="flex flex-wrap gap-4 px-5 py-3 border-t border-slate-100 bg-white">
        {employees.map(emp => {
          const c = EMP_COLORS[emp.colorIdx % EMP_COLORS.length]
          const workTot = slots.filter(s => s.employee_id === emp.id && !s.is_formation).reduce((a, s) => a + eff(s), 0)
          const formTot = slots.filter(s => s.employee_id === emp.id && s.is_formation).reduce((a, s) => a + eff(s), 0)
          return (
            <div key={emp.id} className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full" style={{ background: c.bg }} />
              <span className="text-xs text-slate-600 font-medium">{emp.name}</span>
              <span className="text-xs font-bold" style={{ color: c.bg }}>{fmtM(workTot)}/sem.</span>
              {formTot > 0 && (
                <span className="text-[10px] italic text-slate-400">+{fmtM(formTot)} formation</span>
              )}
            </div>
          )
        })}
        {!readOnly && (
          <span className="text-[10px] text-slate-300 ml-auto italic">Cliquer pour ajouter · Clic droit pour options · Glisser · Étirer les bords</span>
        )}
      </div>}

      {/* Context menu clic droit */}
      {ctxSlot && ctxMenu && !readOnly && (
        <div
          className="fixed z-[100] bg-white border border-slate-200 rounded-xl shadow-2xl overflow-hidden"
          style={{ left: ctxMenu.x, top: ctxMenu.y, minWidth: 210 }}
          onClick={e => e.stopPropagation()}
        >
          {/* En-tête */}
          <div className="px-3 pt-3 pb-2 bg-gradient-to-b from-slate-50 to-white border-b border-slate-100">
            <div className="text-[13px] font-bold text-slate-700 tabular-nums">
              {m2t(ctxSlot.start_min)} – {m2t(ctxSlot.end_min)}
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">{fmtM(eff(ctxSlot))} net de travail</div>
          </div>

          {/* Formation */}
          <button
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors ${ctxSlot.is_formation ? 'bg-violet-50' : 'hover:bg-slate-50'}`}
            onClick={() => { patchSlot(ctxSlot.id, { is_formation: !ctxSlot.is_formation }); setCtxMenu(null) }}
          >
            <span className="text-base leading-none">🎓</span>
            <span className={`flex-1 text-left font-medium ${ctxSlot.is_formation ? 'text-violet-700' : 'text-slate-600'}`}>Formation</span>
            {ctxSlot.is_formation
              ? <span className="text-[10px] font-bold bg-violet-100 text-violet-600 px-1.5 py-0.5 rounded-full">ON</span>
              : <span className="text-[10px] text-slate-300">OFF</span>}
          </button>

          {/* Pause */}
          <div className="px-3 py-2 border-t border-slate-100">
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="text-sm leading-none">⏸</span>
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">Pause</span>
            </div>
            <div className="flex gap-1">
              {[0, 15, 30, 45, 60].map(min => (
                <button key={min}
                  className={`flex-1 py-1 text-[10px] rounded-lg font-semibold transition-colors ${ctxSlot.break_min === min ? 'bg-indigo-500 text-white shadow-sm' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                  onClick={() => { patchSlot(ctxSlot.id, { break_min: min }); setCtxMenu(null) }}
                >
                  {min === 0 ? '–' : `${min}'`}
                </button>
              ))}
            </div>
          </div>

          {/* Congés */}
          {(onMarkLeave || onGridRightClick) && (
            <div className="border-t border-slate-100">
              {onGridRightClick && (
                <button
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-blue-600 hover:bg-blue-50 transition-colors"
                  onClick={() => { onGridRightClick(ctxSlot.employee_id, ctxSlot.day, ctxSlot.start_min, ctxMenu!.x, ctxMenu!.y); setCtxMenu(null) }}
                >
                  <span className="text-base leading-none">🕐</span>
                  <span className="font-medium">Congé horaire…</span>
                </button>
              )}
              {onMarkLeave && (<>
                <button
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-slate-600 hover:bg-amber-50 hover:text-amber-700 transition-colors"
                  onClick={() => { onMarkLeave(ctxSlot.employee_id, ctxSlot.day, 'leave_day'); setCtxMenu(null) }}
                >
                  <span className="text-base leading-none">☀️</span>
                  <span className="font-medium">Congé ce jour</span>
                </button>
                <button
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-slate-600 hover:bg-amber-50 hover:text-amber-700 transition-colors"
                  onClick={() => { onMarkLeave(ctxSlot.employee_id, ctxSlot.day, 'leave_week'); setCtxMenu(null) }}
                >
                  <span className="text-base leading-none">🌴</span>
                  <span className="font-medium">Congé toute la semaine</span>
                </button>
              </>)}
            </div>
          )}

          {/* Supprimer */}
          <button
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-red-400 hover:bg-red-50 hover:text-red-500 border-t border-slate-100 transition-colors"
            onClick={() => { onChange(slots.filter(s => s.id !== ctxSlot.id)); setCtxMenu(null); setEditId(null) }}
          >
            <span className="text-base leading-none">🗑</span>
            <span className="font-medium">Supprimer ce créneau</span>
          </button>
        </div>
      )}
    </div>
  )
}
