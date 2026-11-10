// 你画我猜 — logic tests. Run with: node --test src/drawguess.test.ts
//
// No DOM, no network. These pin down the parts that both browsers must agree on:
// which word a round uses, what a round is worth, how rounds advance, and how two
// equal-revision snapshots merge.

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ADVANCE_MS,
  DRAWER_POINTS,
  DEFAULT_ROUNDS,
  FAST_BONUS,
  FAST_MS,
  GUESS_POINTS,
  INPUT_GRACE_MS,
  MAX_GUESSES,
  MAX_STROKE_POINTS,
  MAX_STROKES,
  ROUND_MS,
  advanceRound,
  awardsFor,
  clearStrokes,
  emptyDgState,
  findMySeat,
  finishRound,
  isGameOver,
  isPicking,
  isRoundActive,
  matchesAnswer,
  mergeDg,
  normalizeAnswer,
  pickWord,
  remainingMs,
  rng,
  sanitizeDg,
  scoreRound,
  shouldAdoptDg,
  thinPoints,
  totalFor,
  withGuess,
  withStroke,
  wordSlots,
  type DgState,
  type Seat,
} from './drawguess.ts'
import { WORDS, WORDS_BY_LEVEL, charLength } from './words.ts'

const T0 = 1_700_000_000_000

/** A state that is mid-round, word published, clock started. */
function playing(over: Partial<DgState> = {}): DgState {
  return {
    ...emptyDgState(5),
    rev: 3,
    seats: {
      1: { name: '甲', clientId: 'a'.repeat(12) },
      2: { name: '乙', clientId: 'b'.repeat(12) },
    },
    creator: '甲',
    startedAt: T0,
    wordLen: 2,
    level: 'easy',
    roundStart: T0,
    ...over,
  }
}

/* ---------------- word bank ---------------- */

test('word bank has 150–200 entries, all non-empty and at most 4 characters', () => {
  assert.ok(WORDS.length >= 150 && WORDS.length <= 200, `have ${WORDS.length}`)
  for (const w of WORDS) {
    assert.ok(w.text.trim().length > 0, 'empty word')
    assert.ok(charLength(w.text) <= 4, `too long: ${w.text}`)
  }
})

test('word bank has no duplicates and every level has a pool', () => {
  const texts = WORDS.map((w) => w.text)
  assert.equal(new Set(texts).size, texts.length)
  for (const level of ['easy', 'mid', 'hard'] as const) {
    assert.ok(WORDS_BY_LEVEL[level].length >= 20, `${level} pool too small`)
  }
})

test('the three pools add up to the whole bank', () => {
  const sum = WORDS_BY_LEVEL.easy.length + WORDS_BY_LEVEL.mid.length + WORDS_BY_LEVEL.hard.length
  assert.equal(sum, WORDS.length)
})

/* ---------------- deterministic picking ---------------- */

test('pickWord is deterministic for the same room and round', () => {
  for (const round of [1, 2, 5, 9]) {
    const a = pickWord('ABC123', round)
    const b = pickWord('abc-123'.toUpperCase().replace(/[^A-Z0-9]/g, ''), round)
    assert.equal(a.text, b.text)
  }
})

test('pickWord differs across rounds and across rooms', () => {
  const perRound = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((r) => pickWord('ROOM01', r).text))
  assert.ok(perRound.size >= 5, 'rounds should mostly draw different words')
  const perRoom = new Set(['AAAAAA', 'BBBBBB', 'CCCCCC', 'DDDDDD'].map((r) => pickWord(r, 1).text))
  assert.ok(perRoom.size >= 3, 'rooms should draw different words')
})

test('pickWord always returns a word from the matching level pool', () => {
  for (let round = 1; round <= 40; round++) {
    const w = pickWord('SEED42', round)
    assert.ok(WORDS_BY_LEVEL[w.level].some((x) => x.text === w.text))
  }
})

test('rng is deterministic and stays in [0,1)', () => {
  const a = rng(12345)
  const b = rng(12345)
  for (let i = 0; i < 50; i++) {
    const v = a()
    assert.equal(v, b())
    assert.ok(v >= 0 && v < 1)
  }
})

/* ---------------- answer matching ---------------- */

test('answers match exactly, ignoring whitespace and case', () => {
  assert.equal(matchesAnswer('太阳', '太阳'), true)
  assert.equal(matchesAnswer(' 太 阳 ', '太阳'), true)
  assert.equal(matchesAnswer('太阳 ', '太阳'), true)
  assert.equal(matchesAnswer('月亮', '太阳'), false)
  assert.equal(matchesAnswer('', '太阳'), false)
})

test('normalizeAnswer only strips whitespace', () => {
  assert.equal(normalizeAnswer(' 星 星\t'), '星星')
  assert.equal(normalizeAnswer('abc'), 'abc')
})

/* ---------------- scoring ---------------- */

test('a guess is worth 12 + 8, and 5 more when >45 s remain', () => {
  const fast = scoreRound(1, { kind: 'guessed', by: 2, at: T0 + 10_000 }, T0)
  assert.deepEqual(fast, { 1: DRAWER_POINTS, 2: GUESS_POINTS + FAST_BONUS })

  const slow = scoreRound(1, { kind: 'guessed', by: 2, at: T0 + 60_000 }, T0)
  assert.deepEqual(slow, { 1: DRAWER_POINTS, 2: GUESS_POINTS })
})

test('exactly 45 s remaining is not a fast guess (strict comparison)', () => {
  const at = T0 + (ROUND_MS - FAST_MS)
  assert.deepEqual(scoreRound(2, { kind: 'guessed', by: 1, at }, T0), {
    1: GUESS_POINTS,
    2: DRAWER_POINTS,
  })
})

test('a timeout scores nothing for either seat', () => {
  assert.deepEqual(scoreRound(1, { kind: 'timeout', at: T0 + ROUND_MS }, T0), { 1: 0, 2: 0 })
  assert.deepEqual(scoreRound(2, { kind: 'timeout', at: T0 + ROUND_MS }, T0), { 1: 0, 2: 0 })
})

test('scores are indexed by seat, not by role, for both drawer seats', () => {
  // Seat 2 draws, seat 1 guesses fast.
  const s = scoreRound(2, { kind: 'guessed', by: 1, at: T0 + 1000 }, T0)
  assert.equal(s[1], GUESS_POINTS + FAST_BONUS)
  assert.equal(s[2], DRAWER_POINTS)
})

test('a malformed guessed-by is corrected to the non-drawing seat', () => {
  // Otherwise a crafted result could pay the drawer twice.
  const s = finishRound(playing({ roundResult: null }), {
    kind: 'guessed',
    by: 1, // the drawer — impossible
    at: T0 + 1000,
  })
  assert.deepEqual(s.roundResult, { kind: 'guessed', by: 2, at: T0 + 1000 })
  assert.equal(s.scores[0].points[2], GUESS_POINTS + FAST_BONUS)
})

/* ---------------- round lifecycle ---------------- */

test('an empty state is picking round 1 with no clock', () => {
  const s = emptyDgState()
  assert.equal(s.round, 1)
  assert.equal(s.totalRounds, DEFAULT_ROUNDS)
  assert.equal(s.drawer, 1)
  assert.equal(isPicking(s), true)
  assert.equal(isRoundActive(s, T0), false)
  assert.equal(remainingMs(s, T0), ROUND_MS)
})

test('publishing the word starts the clock', () => {
  const s = playing()
  assert.equal(isPicking(s), false)
  assert.equal(isRoundActive(s, T0 + 1000), true)
  assert.equal(remainingMs(s, T0 + 1000), ROUND_MS - 1000)
})

test('the clock runs out at exactly 90 s', () => {
  const s = playing()
  assert.equal(remainingMs(s, T0 + ROUND_MS), 0)
  assert.equal(isRoundActive(s, T0 + ROUND_MS), false)
  assert.equal(isRoundActive(s, T0 + ROUND_MS - 1), true)
})

test('finishRound is idempotent', () => {
  const first = finishRound(playing(), { kind: 'guessed', by: 2, at: T0 + 5000 })
  const second = finishRound(first, { kind: 'timeout', at: T0 + ROUND_MS })
  assert.equal(second, first)
  assert.equal(first.scores.length, 1)
})

test('advanceRound swaps the pen, clears the sheet and needs a result', () => {
  const open = playing()
  assert.equal(advanceRound(open), open) // no result yet → no-op

  const done = finishRound(open, { kind: 'guessed', by: 2, at: T0 + 5000 })
  const next = advanceRound(done)
  assert.equal(next.round, 2)
  assert.equal(next.drawer, 2)
  assert.equal(next.roundResult, null)
  assert.deepEqual(next.strokes, [])
  assert.deepEqual(next.guesses, [])
  assert.equal(next.wordLen, 0)
  assert.equal(next.roundStart, 0)
  assert.equal(next.scores.length, 1, 'score history survives the advance')
})

test('a full game alternates the drawer and ends after totalRounds', () => {
  let s = playing({ totalRounds: 3 })
  const drawers: Seat[] = []
  for (let i = 0; i < 3; i++) {
    drawers.push(s.drawer)
    s = finishRound({ ...s, roundStart: T0 + i * ROUND_MS }, { kind: 'timeout', at: T0 })
    s = advanceRound(s)
  }
  assert.deepEqual(drawers, [1, 2, 1])
  assert.equal(s.round, 4)
  assert.equal(isGameOver(s), true)
  assert.equal(advanceRound(s), s, 'the game-over state cannot advance further')
  assert.equal(finishRound(s, { kind: 'timeout', at: T0 }), s)
})

test('totalFor sums the seat across rounds', () => {
  let s = playing({ totalRounds: 2 })
  s = finishRound(s, { kind: 'guessed', by: 2, at: T0 + 1000 }) // seat 2: 17, seat 1: 8
  s = advanceRound(s)
  s = finishRound({ ...s, roundStart: T0 + 1000 }, { kind: 'timeout', at: T0 + 1000 })
  assert.equal(totalFor(s, 1), 8)
  assert.equal(totalFor(s, 2), 17)
})

/* ---------------- idempotent awards ---------------- */

test('awards are stable, unique per round and ignore zero-point rounds', () => {
  let s = playing({ totalRounds: 2 })
  s = finishRound(s, { kind: 'guessed', by: 2, at: T0 + 1000 })
  s = advanceRound(s)
  s = finishRound({ ...s, roundStart: T0 + 2000 }, { kind: 'timeout', at: T0 + 2000 })

  const awards = awardsFor(s)
  assert.equal(awards.length, 2) // the timeout round pays nobody
  assert.deepEqual(
    awards.map((a) => a.seat).sort(),
    [1, 2],
  )
  assert.equal(new Set(awards.map((a) => a.id)).size, 2)

  // Recomputing from the same state yields identical ids: claiming twice is safe.
  assert.deepEqual(awardsFor(s), awards)
})

test('award ids do not collide across games in the same room', () => {
  const a = awardsFor(
    finishRound(playing({ startedAt: 1000 }), { kind: 'guessed', by: 2, at: T0 + 1000 }),
  )
  const b = awardsFor(
    finishRound(playing({ startedAt: 2000 }), { kind: 'guessed', by: 2, at: T0 + 1000 }),
  )
  for (const x of a) for (const y of b) assert.notEqual(x.id, y.id)
})

test('awards sum to totalFor for each seat', () => {
  let s = playing({ totalRounds: 3 })
  s = finishRound(s, { kind: 'guessed', by: 2, at: T0 + 1000 })
  s = advanceRound(s)
  s = finishRound({ ...s, roundStart: T0 + 1000 }, { kind: 'guessed', by: 1, at: T0 + 1000 })
  s = advanceRound(s)
  s = finishRound({ ...s, roundStart: T0 + 2000 }, { kind: 'guessed', by: 2, at: T0 + 2000 })
  const awards = awardsFor(s)
  for (const seat of [1, 2] as const) {
    const paid = awards.filter((a) => a.seat === seat).reduce((n, a) => n + a.delta, 0)
    assert.equal(paid, totalFor(s, seat))
  }
})

test('no awards before the game has a stamp', () => {
  const s = finishRound(playing({ startedAt: 0 }), { kind: 'guessed', by: 2, at: T0 })
  assert.deepEqual(awardsFor(s), [])
})

/* ---------------- strokes ---------------- */

test('a stroke is numbered, clamped and accepted mid-round', () => {
  const s = playing()
  const r = withStroke(s, [0.1, 0.1, 0.9, 0.9], 0.006, T0 + 1000)
  assert.equal(r.accepted, true)
  assert.equal(r.state.strokes.length, 1)
  assert.equal(r.state.strokes[0].seq, 1)
  assert.deepEqual(r.state.strokes[0].pts, [0.1, 0.1, 0.9, 0.9])
})

test('stroke sequence numbers keep increasing', () => {
  let s = playing()
  for (let i = 0; i < 5; i++) s = withStroke(s, [0, 0, 1, 1], 0.01, T0 + 1000).state
  assert.deepEqual(
    s.strokes.map((x) => x.seq),
    [1, 2, 3, 4, 5],
  )
})

test('out-of-range points are clamped into 0..1', () => {
  const r = withStroke(playing(), [-5, -0.2, 4, 9], 0.006, T0 + 1000)
  assert.deepEqual(r.state.strokes[0].pts, [0, 0, 1, 1])
})

test('a one-point scribble is refused', () => {
  const r = withStroke(playing(), [0.5, 0.5], 0.006, T0 + 1000)
  assert.equal(r.accepted, false)
  assert.equal(r.reason, 'empty')
})

test('strokes are refused once the round is closed or the clock is gone', () => {
  const closed = playing({ roundResult: { kind: 'timeout', at: T0 } })
  assert.equal(withStroke(closed, [0, 0, 1, 1], 0.006, T0 + 1000).accepted, false)
  // A short grace window absorbs cross-device clock skew, then input stops.
  assert.equal(withStroke(playing(), [0, 0, 1, 1], 0.006, T0 + ROUND_MS + INPUT_GRACE_MS - 1).accepted, true)
  const late = withStroke(playing(), [0, 0, 1, 1], 0.006, T0 + ROUND_MS + INPUT_GRACE_MS + 1)
  assert.equal(late.accepted, false)
  assert.equal(late.reason, 'inactive')
})

test('the 300-stroke cap refuses further strokes', () => {
  let s = playing()
  for (let i = 0; i < MAX_STROKES; i++) {
    const r = withStroke(s, [0, 0, 1, 1], 0.006, T0 + 1000)
    assert.equal(r.accepted, true)
    s = r.state
  }
  const overflow = withStroke(s, [0, 0, 1, 1], 0.006, T0 + 1000)
  assert.equal(overflow.accepted, false)
  assert.equal(overflow.reason, 'limit')
  assert.equal(overflow.state.strokes.length, MAX_STROKES)
})

test('long strokes are thinned to at most 200 points', () => {
  const pts: number[] = []
  for (let i = 0; i < 900; i++) pts.push(i / 900, 1 - i / 900)
  const thinned = thinPoints(pts)
  assert.equal(thinned.length / 2, MAX_STROKE_POINTS)
  assert.deepEqual([thinned[0], thinned[1]], [pts[0], pts[1]])
  assert.deepEqual([thinned.at(-2), thinned.at(-1)], [pts.at(-2), pts.at(-1)])
})

test('short strokes are untouched by thinning', () => {
  const pts = [0, 0, 0.5, 0.5, 1, 1]
  assert.equal(thinPoints(pts), pts)
})

test('clearStrokes empties the sheet but keeps everything else', () => {
  const s = withStroke(playing(), [0, 0, 1, 1], 0.006, T0 + 1000).state
  const cleared = clearStrokes(s)
  assert.deepEqual(cleared.strokes, [])
  assert.equal(cleared.round, s.round)
  assert.equal(cleared.rev, s.rev)
})

/* ---------------- guesses ---------------- */

test('a guess is trimmed and appended', () => {
  const r = withGuess(playing(), 2, '  太阳  ', T0 + 1000)
  assert.equal(r.accepted, true)
  assert.deepEqual(r.state.guesses, [{ by: 2, text: '太阳', at: T0 + 1000 }])
})

test('an empty guess is refused', () => {
  assert.equal(withGuess(playing(), 2, '   ', T0 + 1000).accepted, false)
})

test('guesses are refused after the round ends', () => {
  const closed = playing({ roundResult: { kind: 'timeout', at: T0 } })
  assert.equal(withGuess(closed, 2, '太阳', T0 + 1000).accepted, false)
})

test('the guess log is capped to the most recent entries', () => {
  let s = playing()
  for (let i = 0; i < MAX_GUESSES + 5; i++) {
    s = withGuess(s, 2, `猜${i}`, T0 + 1000 + i).state
  }
  assert.equal(s.guesses.length, MAX_GUESSES)
  assert.equal(s.guesses.at(-1)!.text, `猜${MAX_GUESSES + 4}`)
})

/* ---------------- seats ---------------- */

test('seats are found by nickname, case- and space-insensitively', () => {
  const s = playing()
  assert.equal(findMySeat(s, '甲')?.seat, 1)
  assert.equal(findMySeat(s, ' 乙 ')?.seat, 2)
  assert.equal(findMySeat(s, '丙'), null)
  assert.equal(findMySeat(emptyDgState(), '甲'), null)
})

/* ---------------- merge & arbitration ---------------- */

test('equal revisions merge disjoint strokes and guesses without loss', () => {
  const base = playing()
  const a: DgState = {
    ...base,
    strokes: [{ pts: [0, 0, 1, 1], w: 0.006, seq: 1 }],
    writer: 'aaa',
  }
  const b: DgState = {
    ...base,
    guesses: [{ by: 2, text: '太阳', at: T0 + 1000 }],
    writer: 'bbb',
  }
  const merged = mergeDg(a, b)
  assert.ok(merged)
  assert.equal(merged!.strokes.length, 1)
  assert.equal(merged!.guesses.length, 1)
  // Sorted writer keeps both sides choosing the same value.
  assert.equal(merged!.writer, 'bbb')
  assert.equal(mergeDg(b, a)!.writer, 'bbb')
  assert.deepEqual(mergeDg(b, a)!.strokes, merged!.strokes)
})

test('equal revisions with the same seq do not duplicate a stroke', () => {
  const st = { pts: [0, 0, 1, 1], w: 0.006, seq: 7 }
  const a = playing({ strokes: [st], writer: 'a', guesses: [] })
  const b = playing({ strokes: [st], writer: 'b', guesses: [] })
  assert.equal(mergeDg(a, b)!.strokes.length, 1)
})

test('snapshots from different rounds do not merge', () => {
  const a = playing({ rev: 4, round: 1 })
  const b = playing({ rev: 4, round: 2 })
  assert.equal(mergeDg(a, b), null)
})

test('a merged snapshot differs only in the append-only arrays', () => {
  const a = playing({ rev: 5, writer: 'a' })
  const b = playing({ rev: 5, writer: 'b', roundResult: null, wordLen: 2 })
  assert.ok(mergeDg(a, b))
  const c = playing({ rev: 5, wordLen: 4 })
  assert.equal(mergeDg(a, c), null, 'word length is round identity, not a union')
})

test('shouldAdoptDg: higher rev wins, lower loses', () => {
  const cur = playing({ rev: 5 })
  assert.equal(shouldAdoptDg(cur, playing({ rev: 6 })), true)
  assert.equal(shouldAdoptDg(cur, playing({ rev: 4 })), false)
  assert.equal(shouldAdoptDg(null, cur), true)
})

test('shouldAdoptDg converges on equal rev with a higher writer', () => {
  const a = playing({ rev: 5, writer: 'aaa' })
  const b = playing({ rev: 5, writer: 'zzz' })
  assert.equal(shouldAdoptDg(a, b), true)
  assert.equal(shouldAdoptDg(b, a), false)
})

test('two clients always converge on the same winner', () => {
  const a = playing({ rev: 5, writer: 'aaa', round: 1 })
  const b = playing({ rev: 5, writer: 'zzz', round: 2 })
  const adoptAB = shouldAdoptDg(a, b)
  const adoptBA = shouldAdoptDg(b, a)
  assert.equal(adoptAB, !adoptBA)
})

test('an equal-rev merge is adopted and keeps both sides’ appendages', () => {
  const a = playing({ rev: 5, strokes: [{ pts: [0, 0, 1, 1], w: 0.006, seq: 1 }] })
  const b = playing({ rev: 5, guesses: [{ by: 2, text: '太阳', at: T0 + 1 }] })
  assert.equal(shouldAdoptDg(a, b), true)
  const merged = mergeDg(a, b)!
  assert.equal(merged.strokes.length, 1)
  assert.equal(merged.guesses.length, 1)
})

/* ---------------- sanitising ---------------- */

test('sanitizeDg rejects non-objects', () => {
  assert.equal(sanitizeDg(null), null)
  assert.equal(sanitizeDg('nope'), null)
  assert.equal(sanitizeDg(42), null)
})

test('sanitizeDg clamps hostile values into range', () => {
  const s = sanitizeDg({
    round: -3,
    totalRounds: 99,
    drawer: 7,
    wordLen: 900,
    level: 'nonsense',
    roundStart: 'soon',
    seats: { 1: { name: '甲' }, 2: { name: '乙', clientId: 9 } },
    strokes: 'big',
  })!
  assert.equal(s.round, 1)
  assert.equal(s.totalRounds, 9)
  assert.equal(s.drawer, 1)
  assert.equal(s.wordLen, 12)
  assert.equal(s.level, 'easy')
  assert.equal(s.roundStart, 0)
  assert.deepEqual(s.strokes, [])
  assert.equal(s.seats[1]!.name, '甲')
  assert.equal(s.seats[2]!.clientId, '')
})

test('sanitizeDg drops malformed strokes but keeps valid ones', () => {
  const s = sanitizeDg({
    rev: 2,
    strokes: [
      { pts: [0, 0, 1, 1, 0.5, 0.5], w: 99, seq: 2 },
      { pts: [0.2, 0.2], w: 1, seq: 3 }, // single point
      { pts: 'x', seq: 4 },
      { pts: [0, 0, 0.4, 0.4], seq: 1 },
    ],
  })!
  assert.equal(s.strokes.length, 2)
  assert.deepEqual(
    s.strokes.map((x) => x.seq),
    [1, 2],
    'strokes come back in seq order',
  )
  assert.ok(s.strokes.every((x) => x.w <= 0.03 && x.w >= 0.002))
})

test('sanitizeDg keeps at most the newest guesses', () => {
  const guesses = Array.from({ length: 40 }, (_, i) => ({ by: 2, text: `g${i}`, at: i }))
  const s = sanitizeDg({ guesses })!
  assert.equal(s.guesses.length, MAX_GUESSES)
  assert.equal(s.guesses.at(-1)!.text, 'g39')
})

test('sanitizeDg keeps a well-formed result and drops a broken one', () => {
  assert.deepEqual(sanitizeDg({ roundResult: { kind: 'guessed', by: 2, at: 5 } })!.roundResult, {
    kind: 'guessed',
    by: 2,
    at: 5,
  })
  assert.equal(sanitizeDg({ roundResult: { kind: 'guessed', by: 9 } })!.roundResult, null)
  assert.deepEqual(sanitizeDg({ roundResult: { kind: 'timeout', at: 7 } })!.roundResult, {
    kind: 'timeout',
    at: 7,
  })
})

test('sanitizeDg rebuilds scores and keeps the round order', () => {
  const s = sanitizeDg({
    scores: [
      { round: 2, drawer: 2, points: { 1: 12, 2: 8 } },
      { round: 1, drawer: 1, points: { 1: 8, 2: 17 } },
      { round: 3, drawer: 1, points: { 1: 'x', 2: 1 } },
    ],
  })!
  assert.deepEqual(
    s.scores.map((x) => x.round),
    [1, 2],
  )
})

test('sanitizeDg survives a full round-trip of a live state', () => {
  let s = playing()
  s = withStroke(s, [0.1, 0.2, 0.3, 0.4], 0.006, T0 + 1000).state
  s = withGuess(s, 2, '太阳', T0 + 2000).state
  s = finishRound(s, { kind: 'guessed', by: 2, at: T0 + 2000 })
  const wire = JSON.parse(JSON.stringify(s))
  const back = sanitizeDg(wire)!
  assert.equal(back.round, s.round)
  assert.equal(back.drawer, s.drawer)
  assert.deepEqual(back.roundResult, s.roundResult)
  assert.deepEqual(back.scores, s.scores)
  assert.deepEqual(back.strokes, s.strokes)
  assert.deepEqual(back.guesses, s.guesses)
  assert.deepEqual(back.seats, s.seats)
})

/* ---------------- the word never travels ---------------- */

test('nothing in serialised state contains the secret word', () => {
  const word = pickWord('ROOM01', 1)
  let s: DgState = playing({ wordLen: charLength(word.text), level: word.level })
  s = withStroke(s, [0, 0, 0.4, 0.4], 0.006, T0 + 100).state
  s = withGuess(s, 2, '一个错误答案', T0 + 200).state
  const wire = JSON.stringify(s)
  assert.equal(wire.includes(word.text), false, `leaked "${word.text}"`)
  for (const w of WORDS) assert.equal(wire.includes(w.text), false, `leaked "${w.text}"`)
})

test('wordSlots only reveals the length', () => {
  assert.deepEqual(wordSlots(2), ['＿', '＿'])
  assert.equal(wordSlots(0).length, 0)
  assert.equal(wordSlots(99).length, 12)
})

/* ---------------- misc constants ---------------- */

test('timing constants match the agreed rules', () => {
  assert.equal(ROUND_MS, 90_000)
  assert.equal(FAST_MS, 45_000)
  assert.equal(ADVANCE_MS, 3_000)
  assert.equal(GUESS_POINTS, 12)
  assert.equal(DRAWER_POINTS, 8)
  assert.equal(FAST_BONUS, 5)
})
