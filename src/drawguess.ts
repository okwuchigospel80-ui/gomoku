// 你画我猜 — pure game logic.
//
// Everything here is a deterministic function of the shared state, the room code
// and the round number. No DOM, no network, no clock reads except where a caller
// passes `now`. That is what lets the two browsers agree on a round, on a score,
// and on which word the drawer should be drawing — without putting the word on
// the wire.
//
// Privacy model (the important part):
//
//   * `pickWord(room, round)` is deterministic, so a drawer who reloads recovers
//     the same word. Only the drawer's client ever calls it.
//   * The shared state carries `wordLen` and `level` — never the text.
//   * Guesses travel in the state; the DRAWER compares them locally and publishes
//     `roundResult` only when one matches. Subscribing to every topic therefore
//     reveals strokes and guesses, but never the answer.

// `.ts` in the specifier is required by `node --test`; Vite resolves it too.
import { WORDS_BY_LEVEL, charLength, type Level, type Word } from './words.ts'

/* ------------------------------------------------------------------ */
/* types                                                              */
/* ------------------------------------------------------------------ */

export type Seat = 1 | 2

export interface Stroke {
  /** Flat point list [x0,y0,x1,y1,…], normalised to 0..1 on both axes. */
  pts: number[]
  /** Line width, also normalised (fraction of canvas width). */
  w: number
  /** Monotonic per-round sequence number: ordering + dedupe key. */
  seq: number
}

export interface Guess {
  by: Seat
  text: string
  at: number
}

export interface SeatInfo {
  name: string
  /** Last client that occupied the seat; a newer device replaces this. */
  clientId: string
}

export type RoundResult =
  | { kind: 'guessed'; by: Seat; at: number }
  | { kind: 'timeout'; at: number }

export interface RoundScore {
  round: number
  drawer: Seat
  /** Points awarded to each SEAT (not each role). */
  points: { 1: number; 2: number }
}

export interface DgState {
  rev: number
  /** Current round, 1-based. `round > totalRounds` means the game is over. */
  round: number
  totalRounds: number
  /** Which seat is drawing this round. */
  drawer: Seat
  /** Length of the secret word. 0 while the drawer has not started. */
  wordLen: number
  level: Level
  /** Epoch ms when this round's 90 s started; 0 before the drawer presses 开始. */
  roundStart: number
  roundResult: RoundResult | null
  scores: RoundScore[]
  strokes: Stroke[]
  guesses: Guess[]
  /**
   * Timestamps of guesses the DRAWER has judged wrong. Only the drawer writes
   * this, so the guesser gets a real "not it" signal instead of having to infer
   * whether an answer was even seen. Idempotent by timestamp.
   */
  wrong: number[]
  /** Seats are bound by NICKNAME, not client id — same rule as the gomoku room. */
  seats: { 1: SeatInfo | null; 2: SeatInfo | null }
  /** Stamp of this game, used to keep award ids unique across replays. */
  startedAt: number
  /** Creator nickname (never the client id; it must survive a device change). */
  creator: string | null
  updatedAt: number
  writer?: string
}

/* ------------------------------------------------------------------ */
/* constants                                                          */
/* ------------------------------------------------------------------ */

export const ROUND_MS = 90_000
/** Finishing with more than this much time left earns the speed bonus. */
export const FAST_MS = 45_000
export const GUESS_POINTS = 12
export const DRAWER_POINTS = 8
export const FAST_BONUS = 5
/** Pause on the result before the next round starts. */
export const ADVANCE_MS = 3000
export const MAX_STROKES = 300
export const MAX_STROKE_POINTS = 200
/**
 * Safety valve on the retained payload: 300 strokes × 200 points would be a
 * very large MQTT message. 12k points is roughly 150 KB — comfortable.
 */
export const MAX_TOTAL_POINTS = 12_000
export const MAX_GUESSES = 24
export const MAX_GUESS_LEN = 20
export const DEFAULT_ROUNDS = 5
/**
 * Cross-device clock tolerance for INPUT guards only. `roundStart` carries the
 * drawer's clock, so a guesser whose clock is a couple of seconds off must still
 * be allowed to guess near the buzzer. Closing the round is unaffected: the
 * `roundResult` flag is the authority.
 */
export const INPUT_GRACE_MS = 3000

export const other = (seat: Seat): Seat => (seat === 1 ? 2 : 1)

/* ------------------------------------------------------------------ */
/* initial state                                                      */
/* ------------------------------------------------------------------ */

export function emptyDgState(totalRounds = DEFAULT_ROUNDS): DgState {
  return {
    rev: 0,
    round: 1,
    totalRounds,
    drawer: 1,
    wordLen: 0,
    level: 'easy',
    roundStart: 0,
    roundResult: null,
    scores: [],
    strokes: [],
    guesses: [],
    wrong: [],
    seats: { 1: null, 2: null },
    startedAt: 0,
    creator: null,
    updatedAt: 0,
  }
}

/* ------------------------------------------------------------------ */
/* names & seats — the same "recognise people by nickname" rule as sync.ts */
/* ------------------------------------------------------------------ */

export const normName = (s: string | null | undefined): string =>
  (s ?? '').trim().toLowerCase()

export const samePerson = (a: string | null | undefined, b: string | null | undefined): boolean =>
  normName(a) !== '' && normName(a) === normName(b)

/** The seat whose occupant carries this nickname. */
export function findMySeat(
  state: DgState,
  name: string,
): { seat: Seat; info: SeatInfo } | null {
  for (const seat of [1, 2] as const) {
    const info = state.seats[seat]
    if (info && samePerson(info.name, name)) return { seat, info }
  }
  return null
}

export const seatName = (state: DgState, seat: Seat): string =>
  state.seats[seat]?.name ?? ''

/* ------------------------------------------------------------------ */
/* word picking — deterministic from (room, round)                    */
/* ------------------------------------------------------------------ */

/** FNV-1a, 32 bit. Small, stable, and good enough to seed a round. */
export function hash32(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** mulberry32: tiny deterministic PRNG, returns floats in [0,1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The word for a round. Same input → same word, in every browser and after any
 * reload. The guesser's code path never calls this; if a curious player evaluates
 * it in devtools they can peek, exactly like reading the password hash out of the
 * bundle — this is a curtain, not cryptography.
 */
export function pickWord(room: string, round: number): Word {
  const r = rng(hash32(`dg|${room.toUpperCase()}|${round}`))
  const roll = r()
  const level: Level = roll < 0.5 ? 'easy' : roll < 0.82 ? 'mid' : 'hard'
  const pool = WORDS_BY_LEVEL[level]
  const index = Math.min(pool.length - 1, Math.floor(r() * pool.length))
  return pool[index]
}

/** Compare a guess with the answer: whitespace-insensitive, exact otherwise. */
export const normalizeAnswer = (text: string): string =>
  text.replace(/\s+/g, '').toLowerCase()

export const matchesAnswer = (guess: string, answer: string): boolean =>
  normalizeAnswer(guess) !== '' && normalizeAnswer(guess) === normalizeAnswer(answer)

/* ------------------------------------------------------------------ */
/* phases & timing                                                    */
/* ------------------------------------------------------------------ */

export const isGameOver = (s: DgState): boolean => s.round > s.totalRounds

/** The drawer still has to press 开始 (or has not published the word yet). */
export const isPicking = (s: DgState): boolean =>
  !isGameOver(s) && s.roundResult === null && (s.wordLen <= 0 || s.roundStart <= 0)

/** Answering is open and the clock is running. */
export const isRoundActive = (s: DgState, now = Date.now()): boolean =>
  !isGameOver(s) &&
  s.roundResult === null &&
  s.wordLen > 0 &&
  s.roundStart > 0 &&
  now - s.roundStart < ROUND_MS

export function remainingMs(s: DgState, now = Date.now()): number {
  if (s.roundStart <= 0) return ROUND_MS
  return Math.max(0, ROUND_MS - Math.max(0, now - s.roundStart))
}

/* ------------------------------------------------------------------ */
/* scoring                                                            */
/* ------------------------------------------------------------------ */

/**
 * Points for one finished round, indexed by SEAT.
 *
 * Guessed: guesser 12 (+5 when more than 45 s remain), drawer 8.
 * Timeout: both 0.
 */
export function scoreRound(
  drawer: Seat,
  result: RoundResult,
  roundStart: number,
): { 1: number; 2: number } {
  const points = { 1: 0, 2: 0 }
  if (result.kind !== 'guessed') return points
  const guesser = other(drawer)
  const elapsed = Math.max(0, result.at - roundStart)
  const remaining = Math.max(0, ROUND_MS - elapsed)
  points[guesser] = GUESS_POINTS + (remaining > FAST_MS ? FAST_BONUS : 0)
  points[drawer] = DRAWER_POINTS
  return points
}

/**
 * Close the current round. Idempotent: once `roundResult` is set, further calls
 * return the state unchanged, so both clients may race to publish a result.
 */
export function finishRound(s: DgState, result: RoundResult): DgState {
  if (s.roundResult || isGameOver(s)) return s
  // `by` is always the non-drawing seat; drop a malformed value instead of
  // letting it point at the drawer.
  const fixed: RoundResult =
    result.kind === 'guessed'
      ? { kind: 'guessed', by: other(s.drawer), at: result.at }
      : result
  const entry: RoundScore = {
    round: s.round,
    drawer: s.drawer,
    points: scoreRound(s.drawer, fixed, s.roundStart),
  }
  const scores = s.scores.some((x) => x.round === s.round) ? s.scores : [...s.scores, entry]
  return { ...s, roundResult: fixed, scores }
}

/**
 * Move to the next round. Requires a finished round; clears the canvas and the
 * guesses and hands the pen to the other seat. The last advance pushes `round`
 * past `totalRounds`, which is the "game over" signal.
 */
export function advanceRound(s: DgState): DgState {
  if (!s.roundResult || isGameOver(s)) return s
  const nextRound = s.round + 1
  const done = nextRound > s.totalRounds
  return {
    ...s,
    round: nextRound,
    drawer: other(s.drawer),
    wordLen: 0,
    level: 'easy',
    roundStart: 0,
    roundResult: null,
    // The last sheet stays on screen behind the summary panel; earlier rounds
    // start clean.
    strokes: done ? s.strokes : [],
    guesses: done ? s.guesses : [],
    wrong: done ? s.wrong : [],
  }
}

export interface Award {
  id: string
  seat: Seat
  delta: number
  reason: string
}

/**
 * Points each seat has earned, derived from `scores` (the append-only record of
 * finished rounds). Ids are stable for a given game, round and seat, so replaying
 * them into a profile is harmless — `ProfileStore.claim` dedupes by id.
 *
 * `startedAt` is the game stamp: two games in the same room never share ids, and
 * a client that reloads mid-game recomputes exactly the same list.
 */
export function awardsFor(s: DgState): Award[] {
  const out: Award[] = []
  if (!s.startedAt) return out
  for (const score of s.scores) {
    for (const seat of [1, 2] as const) {
      const delta = score.points[seat]
      if (delta <= 0) continue
      const drawer = score.drawer === seat
      const fast = !drawer && delta === GUESS_POINTS + FAST_BONUS
      out.push({
        id: `dt-${s.startedAt}-${score.round}-s${seat}`,
        seat,
        delta,
        reason: drawer
          ? `你画我猜 第${score.round}回合 · 画手`
          : `你画我猜 第${score.round}回合 · 猜对${fast ? '（速猜）' : ''}`,
      })
    }
  }
  return out
}

export const totalFor = (s: DgState, seat: Seat): number =>
  s.scores.reduce((sum, score) => sum + score.points[seat], 0)

/* ------------------------------------------------------------------ */
/* strokes & guesses                                                  */
/* ------------------------------------------------------------------ */

const clamp01 = (v: number): number =>
  Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))

/** Keep every point when small; otherwise sample evenly, first and last included. */
export function thinPoints(pts: number[], max = MAX_STROKE_POINTS): number[] {
  const pairs = Math.floor(pts.length / 2)
  if (pairs <= max) return pts
  const out: number[] = []
  for (let i = 0; i < max; i++) {
    const j = Math.round((i * (pairs - 1)) / (max - 1))
    out.push(pts[j * 2], pts[j * 2 + 1])
  }
  return out
}

const strokePointCount = (s: Stroke): number => Math.floor(s.pts.length / 2)

export type StrokeReject = 'inactive' | 'limit' | 'empty'

export interface StrokeResult {
  state: DgState
  accepted: boolean
  reason?: StrokeReject
}

/**
 * Append one finished stroke. The caller draws in 0..1 coordinates; this function
 * thins, clamps and numbers it, and refuses once the round is full.
 */
export function withStroke(
  s: DgState,
  rawPts: number[],
  rawWidth: number,
  now = Date.now(),
): StrokeResult {
  if (s.roundResult !== null || !isRoundActive(s, now - INPUT_GRACE_MS)) {
    return { state: s, accepted: false, reason: 'inactive' }
  }
  const pts = thinPoints(rawPts)
  if (pts.length < 4) return { state: s, accepted: false, reason: 'empty' }

  const used = s.strokes.reduce((n, st) => n + strokePointCount(st), 0)
  if (s.strokes.length >= MAX_STROKES || used + pts.length / 2 > MAX_TOTAL_POINTS) {
    return { state: s, accepted: false, reason: 'limit' }
  }

  const clean: number[] = []
  for (let i = 0; i + 1 < pts.length; i += 2) {
    clean.push(Math.round(clamp01(pts[i]) * 1000) / 1000, Math.round(clamp01(pts[i + 1]) * 1000) / 1000)
  }
  const width = Math.min(0.03, Math.max(0.002, Number.isFinite(rawWidth) ? rawWidth : 0.006))
  const seq = s.strokes.reduce((max, st) => Math.max(max, st.seq), 0) + 1
  return {
    state: { ...s, strokes: [...s.strokes, { pts: clean, w: width, seq }] },
    accepted: true,
  }
}

export type GuessReject = 'inactive' | 'empty'

export interface GuessResult {
  state: DgState
  accepted: boolean
  reason?: GuessReject
}

export function withGuess(
  s: DgState,
  by: Seat,
  text: string,
  at = Date.now(),
): GuessResult {
  if (s.roundResult !== null || !isRoundActive(s, at - INPUT_GRACE_MS)) {
    return { state: s, accepted: false, reason: 'inactive' }
  }
  const clean = text.trim().slice(0, MAX_GUESS_LEN)
  if (!clean) return { state: s, accepted: false, reason: 'empty' }
  const guesses = [...s.guesses, { by, text: clean, at }].slice(-MAX_GUESSES)
  return { state: { ...s, guesses }, accepted: true }
}

/** Back to an empty sheet for the current round. */
export const clearStrokes = (s: DgState): DgState => ({ ...s, strokes: [] })

/**
 * Record that the drawer judged a guess wrong. Only the drawer calls this, so the
 * guesser's screen can show "不对，再想想" without the drawer typing anything.
 * Idempotent: marking the same guess twice changes nothing.
 */
export function withWrong(s: DgState, at: number): DgState {
  if (s.wrong.includes(at)) return s
  return { ...s, wrong: [...s.wrong, at].slice(-MAX_GUESSES) }
}

/* ------------------------------------------------------------------ */
/* merging received state                                             */
/* ------------------------------------------------------------------ */

const resultKey = (r: RoundResult | null): string => (r ? JSON.stringify(r) : 'null')
const seatsKey = (s: DgState): string => JSON.stringify(s.seats)

/**
 * Lossless union for the common race: the drawer commits a stroke and the guesser
 * commits a guess in the same instant, so both arrive with the same `rev`.
 *
 * Only valid when every scalar field agrees — i.e. both snapshots describe the
 * same round, the same seats and the same result, differing only in the two
 * append-only arrays. Returns null when they genuinely conflict; then `writer`
 * arbitration decides, exactly like sync.ts.
 */
export function mergeDg(a: DgState, b: DgState): DgState | null {
  if (a.rev !== b.rev) return null
  if (
    a.round !== b.round ||
    a.totalRounds !== b.totalRounds ||
    a.drawer !== b.drawer ||
    a.wordLen !== b.wordLen ||
    a.level !== b.level ||
    a.roundStart !== b.roundStart ||
    a.startedAt !== b.startedAt ||
    a.creator !== b.creator ||
    resultKey(a.roundResult) !== resultKey(b.roundResult) ||
    seatsKey(a) !== seatsKey(b)
  ) {
    return null
  }

  const strokes = new Map<number, Stroke>()
  for (const st of [...a.strokes, ...b.strokes]) if (!strokes.has(st.seq)) strokes.set(st.seq, st)
  const guesses = new Map<string, Guess>()
  for (const g of [...a.guesses, ...b.guesses]) guesses.set(`${g.by}|${g.at}|${g.text}`, g)
  const wrong = [...new Set([...a.wrong, ...b.wrong])].sort((x, y) => x - y)
  const scores = new Map<number, RoundScore>()
  for (const sc of [...a.scores, ...b.scores]) {
    const seen = scores.get(sc.round)
    if (seen && seen.points[1] !== sc.points[1]) return null
    if (!seen) scores.set(sc.round, sc)
  }

  return {
    ...a,
    strokes: [...strokes.values()].sort((x, y) => x.seq - y.seq),
    guesses: [...guesses.values()].sort((x, y) => x.at - y.at),
    wrong,
    scores: [...scores.values()].sort((x, y) => x.round - y.round),
    writer: [a.writer, b.writer].filter(Boolean).sort().pop(),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
  }
}

/**
 * Which snapshot wins. Higher rev; equal rev merges when the merge actually adds
 * something (strokes, guesses or scores), otherwise monotonic progress wins
 * (a later game stamp, then a later round), then the larger `writer` string.
 * Both sides compare the same values, so they converge.
 */
export function adoptDg(current: DgState | null, next: DgState): DgState | null {
  if (!current) return next
  if (next.rev !== current.rev) return next.rev > current.rev ? next : null

  const merged = mergeDg(current, next)
  if (
    merged &&
    (merged.strokes.length > current.strokes.length ||
      merged.guesses.length > current.guesses.length ||
      merged.wrong.length > current.wrong.length ||
      merged.scores.length > current.scores.length)
  ) {
    return merged
  }

  // Same revision but different progress: never let a slow client rewind the
  // round or resurrect a finished game.
  const progress = (s: DgState): number[] => [
    s.startedAt,
    s.round,
    s.scores.length,
    s.roundResult ? 1 : 0,
    s.strokes.length,
    s.guesses.length,
    s.wrong.length,
  ]
  const a = progress(current)
  const b = progress(next)
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return b[i] > a[i] ? next : null
  }

  if (next.writer && current.writer && next.writer !== current.writer) {
    return next.writer > current.writer ? next : null
  }
  return next.updatedAt > current.updatedAt ? next : null
}

/** Boolean form of `adoptDg`, for callers that do not need the merged state. */
export function shouldAdoptDg(current: DgState | null, next: DgState): boolean {
  return adoptDg(current, next) !== null
}

/* ------------------------------------------------------------------ */
/* wire sanitising                                                    */
/* ------------------------------------------------------------------ */

const isSeat = (v: unknown): v is Seat => v === 1 || v === 2
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const int = (v: unknown, fallback: number): number =>
  finite(v) ? Math.trunc(v) : fallback

function cleanSeat(raw: unknown): SeatInfo | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.name !== 'string' || !o.name.trim()) return null
  return {
    name: o.name.slice(0, 24),
    clientId: typeof o.clientId === 'string' ? o.clientId.slice(0, 32) : '',
  }
}

function cleanStroke(raw: unknown): Stroke | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.pts)) return null
  const pts: number[] = []
  for (const v of o.pts) {
    if (!finite(v)) continue
    pts.push(Math.round(clamp01(v) * 1000) / 1000)
  }
  if (pts.length < 4) return null
  const w = finite(o.w) ? Math.min(0.03, Math.max(0.002, o.w)) : 0.006
  return {
    pts: thinPoints(pts),
    w,
    seq: finite(o.seq) ? Math.trunc(o.seq) : 0,
  }
}

function cleanGuess(raw: unknown): Guess | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (!isSeat(o.by)) return null
  if (typeof o.text !== 'string' || !o.text.trim()) return null
  return {
    by: o.by,
    text: o.text.slice(0, MAX_GUESS_LEN),
    at: finite(o.at) ? o.at : 0,
  }
}

function cleanResult(raw: unknown): RoundResult | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const at = finite(o.at) ? o.at : 0
  if (o.kind === 'guessed' && isSeat(o.by)) return { kind: 'guessed', by: o.by, at }
  if (o.kind === 'timeout') return { kind: 'timeout', at }
  return null
}

function cleanScore(raw: unknown): RoundScore | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (!finite(o.round) || !isSeat(o.drawer)) return null
  const p = (o.points ?? {}) as Record<string, unknown>
  if (!finite(p[1]) || !finite(p[2])) return null
  return {
    round: Math.trunc(o.round),
    drawer: o.drawer,
    points: { 1: Math.trunc(p[1]), 2: Math.trunc(p[2]) },
  }
}

/** Coerce anything that came off the broker into a usable state, or reject it. */
export function sanitizeDg(raw: unknown): DgState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  const round = Math.max(1, int(o.round, 1))
  const totalRounds = Math.min(9, Math.max(1, int(o.totalRounds, DEFAULT_ROUNDS)))
  const drawer: Seat = isSeat(o.drawer) ? o.drawer : 1
  const level: Level =
    o.level === 'easy' || o.level === 'mid' || o.level === 'hard' ? o.level : 'easy'
  const seatsRaw = (o.seats ?? {}) as Record<string, unknown>

  const strokes: Stroke[] = []
  if (Array.isArray(o.strokes)) {
    for (const item of o.strokes.slice(0, MAX_STROKES)) {
      const st = cleanStroke(item)
      if (st) strokes.push(st)
    }
  }
  strokes.sort((a, b) => a.seq - b.seq)

  const guesses: Guess[] = []
  if (Array.isArray(o.guesses)) {
    for (const item of o.guesses.slice(-MAX_GUESSES)) {
      const g = cleanGuess(item)
      if (g) guesses.push(g)
    }
  }

  const scores: RoundScore[] = []
  if (Array.isArray(o.scores)) {
    for (const item of o.scores.slice(0, 64)) {
      const sc = cleanScore(item)
      if (sc) scores.push(sc)
    }
  }
  scores.sort((a, b) => a.round - b.round)

  const wrong: number[] = []
  if (Array.isArray(o.wrong)) {
    for (const v of o.wrong) if (finite(v)) wrong.push(v)
    if (wrong.length > MAX_GUESSES) wrong.splice(0, wrong.length - MAX_GUESSES)
  }

  return {
    rev: finite(o.rev) ? o.rev : 0,
    round,
    totalRounds,
    drawer,
    wordLen: Math.min(12, Math.max(0, int(o.wordLen, 0))),
    level,
    roundStart: finite(o.roundStart) ? o.roundStart : 0,
    roundResult: cleanResult(o.roundResult),
    scores,
    strokes,
    guesses,
    wrong,
    seats: { 1: cleanSeat(seatsRaw[1]), 2: cleanSeat(seatsRaw[2]) },
    startedAt: finite(o.startedAt) ? o.startedAt : 0,
    creator: typeof o.creator === 'string' ? o.creator.slice(0, 24) : null,
    updatedAt: finite(o.updatedAt) ? o.updatedAt : 0,
    writer: typeof o.writer === 'string' ? o.writer : undefined,
  }
}

/** The length hint shown to the guesser: `●●●` (or `_ _ _` boxes in CSS). */
export const wordSlots = (len: number): string[] =>
  Array.from({ length: Math.max(0, Math.min(12, len)) }, () => '＿')

export { charLength }
