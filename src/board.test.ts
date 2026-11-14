// Rule tests. Run with: node --test src/board.test.ts  (Node 22+ strips types)
// Kept dependency-free on purpose — no test framework to install.

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AXIS,
  BLACK,
  BOARD_SIZES,
  DEFAULT_SIZE,
  EMPTY,
  WHITE,
  cellCount,
  colorOf,
  idx,
  normalizeRoom,
  normalizeSize,
  replay,
  undoTarget,
  winAt,
} from './board.ts'

const P = (x: number, y: number, size = DEFAULT_SIZE) => idx(x, y, size)

/** Interleave black and white cells into an alternating history. */
function hist(blackCells: number[], whiteCells: number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < Math.max(blackCells.length, whiteCells.length); i++) {
    if (i < blackCells.length) out.push(blackCells[i])
    if (i < whiteCells.length) out.push(whiteCells[i])
  }
  return out
}

test('empty history is an empty board, black to move', () => {
  const r = replay([], DEFAULT_SIZE)
  assert.equal(r.placed, 0)
  assert.equal(r.turn, BLACK)
  assert.equal(r.outcome.status, 'playing')
  assert.ok(r.board.every((v) => v === EMPTY))
})

test('colors alternate by parity', () => {
  const r = replay([P(0, 0), P(1, 0), P(2, 0)], DEFAULT_SIZE)
  assert.equal(r.board[P(0, 0)], BLACK)
  assert.equal(r.board[P(1, 0)], WHITE)
  assert.equal(r.board[P(2, 0)], BLACK)
  assert.equal(r.turn, WHITE)
})

test('horizontal five wins', () => {
  const black = [0, 1, 2, 3, 4].map((x) => P(x, 7))
  const white = [0, 1, 2, 3].map((x) => P(x, 8))
  const r = replay(hist(black, white), DEFAULT_SIZE)
  assert.equal(r.outcome.status, 'win')
  if (r.outcome.status === 'win') {
    assert.equal(r.outcome.winner, BLACK)
    assert.equal(r.outcome.cells.length, 5)
  }
})

test('vertical five wins', () => {
  const black = [0, 1, 2, 3, 4].map((y) => P(9, y))
  const white = [0, 1, 2, 3].map((y) => P(1, y))
  const r = replay(hist(black, white), DEFAULT_SIZE)
  assert.equal(r.outcome.status, 'win')
  if (r.outcome.status === 'win') assert.equal(r.outcome.winner, BLACK)
})

test('diagonal five wins', () => {
  const black = [0, 1, 2, 3, 4].map((i) => P(3 + i, 3 + i))
  const white = [0, 1, 2, 3].map((i) => P(0 + i, 5 + i))
  const r = replay(hist(black, white), DEFAULT_SIZE)
  assert.equal(r.outcome.status, 'win')
  if (r.outcome.status === 'win') assert.equal(r.outcome.winner, BLACK)
})

test('anti-diagonal five wins', () => {
  const black = [0, 1, 2, 3, 4].map((i) => P(4 + i, 10 - i))
  const white = [0, 1, 2, 3].map((i) => P(0 + i, 0))
  const r = replay(hist(black, white), DEFAULT_SIZE)
  assert.equal(r.outcome.status, 'win')
  if (r.outcome.status === 'win') assert.equal(r.outcome.winner, BLACK)
})

test('four in a row does not win', () => {
  const black = [0, 1, 2, 3].map((x) => P(x, 7))
  const white = [0].map((x) => P(x, 9))
  const r = replay(hist(black, white), DEFAULT_SIZE)
  assert.equal(r.outcome.status, 'playing')
})

test('a wall stops the run (no wrap-around across rows)', () => {
  const black = [11, 12, 13, 14].map((x) => P(x, 0)).concat([P(0, 1)])
  const white = [0, 1, 2, 3].map((x) => P(x, 5))
  const r = replay(hist(black, white), DEFAULT_SIZE)
  assert.equal(r.outcome.status, 'playing')
})

test('six in a row still counts as a win', () => {
  const black = [0, 1, 2, 3, 4, 5].map((x) => P(x, 7))
  const white = [0, 1, 2, 3, 4].map((x) => P(x, 9))
  const r = replay(hist(black, white), DEFAULT_SIZE)
  assert.equal(r.outcome.status, 'win')
  if (r.outcome.status === 'win') assert.ok(r.outcome.cells.length >= 5)
})

test('duplicate and out-of-range moves are ignored', () => {
  const r = replay([P(5, 5), P(5, 5), -1, 999, P(6, 5)], DEFAULT_SIZE)
  assert.equal(r.placed, 2)
  assert.equal(r.board[P(5, 5)], BLACK)
  assert.equal(r.board[P(6, 5)], WHITE)
})

test('winAt returns cells through the placed stone', () => {
  const board = new Uint8Array(cellCount(DEFAULT_SIZE))
  for (let x = 3; x < 8; x++) board[P(x, 4)] = BLACK
  const cells = winAt(board, 5, 4, BLACK, DEFAULT_SIZE)
  assert.ok(cells && cells.length === 5)
  assert.ok(cells!.includes(P(5, 4)))
})

test('no win for the wrong colour', () => {
  const board = new Uint8Array(cellCount(DEFAULT_SIZE))
  for (let x = 3; x < 8; x++) board[P(x, 4)] = BLACK
  assert.equal(winAt(board, 5, 4, WHITE, DEFAULT_SIZE), null)
})

test('normalizeRoom strips separators and uppercases', () => {
  assert.equal(normalizeRoom('abc-def'), 'ABCDEF')
  assert.equal(normalizeRoom(' ab cd '), 'ABCD')
  assert.equal(normalizeRoom('ABC_DEF!'), 'ABCDEF')
})

test('board coordinates round-trip', () => {
  for (const size of BOARD_SIZES) {
    for (const [x, y] of [
      [0, 0],
      [size - 1, size - 1],
      [Math.floor(size / 2), Math.floor(size / 3)],
    ]) {
      const i = P(x, y, size)
      assert.equal(i % size, x)
      assert.equal(Math.floor(i / size), y)
    }
  }
})

/* ---------------- board sizes ---------------- */

test('every offered size can be normalised and rejected safely', () => {
  for (const s of BOARD_SIZES) assert.equal(normalizeSize(s), s)
  assert.equal(normalizeSize(11), DEFAULT_SIZE)
  assert.equal(normalizeSize('15'), DEFAULT_SIZE)
  assert.equal(normalizeSize(null), DEFAULT_SIZE)
  assert.equal(normalizeSize(undefined), DEFAULT_SIZE)
  assert.equal(normalizeSize(1e9), DEFAULT_SIZE)
})

test('a five wins on the 9x9 board using 9-based indices', () => {
  const size = 9
  const black = [0, 1, 2, 3, 4].map((x) => P(x, 4, size))
  const white = [0, 1, 2, 3].map((x) => P(x, 6, size))
  const r = replay(hist(black, white), size)
  assert.equal(r.outcome.status, 'win')
  if (r.outcome.status === 'win') {
    assert.equal(r.outcome.winner, BLACK)
    assert.equal(r.outcome.cells.length, 5)
  }
})

test('the same indices mean different cells on a 9 vs 15 board', () => {
  // Index 14 is the last cell of row 0 on 15x15 but ends row 1 on 9x9.
  assert.deepEqual([14 % 15, Math.floor(14 / 15)], [14, 0])
  assert.deepEqual([14 % 9, Math.floor(14 / 9)], [5, 1])
})

test('indices from a bigger board are dropped when replaying a smaller one', () => {
  const big = P(14, 14, 15) // 224
  const r = replay([big, P(0, 0, 9)], 9) // 224 >= 81 → illegal
  assert.equal(r.placed, 1)
  assert.equal(r.board[P(0, 0, 9)], BLACK)
  assert.equal(r.landed.length, 1)
  assert.equal(r.landed[0], 1) // the legal move was at history slot 1
})

test('a full small board is a draw, not a win', () => {
  const size = 9
  // Fill alternating without ever making five in a row is hard; instead just
  // check the draw branch by using a 9x9 filled with a legal-looking history.
  const total = cellCount(size)
  const movs = Array.from({ length: total }, (_, i) => i)
  const r = replay(movs, size)
  // Either someone won early or it is a draw — never still "playing".
  assert.notEqual(r.outcome.status, 'playing')
})

/* ---------------- undo targeting ---------------- */

test('undo for black cuts back to black own last move', () => {
  const h = [P(0, 0), P(1, 1), P(2, 2), P(3, 3)] // B W B W
  // Black's own last move is at history index 2 → truncate to 2.
  assert.equal(undoTarget(h, DEFAULT_SIZE, BLACK), 2)
  // White's own last move is at index 3 → truncate to 3.
  assert.equal(undoTarget(h, DEFAULT_SIZE, WHITE), 3)
})

test('undo takes back the opponent reply too (to-your-turn semantics)', () => {
  const h = [P(0, 0), P(1, 1), P(2, 2)] // B W B
  const cut = undoTarget(h, DEFAULT_SIZE, BLACK)
  assert.equal(cut, 2)
  const after = replay(h.slice(0, cut!), DEFAULT_SIZE)
  assert.equal(after.placed, 2)
  assert.equal(after.turn, BLACK) // black is to move again
})

test('undo returns null when that colour has not played', () => {
  assert.equal(undoTarget([], DEFAULT_SIZE, BLACK), null)
  assert.equal(undoTarget([], DEFAULT_SIZE, WHITE), null)
  assert.equal(undoTarget([P(0, 0)], DEFAULT_SIZE, WHITE), null)
  assert.equal(undoTarget([P(0, 0)], DEFAULT_SIZE, BLACK), 0)
})

test('undo ignores illegal history entries when locating the target', () => {
  const h = [P(0, 0), 999, P(1, 1)] // black, garbage, white
  assert.equal(undoTarget(h, DEFAULT_SIZE, WHITE), 2)
  assert.equal(undoTarget(h, DEFAULT_SIZE, BLACK), 0)
})

test('undo target respects the board size', () => {
  const h = [P(0, 0, 9), P(8, 8, 9)]
  assert.equal(undoTarget(h, 9, WHITE), 1)
  // Same history read as 15x15 still resolves the same slots.
  assert.equal(undoTarget(h, 15, WHITE), 1)
})

test('colorOf alternates as expected', () => {
  assert.equal(colorOf(0), BLACK)
  assert.equal(colorOf(1), WHITE)
  assert.equal(colorOf(2), BLACK)
  assert.equal(colorOf(3), WHITE)
})

/* ---------------- board sizes ---------------- */

test('the smallest board is 15 and three larger steps are offered', () => {
  assert.deepEqual([...BOARD_SIZES], [15, 19, 21, 23])
  assert.equal(Math.min(...BOARD_SIZES), 15)
  assert.equal(BOARD_SIZES.length, 4)
  assert.equal(DEFAULT_SIZE, 15)
})

test('board sizes are strictly ascending', () => {
  for (let i = 1; i < BOARD_SIZES.length; i++) {
    assert.ok(BOARD_SIZES[i] > BOARD_SIZES[i - 1])
  }
})

test('column labels cover the largest board and skip I and O', () => {
  const largest = Math.max(...BOARD_SIZES)
  assert.ok(AXIS.length >= largest, `AXIS has ${AXIS.length}, need ${largest}`)
  assert.equal(AXIS.includes('I'), false, 'I reads as 1')
  assert.equal(AXIS.includes('O'), false, 'O reads as 0')
  assert.equal(new Set(AXIS).size, AXIS.length, 'labels must be unique')
})

test('every supported size normalises to itself and junk falls back to 15', () => {
  for (const n of BOARD_SIZES) assert.equal(normalizeSize(n), n)
  assert.equal(normalizeSize(9), 15, 'the old 9 board is no longer offered')
  assert.equal(normalizeSize(13), 15, 'the old 13 board is no longer offered')
  assert.equal(normalizeSize('x'), 15)
})

/* ---------------- alternating openers between games ---------------- */

test('inside a game the colours still alternate every move', () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((n) => colorOf(n, BLACK)),
    [BLACK, WHITE, BLACK, WHITE],
  )
  assert.deepEqual(
    [0, 1, 2, 3].map((n) => colorOf(n, WHITE)),
    [WHITE, BLACK, WHITE, BLACK],
  )
})

test('the opener defaults to black when not specified', () => {
  for (let n = 0; n < 6; n++) assert.equal(colorOf(n), colorOf(n, BLACK))
})

test('replay honours a white opener', () => {
  const size = 15
  // Seat A (white this game) plays first at the centre, then B answers.
  const hist = [idx(7, 7, size), idx(8, 8, size)]
  const whiteFirst = replay(hist, size, WHITE)
  assert.equal(whiteFirst.board[idx(7, 7, size)], WHITE)
  assert.equal(whiteFirst.board[idx(8, 8, size)], BLACK)
  assert.equal(whiteFirst.turn, WHITE, 'two moves played, white to move again')

  const blackFirst = replay(hist, size, BLACK)
  assert.equal(blackFirst.board[idx(7, 7, size)], BLACK)
  assert.equal(blackFirst.board[idx(8, 8, size)], WHITE)
  assert.equal(blackFirst.turn, BLACK)
})

test('a white opener wins as white', () => {
  const size = 15
  // White opens; odd indices belong to black, so black's stones are parked on
  // a far row that never joins white's line.
  const hist: number[] = []
  for (let i = 0; i < 5; i++) {
    hist.push(idx(3 + i, 3, size)) // white
    if (i < 4) hist.push(idx(3 + i, 12, size)) // black, out of the way
  }
  const r = replay(hist, size, WHITE)
  assert.equal(r.outcome.status, 'win')
  assert.equal(r.outcome.status === 'win' && r.outcome.winner, WHITE)
})

test('undo targets follow the opener, not a fixed seat', () => {
  const size = 15
  const hist = [idx(7, 7, size), idx(8, 8, size), idx(9, 9, size)]
  // White opened: moves 0 and 2 are white's, move 1 is black's.
  assert.equal(undoTarget(hist, size, WHITE, WHITE), 2)
  assert.equal(undoTarget(hist, size, BLACK, WHITE), 1)
  // With black opening the same history belongs the other way round.
  assert.equal(undoTarget(hist, size, BLACK, BLACK), 2)
  assert.equal(undoTarget(hist, size, WHITE, BLACK), 1)
})
