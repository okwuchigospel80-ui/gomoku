// Canvas board renderer. Kept separate from game logic: it only reads
// (board, size, lastMove, winCells) and never decides anything.

import { AXIS, BLACK, EMPTY, type Color } from './board'

const PAD = 1.0 // padding in cells around the grid
const MARGIN = 0.7

export interface Stone {
  i: number
  color: Color
  /** 0..1 pop-in progress */
  born: number
}

export class BoardView {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private dpr = 1
  private size = 0
  private gridSize = 15
  private cell = 0
  private origin = 0

  private stones = new Map<number, Stone>()
  private hover: number | null = null
  private winCells: number[] = []
  private lastMove: number | null = null
  private raf = 0
  private dirty = true

  /** Colour the hover ghost shows; the app keeps this in sync with whose turn it is. */
  nextColor: Color = BLACK

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    this.ctx = ctx
    this.resize()
    window.addEventListener('resize', () => this.resize())
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e))
    canvas.addEventListener('pointerleave', () => {
      this.hover = null
      this.invalidate()
    })
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e))
    this.loop()
  }

  /** Change the grid size; stones are dropped because the position is reset too. */
  setGridSize(n: number) {
    if (n === this.gridSize) return
    this.gridSize = n
    this.stones.clear()
    this.hover = null
    this.winCells = []
    this.lastMove = null
    this.resize()
  }

  /** Called by the app with the authoritative board. */
  setPosition(board: Uint8Array, winCells: number[], lastMove: number | null = null) {
    this.winCells = winCells
    if (lastMove !== this.lastMove) {
      this.lastMove = lastMove
      this.invalidate()
    }
    const seen = new Set<number>()
    for (let i = 0; i < board.length; i++) {
      if (board[i] !== EMPTY) {
        seen.add(i)
        const existing = this.stones.get(i)
        if (!existing) {
          this.stones.set(i, { i, color: board[i] as Color, born: 0 })
        } else if (existing.color !== board[i]) {
          existing.color = board[i] as Color
          existing.born = 0
        }
      }
    }
    for (const key of [...this.stones.keys()]) if (!seen.has(key)) this.stones.delete(key)
    this.invalidate()
  }

  invalidate() {
    this.dirty = true
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
    const cssSize = Math.max(280, Math.min(rect.width || 560, rect.height || 560))
    this.dpr = dpr
    this.size = cssSize
    this.canvas.width = Math.round(cssSize * dpr)
    this.canvas.height = Math.round(cssSize * dpr)
    this.cell = cssSize / (this.gridSize + PAD * 2 - 1 + MARGIN * 2)
    this.origin = PAD * this.cell + MARGIN * this.cell
    this.invalidate()
  }

  private toPixel(x: number, y: number): [number, number] {
    return [this.origin + x * this.cell, this.origin + y * this.cell]
  }

  private hitTest(clientX: number, clientY: number): number | null {
    const rect = this.canvas.getBoundingClientRect()
    const px = clientX - rect.left
    const py = clientY - rect.top
    const x = Math.round((px - this.origin) / this.cell)
    const y = Math.round((py - this.origin) / this.cell)
    if (x < 0 || x >= this.gridSize || y < 0 || y >= this.gridSize) return null
    const [cx, cy] = this.toPixel(x, y)
    const dist = Math.hypot(px - cx, py - cy)
    return dist <= this.cell * 0.62 ? y * this.gridSize + x : null
  }

  private onPointerMove(e: PointerEvent) {
    const hit = this.hitTest(e.clientX, e.clientY)
    if (hit !== this.hover) {
      this.hover = hit
      this.invalidate()
    }
    this.canvas.style.cursor = hit !== null ? 'pointer' : 'default'
  }

  private onPointerDown(e: PointerEvent) {
    const hit = this.hitTest(e.clientX, e.clientY)
    if (hit !== null) this.canvas.dispatchEvent(new CustomEvent('board:place', { detail: hit }))
  }

  private loop = () => {
    const needsFrame = [...this.stones.values()].some((s) => s.born < 1)
    if (this.dirty || needsFrame) {
      this.dirty = false
      this.draw(needsFrame)
    }
    this.raf = requestAnimationFrame(this.loop)
  }

  private draw(animate: boolean) {
    const { ctx } = this
    const s = this.size
    ctx.save()
    ctx.scale(this.dpr, this.dpr)
    ctx.clearRect(0, 0, s, s)

    this.drawBoardSurface()
    this.drawGrid()
    this.drawStars()
    this.drawCoords()
    this.drawHover()
    this.drawStones(animate ? 0.14 : 1)
    this.drawLastMove()
    this.drawWinLine()
    ctx.restore()
  }

  private drawBoardSurface() {
    const { ctx, size: s } = this
    const grad = ctx.createLinearGradient(0, 0, s, s)
    grad.addColorStop(0, '#e8c894')
    grad.addColorStop(0.5, '#dfb87e')
    grad.addColorStop(1, '#d3a76a')
    ctx.fillStyle = grad
    this.roundRect(0, 0, s, s, s * 0.018)
    ctx.fill()

    const vig = ctx.createRadialGradient(s / 2, s / 2, s * 0.25, s / 2, s / 2, s * 0.75)
    vig.addColorStop(0, 'rgba(255,255,255,0.12)')
    vig.addColorStop(1, 'rgba(120,80,30,0.14)')
    ctx.fillStyle = vig
    this.roundRect(0, 0, s, s, s * 0.018)
    ctx.fill()
  }

  private drawGrid() {
    const { ctx } = this
    const [x0, y0] = this.toPixel(0, 0)
    const [x1, y1] = this.toPixel(this.gridSize - 1, this.gridSize - 1)

    ctx.strokeStyle = 'rgba(72,44,16,0.72)'
    ctx.lineWidth = Math.max(1, this.cell * 0.022)
    ctx.beginPath()
    for (let i = 0; i < this.gridSize; i++) {
      const [px] = this.toPixel(i, i)
      const [, py] = this.toPixel(i, i)
      ctx.moveTo(px, y0)
      ctx.lineTo(px, y1)
      ctx.moveTo(x0, py)
      ctx.lineTo(x1, py)
    }
    ctx.stroke()

    ctx.lineWidth = Math.max(1.4, this.cell * 0.045)
    ctx.strokeStyle = 'rgba(60,36,12,0.85)'
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
  }

  /**
   * Star points scale with the board: the classic 3-3 / 3-mid / centre layout on
   * 15 and 19, corner-and-centre on 9 and 13.
   */
  private drawStars() {
    const { ctx } = this
    const n = this.gridSize
    const pts: Array<[number, number]> = []
    if (n >= 15) {
      const a = 3
      const b = n - 4
      const m = (n - 1) / 2
      pts.push([a, a], [b, a], [a, b], [b, b], [m, m])
    } else {
      const m = (n - 1) / 2
      pts.push([m, m])
      if (n >= 13) {
        const a = 3
        const b = n - 4
        pts.push([a, a], [b, a], [a, b], [b, b])
      }
    }
    ctx.fillStyle = 'rgba(50,30,10,0.9)'
    for (const [x, y] of pts) {
      const [px, py] = this.toPixel(x, y)
      ctx.beginPath()
      ctx.arc(px, py, Math.max(1.8, this.cell * 0.075), 0, Math.PI * 2)
      ctx.fill()
    }
  }

  private drawCoords() {
    const { ctx } = this
    const n = this.gridSize
    const fs = Math.max(7, this.cell * 0.28)
    ctx.fillStyle = 'rgba(70,44,18,0.55)'
    ctx.font = `500 ${fs}px ui-sans-serif, system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let i = 0; i < n; i++) {
      const [px] = this.toPixel(i, i)
      const [, bottom] = this.toPixel(i, n - 1)
      ctx.fillText(AXIS[i], px, bottom + this.cell * 0.62)
      const [left, py] = this.toPixel(0, i)
      ctx.fillText(String(n - i), left - this.cell * 0.62, py)
    }
  }

  private drawHover() {
    if (this.hover === null) return
    if (this.stones.has(this.hover)) return
    const { ctx } = this
    const x = this.hover % this.gridSize
    const y = Math.floor(this.hover / this.gridSize)
    const [px, py] = this.toPixel(x, y)
    ctx.fillStyle = this.nextColor === BLACK ? 'rgba(20,20,20,0.22)' : 'rgba(255,255,255,0.4)'
    ctx.beginPath()
    ctx.arc(px, py, this.cell * 0.4, 0, Math.PI * 2)
    ctx.fill()
  }

  private drawStones(ease: number) {
    const { ctx } = this
    const r = this.cell * 0.44
    const sorted = [...this.stones.values()].sort((a, b) => a.born - b.born)
    for (const stone of sorted) {
      if (stone.born < 1) stone.born = Math.min(1, stone.born + ease)
      const x = stone.i % this.gridSize
      const y = Math.floor(stone.i / this.gridSize)
      const [px, py] = this.toPixel(x, y)
      const t = stone.born
      const scale = t >= 1 ? 1 : 1.06 - Math.cos(t * Math.PI * 0.5) * 0.12

      const rad = r * scale
      ctx.beginPath()
      ctx.ellipse(px + rad * 0.12, py + rad * 0.2, rad * 0.95, rad * 0.8, 0, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(60,36,12,0.22)'
      ctx.fill()

      const g = ctx.createRadialGradient(
        px - rad * 0.34,
        py - rad * 0.38,
        rad * 0.1,
        px,
        py,
        rad * 1.06,
      )
      if (stone.color === BLACK) {
        g.addColorStop(0, '#6d6f75')
        g.addColorStop(0.42, '#2c2e33')
        g.addColorStop(1, '#05060a')
      } else {
        g.addColorStop(0, '#ffffff')
        g.addColorStop(0.55, '#f2f3f5')
        g.addColorStop(1, '#c9ccd2')
      }
      ctx.beginPath()
      ctx.arc(px, py, rad, 0, Math.PI * 2)
      ctx.fillStyle = g
      ctx.fill()

      ctx.lineWidth = Math.max(0.6, rad * 0.05)
      ctx.strokeStyle = stone.color === BLACK ? 'rgba(0,0,0,0.55)' : 'rgba(120,124,132,0.45)'
      ctx.stroke()

      ctx.beginPath()
      ctx.ellipse(px - rad * 0.32, py - rad * 0.36, rad * 0.26, rad * 0.18, -0.7, 0, Math.PI * 2)
      ctx.fillStyle = stone.color === BLACK ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.85)'
      ctx.fill()
    }
  }

  /** Ring around the most recent stone, so remote players can see the last move. */
  private drawLastMove() {
    if (this.lastMove === null || this.winCells.length > 0) return
    if (!this.stones.has(this.lastMove)) return
    const { ctx } = this
    const x = this.lastMove % this.gridSize
    const y = Math.floor(this.lastMove / this.gridSize)
    const [px, py] = this.toPixel(x, y)
    ctx.save()
    ctx.strokeStyle = 'rgba(226,106,95,0.95)'
    ctx.lineWidth = Math.max(1.6, this.cell * 0.055)
    ctx.beginPath()
    ctx.arc(px, py, this.cell * 0.46, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  private drawWinLine() {
    if (this.winCells.length === 0) return
    const { ctx } = this
    const first = this.winCells[0]
    const last = this.winCells[this.winCells.length - 1]
    const [x0, y0] = this.toPixel(first % this.gridSize, Math.floor(first / this.gridSize))
    const [x1, y1] = this.toPixel(last % this.gridSize, Math.floor(last / this.gridSize))

    ctx.save()
    ctx.strokeStyle = 'rgba(255,72,72,0.78)'
    ctx.lineWidth = Math.max(2, this.cell * 0.1)
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
    ctx.restore()
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number) {
    const { ctx } = this
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }

  dispose() {
    cancelAnimationFrame(this.raf)
  }
}
