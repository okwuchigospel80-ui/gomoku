// Pure gomoku rules. The board side length is a parameter rather than a module
// constant, so a room can switch between the offered sizes without reloading.
// Everything here is a deterministic function of (history, size) — that is what
// makes multi-client sync trivial: equal history means an identical board.

export const DEFAULT_SIZE = 15
/** 15 is the floor; the three larger steps give a longer, roomier game. */
export const BOARD_SIZES = [15, 19, 21, 23] as const
export type BoardSize = (typeof BOARD_SIZES)[number]

export const EMPTY = 0
export const BLACK = 1
export const WHITE = 2
export type Color = 1 | 2

/**
 * Column labels, I and O omitted so they are not read as 1 and 0.
 * 23 entries covers the largest board we offer.
 */
export const AXIS = 'ABCDEFGHJKLMNPQRSTUVWXY'

export const idx = (x: number, y: number, size: number) => y * size + x
export const xy = (i: number, size: number): [number, number] => [i % size, Math.floor(i / size)]
export const cellCount = (size: number) => size * size

export const inBounds = (x: number, y: number, size: number) =>
  x >= 0 && x < size && y >= 0 && y < size

export type Outcome =
  | { status: 'playing' }
  | { status: 'win'; winner: Color; cells: number[] }
  | { status: 'draw' }

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
]

/** The whole run through (x,y) for `color`, or null. Runs longer than five count. */
export function winAt(
  board: Uint8Array,
  x: number,
  y: number,
  color: Color,
  size: number,
): number[] | null {
  for (const [dx, dy] of DIRECTIONS) {
    const run = [idx(x, y, size)]
    for (const sign of [1, -1] as const) {
      let cx = x + dx * sign
      let cy = y + dy * sign
      while (inBounds(cx, cy, size) && board[idx(cx, cy, size)] === color) {
        run.push(idx(cx, cy, size))
        cx += dx * sign
        cy += dy * sign
      }
    }
    if (run.length >= 5) return run.sort((a, b) => a - b)
  }
  return null
}

export const colorOf = (moveNumber: number): Color => (moveNumber % 2 === 0 ? BLACK : WHITE)
export const other = (c: Color): Color => (c === BLACK ? WHITE : BLACK)

export interface Replay {
  board: Uint8Array
  size: number
  outcome: Outcome
  /** Moves that actually landed (history entries that were legal). */
  placed: number
  /** Colour to move next. */
  turn: Color
  /** Index into the source history of each move that landed. */
  landed: number[]
}

/** Rebuild the whole position from the move list. Illegal entries are skipped. */
export function replay(hist: readonly number[], size: number): Replay {
  const total = cellCount(size)
  const board = new Uint8Array(total)
  const landed: number[] = []
  let outcome: Outcome = { status: 'playing' }

  for (let h = 0; h < hist.length; h++) {
    const i = hist[h]
    if (!Number.isInteger(i) || i < 0 || i >= total) continue
    if (board[i] !== EMPTY) continue

    const color = colorOf(landed.length)
    board[i] = color
    landed.push(h)

    const [x, y] = xy(i, size)
    const cells = winAt(board, x, y, color, size)
    if (cells) {
      outcome = { status: 'win', winner: color, cells }
      break
    }
  }

  const placed = landed.length
  if (outcome.status === 'playing' && placed >= total) outcome = { status: 'draw' }

  return { board, size, outcome, placed, turn: colorOf(placed), landed }
}

/**
 * Length to truncate the history to so that `color` takes back their OWN last
 * move, together with whatever the opponent played after it.
 *
 * Taking back "my own move" is what players actually mean by 悔棋: after you
 * see the reply you want to try something else. Returns null when that colour
 * has not placed a stone yet.
 */
export function undoTarget(hist: readonly number[], size: number, color: Color): number | null {
  const { landed } = replay(hist, size)
  for (let k = landed.length - 1; k >= 0; k--) {
    if (colorOf(k) === color) return landed[k]
  }
  return null
}

/** Coerce anything that came off the wire into a size we support. */
export function normalizeSize(raw: unknown): BoardSize {
  const n = typeof raw === 'number' ? raw : Number.NaN
  return (BOARD_SIZES as readonly number[]).includes(n) ? (n as BoardSize) : DEFAULT_SIZE
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function randomRoomCode(len = 6): string {
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

/** Accepts "abc-def", "ABCDEF", " abc def " → "ABCDEF". */
export function normalizeRoom(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
}

export function formatRoom(code: string): string {
  return code.length > 3 ? `${code.slice(0, 3)}-${code.slice(3)}` : code
}
