// Drawing surface for 你画我猜.
//
// Independent of `renderer.ts` (which knows about grids and stones) but follows
// the same shape: a class that owns the canvas, resizes with the element, and
// never decides game rules.
//
// Coordinate model: a stroke is a flat list of points in 0..1 relative to the
// canvas. The two screens have different pixel sizes, so normalised points are
// the only thing that can be exchanged. The in-progress stroke is kept normalised
// too, which means resizing mid-stroke does not warp it.
//
// Rendering: the whole sheet is repainted whenever something changes. At most
// 300 short strokes are on it, so a full repaint is cheap and far less bug-prone
// than tracking incremental damage.
//
// Committed strokes are painted SYNCHRONOUSLY when they arrive. Relying on
// requestAnimationFrame for that looked fine in a focused tab but silently
// dropped every remote stroke in a background one, where the browser throttles
// rAF to almost zero: the state arrived (`strokes: 1`) and the canvas stayed
// blank. Only the in-progress pen stroke is allowed to coalesce via rAF, because
// it is invisible to everyone but the person drawing.

import type { Stroke } from './drawguess.ts'

/** Paper colours, matched to the parchment tone used by the gomoku board. */
const PAPER_TOP = '#f8f3e8'
const PAPER_BOTTOM = '#eee4d0'
const INK = '#2f2a24'

export interface DrawHandlers {
  /** A finished stroke: normalised points + normalised width. */
  onStroke(pts: number[], w: number): void
}

export class DrawCanvas {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private dpr = 1
  /** CSS pixel size of the square drawing area. */
  private size = 0
  private handlers: DrawHandlers

  /** Committed strokes from the room, in seq order. */
  private strokes: Stroke[] = []
  /** The stroke under the pointer, normalised. */
  private live: number[] = []
  private drawing = false
  private raf = 0
  private dirty = true
  private enabled = false
  private ro: ResizeObserver | null = null

  /** Fixed pen width in normalised units (fraction of the canvas width). */
  readonly penWidth = 0.006

  constructor(canvas: HTMLCanvasElement, handlers: DrawHandlers) {
    this.canvas = canvas
    this.handlers = handlers
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    this.ctx = ctx
    this.resize()
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize())
      this.ro.observe(canvas)
    } else {
      window.addEventListener('resize', () => this.resize())
    }
    canvas.addEventListener('pointerdown', (e) => this.onDown(e))
    canvas.addEventListener('pointermove', (e) => this.onMove(e))
    canvas.addEventListener('pointerup', (e) => this.onUp(e))
    canvas.addEventListener('pointercancel', () => this.onCancel())
    canvas.addEventListener('lostpointercapture', () => {
      if (this.drawing) this.onCancel()
    })
    canvas.addEventListener('pointerleave', () => {
      // A stroke that leaves the canvas finishes where it left.
      if (this.drawing) this.finishStroke()
    })
    this.loop()
  }

  /** Only the current drawer may paint. */
  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.canvas.classList.toggle('dg-canvas-disabled', !enabled)
    if (!enabled) this.onCancel()
  }

  get isDrawing(): boolean {
    return this.drawing
  }

  /** Feed the authoritative stroke list. Paints immediately — see the note above. */
  sync(strokes: Stroke[]) {
    const sorted = [...strokes].sort((a, b) => a.seq - b.seq)
    // Cheap identity check: the common case is "nothing new".
    if (sorted.length === this.strokes.length && sorted.every((s, i) => s === this.strokes[i])) return
    this.strokes = sorted
    this.paintNow()
  }

  /** Drop the local sheet without waiting for the network (optimistic clear). */
  clearLocal() {
    this.strokes = []
    this.live = []
    this.drawing = false
    this.paintNow()
  }

  /** Coalesce the in-progress pen stroke to the next frame. */
  invalidate() {
    this.dirty = true
  }

  /** Repaint right now, bypassing rAF (used for authoritative updates). */
  private paintNow() {
    this.dirty = false
    this.redraw()
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
    const cssSize = Math.max(200, Math.min(rect.width || 480, rect.height || 480))
    if (cssSize === this.size && this.dpr === dpr) return
    this.dpr = dpr
    this.size = cssSize
    this.canvas.width = Math.round(cssSize * dpr)
    this.canvas.height = Math.round(cssSize * dpr)
    this.paintNow()
  }

  private toNormalized(e: PointerEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect()
    const x = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0
    const y = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]
  }

  private onDown(e: PointerEvent) {
    if (!this.enabled) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    try {
      this.canvas.setPointerCapture(e.pointerId)
    } catch {
      /* capture is an optimisation */
    }
    this.drawing = true
    this.live = []
    const [x, y] = this.toNormalized(e)
    this.live.push(x, y)
    this.invalidate()
  }

  private onMove(e: PointerEvent) {
    if (!this.drawing) return
    e.preventDefault()
    const [x, y] = this.toNormalized(e)
    const n = this.live.length
    // Skip sub-pixel jitter: it bloats the message without changing the picture.
    if (n >= 2) {
      const dx = x - this.live[n - 2]
      const dy = y - this.live[n - 1]
      if (dx * dx + dy * dy < 0.000008) return
    }
    this.live.push(x, y)
    this.invalidate()
  }

  private onUp(e: PointerEvent) {
    if (!this.drawing) return
    e.preventDefault()
    this.finishStroke()
  }

  private onCancel() {
    this.drawing = false
    this.live = []
    this.invalidate()
  }

  private finishStroke() {
    this.drawing = false
    const pts = this.live
    this.live = []
    if (pts.length < 4) {
      this.invalidate()
      return
    }
    this.handlers.onStroke(pts, this.penWidth)
    this.invalidate()
  }

  private loop = () => {
    if (this.dirty) this.paintNow()
    this.raf = requestAnimationFrame(this.loop)
  }

  private redraw() {
    const { ctx } = this
    ctx.save()
    ctx.scale(this.dpr, this.dpr)
    this.paintPaper()
    for (const st of this.strokes) this.strokePath(st.pts, st.w)
    if (this.live.length >= 4) this.strokePath(this.live, this.penWidth)
    ctx.restore()
  }

  private paintPaper() {
    const { ctx, size: s } = this
    ctx.clearRect(0, 0, s, s)
    const grad = ctx.createLinearGradient(0, 0, s, s)
    grad.addColorStop(0, PAPER_TOP)
    grad.addColorStop(1, PAPER_BOTTOM)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, s, s)

    // Faint grid for a sketchbook feel.
    ctx.save()
    ctx.strokeStyle = 'rgba(120, 96, 64, 0.10)'
    ctx.lineWidth = 1
    const step = s / 16
    ctx.beginPath()
    for (let i = 1; i < 16; i++) {
      ctx.moveTo(i * step, 0)
      ctx.lineTo(i * step, s)
      ctx.moveTo(0, i * step)
      ctx.lineTo(s, i * step)
    }
    ctx.stroke()
    ctx.restore()

    // Vignette so the sheet reads as paper rather than a flat div.
    const vig = ctx.createRadialGradient(s / 2, s / 2, s * 0.3, s / 2, s / 2, s * 0.78)
    vig.addColorStop(0, 'rgba(255,255,255,0.15)')
    vig.addColorStop(1, 'rgba(150,120,80,0.10)')
    ctx.fillStyle = vig
    ctx.fillRect(0, 0, s, s)
  }

  private strokePath(pts: number[], w: number) {
    const { ctx, size: s } = this
    if (pts.length < 4) return
    ctx.strokeStyle = INK
    ctx.lineWidth = Math.max(0.8, w * s)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(pts[0] * s, pts[1] * s)
    if (pts.length === 4) {
      // A tap: a zero-length segment draws nothing with round caps on some
      // engines, so nudge it by a sub-pixel.
      ctx.lineTo(pts[2] * s + 0.01, pts[3] * s + 0.01)
    } else {
      for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(pts[i] * s, pts[i + 1] * s)
    }
    ctx.stroke()
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.ro?.disconnect()
  }
}
