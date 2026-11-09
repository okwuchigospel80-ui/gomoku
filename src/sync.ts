// MQTT transport for a serverless, static-hosted game.
//
// Two topics per room, on purpose:
//
//   1. gomoku-v1/<room>/state     — the game itself. Retained. Written only when
//                                    someone moves, seats change, or the game resets.
//   2. gomoku-v1/<room>/p/<id>    — one retained presence blob per client.
//
// Keeping presence off the state topic is not cosmetic. A heartbeat that
// republished the whole board would let a lagging client write its stale view
// back with a higher revision, silently erasing the opponent's last move. Now a
// heartbeat can only ever say "I am here", so a missed round-trip can delay your
// presence but never rewind the game.
//
// Retained state is also why there is no database: the broker hands the current
// position to anyone who subscribes, so a late joiner or a reconnecting phone
// lands straight on the live board.

import mqtt, { type MqttClient } from 'mqtt'
import {
  DEFAULT_SIZE,
  normalizeSize,
  randomRoomCode,
  type BoardSize,
  type Color,
} from './board'
import { UNDO_PENALTY, WIN_POINTS } from './cards'
import type { RoomReward } from './profile'

export const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081/mqtt']

const TOPIC_ROOT = 'gomoku-v1'
const HEARTBEAT_MS = 8000
/** How long we wait for a retained snapshot before assuming the room is new. */
const RETAIN_WAIT_MS = 1800
const PRESENCE_TTL_MS = 25000

export type Seat = 'player' | 'spectator'

export interface PlayerInfo {
  clientId: string
  name: string
  color: Color | null
  seat: Seat
  /** epoch ms when we last heard from this client. */
  seen: number
}

export interface GameState {
  rev: number
  /** Board side length. Changing it clears the game. */
  size: BoardSize
  /** Move history as flat board indices; colour is implied by parity. */
  hist: number[]
  /** Who sits in which seat; `seen` is filled in locally, never from the wire. */
  seats: { black: PlayerInfo | null; white: PlayerInfo | null }
  /** First client to create the room. */
  creator: string | null
  started: boolean
  /** How many undos each colour has left. */
  undosLeft: { black: number; white: number }
  /** Set when a player concedes; the other colour wins. */
  resigned: Color | null
  /**
   * Append-only ledger of points earned IN THIS GAME, keyed by unique id.
   * Both sides see the same list; each player claims only the entries addressed
   * to their own name, so no score is ever counted twice.
   */
  rewards: RoomReward[]
  /** Has the win bonus for the current game already been issued? */
  winPaid: boolean
  updatedAt: number
  /**
   * Client that wrote this revision. Breaks ties deterministically when two
   * clients publish the same `rev`, so both sides converge instead of drifting.
   */
  writer?: string
}

/** Each player may take back their own move this many times per game. */
export const UNDOS_PER_PLAYER = 3

export const emptyState = (): GameState => ({
  rev: 0,
  size: DEFAULT_SIZE,
  hist: [],
  seats: { black: null, white: null },
  creator: null,
  started: false,
  undosLeft: { black: UNDOS_PER_PLAYER, white: UNDOS_PER_PLAYER },
  resigned: null,
  rewards: [],
  winPaid: false,
  updatedAt: 0,
})

export type ConnStatus = 'connecting' | 'online' | 'offline' | 'error'

export interface RoomEvents {
  onStatus(status: ConnStatus, detail?: string): void
  onState(state: GameState): void
  onPeers(peers: PlayerInfo[]): void
}

export function makeClientId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const stateTopic = (room: string) => `${TOPIC_ROOT}/${room}/state`
const presenceTopic = (room: string, clientId: string) => `${TOPIC_ROOT}/${room}/p/${clientId}`

/**
 * Decides whether an incoming snapshot should replace the local one.
 *
 * Higher rev wins. Equal rev means both sides moved before hearing from each
 * other; `writer` breaks that tie identically on both sides, so they converge on
 * one history. Longer history is the last-resort fallback.
 */
export function shouldAdopt(current: GameState | null, next: GameState): boolean {
  if (!current) return true
  if (next.rev !== current.rev) return next.rev > current.rev
  if (next.writer && current.writer && next.writer !== current.writer) {
    return next.writer > current.writer
  }
  return next.hist.length > current.hist.length
}

interface Presence {
  name: string
  ts: number
}

function sanitizeSeat(v: unknown): PlayerInfo | null {
  if (typeof v !== 'object' || v === null) return null
  const p = v as Record<string, unknown>
  if (typeof p.clientId !== 'string' || p.clientId === '') return null
  return {
    clientId: p.clientId,
    name: typeof p.name === 'string' ? p.name.slice(0, 24) : 'Player',
    color: p.color === 1 || p.color === 2 ? p.color : null,
    seat: p.seat === 'spectator' ? 'spectator' : 'player',
    seen: 0,
  }
}

function sanitize(raw: unknown): GameState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.hist)) return null

  const size = normalizeSize(o.size)
  const total = size * size
  const hist = o.hist.filter(
    (v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < total,
  )
  const seats = (o.seats ?? {}) as Record<string, unknown>
  const undos = (o.undosLeft ?? {}) as Record<string, unknown>
  const count = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(UNDOS_PER_PLAYER, v)) : UNDOS_PER_PLAYER

  const rewards: RoomReward[] = []
  if (Array.isArray(o.rewards)) {
    for (const item of o.rewards) {
      if (typeof item !== 'object' || item === null) continue
      const r = item as Record<string, unknown>
      if (typeof r.id !== 'string' || typeof r.to !== 'string') continue
      if (typeof r.delta !== 'number' || !Number.isFinite(r.delta)) continue
      rewards.push({
        id: r.id.slice(0, 60),
        to: r.to.slice(0, 24),
        delta: Math.trunc(r.delta),
        reason: typeof r.reason === 'string' ? r.reason.slice(0, 40) : '',
        at: typeof r.at === 'number' ? r.at : 0,
      })
    }
  }

  return {
    rev: typeof o.rev === 'number' && Number.isFinite(o.rev) ? o.rev : 0,
    size,
    hist,
    seats: { black: sanitizeSeat(seats.black), white: sanitizeSeat(seats.white) },
    creator: typeof o.creator === 'string' ? o.creator : null,
    started: o.started === true,
    undosLeft: { black: count(undos.black), white: count(undos.white) },
    resigned: o.resigned === 1 || o.resigned === 2 ? o.resigned : null,
    rewards,
    winPaid: o.winPaid === true,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    writer: typeof o.writer === 'string' ? o.writer : undefined,
  }
}

export class Room {
  readonly room: string
  readonly clientId = makeClientId()
  state: GameState = emptyState()
  connected = false
  /** True once we know the room's current state and have decided our seat. */
  ready = false

  private client: MqttClient | null = null
  private name: string
  private events: RoomEvents
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private peersTick: ReturnType<typeof setInterval> | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private seatTimer: ReturnType<typeof setTimeout> | null = null
  private brokerIndex = 0
  private closed = false
  private rotateAttempts = 0
  private myColor: Color | null = null
  /** False once the user deliberately chooses to watch instead of play. */
  private wantPlay = true
  /** Live presence, keyed by client id. Owned entirely by presence messages. */
  private presence = new Map<string, Presence>()

  constructor(room: string, name: string, events: RoomEvents) {
    this.room = room
    this.name = name.slice(0, 24) || 'Player'
    this.events = events
  }

  setName(name: string) {
    this.name = name.slice(0, 24) || 'Player'
    this.publishPresence()
  }

  get color(): Color | null {
    return this.myColor
  }

  connect() {
    if (this.closed || this.client) return
    this.openBroker()
  }

  private openBroker() {
    if (this.closed) return
    const url = BROKERS[this.brokerIndex % BROKERS.length]
    this.events.onStatus('connecting', url)

    const client = mqtt.connect(url, {
      clientId: `gomoku_${this.clientId}`,
      clean: true,
      reconnectPeriod: 3000,
      connectTimeout: 8000,
      keepalive: 30,
      protocolVersion: 4,
    })
    this.client = client

    client.on('connect', () => {
      this.connected = true
      this.rotateAttempts = 0
      this.events.onStatus('online')

      client.subscribe(
        [stateTopic(this.room), `${TOPIC_ROOT}/${this.room}/p/+`],
        { qos: 1 },
        (err) => {
          if (err) this.events.onStatus('error', err.message)
        },
      )

      // Give the retained snapshot a moment to arrive before concluding the
      // room is new. Never publish game state during this window.
      if (this.readyTimer) clearTimeout(this.readyTimer)
      this.readyTimer = setTimeout(() => this.becomeReady(), RETAIN_WAIT_MS)

      this.publishPresence()
      this.startTimers()
    })

    client.on('message', (topic, payload) => {
      if (topic.includes('/p/')) {
        const info = this.parsePresence(payload)
        if (!info) return
        if (info.clientId === this.clientId) return
        this.presence.set(info.clientId, { name: info.name, ts: Date.now() })
        this.events.onPeers(this.activePeers())
        this.events.onState(this.state)
        // A seat may have just freed up; give it a fair chance.
        this.scheduleSeatAttempt()
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(payload.toString())
      } catch {
        return
      }
      const incoming = sanitize(parsed)
      if (!incoming) return

      if (shouldAdopt(this.state, incoming)) {
        this.state = incoming
        this.events.onState(incoming)
      }
      this.syncMySeat()
      this.becomeReady()
      this.events.onPeers(this.activePeers())
    })

    client.on('reconnect', () => this.events.onStatus('connecting'))
    client.on('offline', () => {
      this.connected = false
      this.events.onStatus('offline')
    })
    client.on('error', (err) => {
      this.events.onStatus('error', err.message)
      if (!this.connected) this.rotateBroker()
    })
    client.on('close', () => {
      this.connected = false
    })
  }

  private parsePresence(payload: Uint8Array): { clientId: string; name: string } | null {
    try {
      const o = JSON.parse(payload.toString()) as Record<string, unknown>
      if (typeof o.clientId !== 'string' || o.clientId === '') return null
      return {
        clientId: o.clientId,
        name: typeof o.name === 'string' ? o.name.slice(0, 24) : 'Player',
      }
    } catch {
      return null
    }
  }

  private rotateBroker() {
    if (this.rotateAttempts >= BROKERS.length - 1) return
    this.rotateAttempts++
    this.brokerIndex++
    this.stopTimers()
    const old = this.client
    this.client = null
    try {
      old?.end(true)
    } catch {
      /* already gone */
    }
    window.setTimeout(() => this.openBroker(), 1200)
  }

  private startTimers() {
    this.stopTimers()
    this.heartbeat = setInterval(() => this.publishPresence(), HEARTBEAT_MS)
    this.peersTick = setInterval(() => this.events.onPeers(this.activePeers()), 5000)
  }

  private stopTimers() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.peersTick) clearInterval(this.peersTick)
    this.heartbeat = null
    this.peersTick = null
  }

  /** Presence is the ONLY thing a heartbeat publishes. Game state is untouched. */
  private publishPresence() {
    this.presence.set(this.clientId, { name: this.name, ts: Date.now() })
    if (!this.client?.connected) return
    this.client.publish(
      presenceTopic(this.room, this.clientId),
      JSON.stringify({ clientId: this.clientId, name: this.name, ts: Date.now() }),
      { qos: 0, retain: true },
    )
  }

  /** Post-subscribe decision point: seat ourselves if a seat is free. */
  private becomeReady() {
    if (this.ready) return
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    this.ready = true
    this.claimSeatIfPossible()
    this.events.onState(this.state)
    this.events.onPeers(this.activePeers())
  }

  /**
   * Re-derives our own seat from the authoritative state. If our seat was
   * overwritten while two clients joined at once, retry shortly — a free seat
   * almost always appears on the next snapshot.
   */
  private syncMySeat() {
    const holder = [this.state.seats.black, this.state.seats.white].find(
      (s) => s?.clientId === this.clientId,
    )
    this.myColor = holder?.color ?? null
    if (!this.myColor && this.wantPlay) this.scheduleSeatAttempt()
  }

  private scheduleSeatAttempt() {
    if (!this.ready || this.closed || !this.wantPlay || this.myColor !== null) return
    if (this.seatTimer) return
    // Jittered so two clients do not keep colliding on the same seat.
    this.seatTimer = setTimeout(() => {
      this.seatTimer = null
      if (this.closed || this.myColor !== null || !this.wantPlay) return
      this.claimSeatIfPossible()
    }, 500 + Math.random() * 600)
  }

  /** Stop competing for a seat (the user chose to watch). */
  spectate() {
    this.wantPlay = false
    if (this.seatTimer) {
      clearTimeout(this.seatTimer)
      this.seatTimer = null
    }
  }

  private claimSeatIfPossible() {
    if (!this.wantPlay) return

    // Never steal a seat that is already ours.
    const holder = [this.state.seats.black, this.state.seats.white].find(
      (s) => s?.clientId === this.clientId,
    )
    if (holder) {
      this.myColor = holder.color
      return
    }

    const color = this.seekSeat()
    if (color === null) {
      this.myColor = null
      return
    }

    const info: PlayerInfo = {
      clientId: this.clientId,
      name: this.name,
      color,
      seat: 'player',
      seen: Date.now(),
    }
    const seats = { ...this.state.seats }
    if (color === 1) seats.black = info
    else seats.white = info
    this.myColor = color
    this.commit({ ...this.state, seats, creator: this.state.creator ?? this.clientId })
  }

  /** Publish a new authoritative snapshot, bumping the revision. */
  private commit(next: GameState) {
    const snapshot: GameState = {
      ...next,
      rev: this.state.rev + 1,
      updatedAt: Date.now(),
      writer: this.clientId,
    }
    // Adopt optimistically so the UI reacts without waiting for the echo.
    this.state = snapshot
    this.events.onState(snapshot)
    this.events.onPeers(this.activePeers())
    if (this.client?.connected) {
      this.client.publish(stateTopic(this.room), JSON.stringify(snapshot), {
        qos: 1,
        retain: true,
      })
    }
  }

  /** Is the client occupying this seat still showing signs of life? */
  private seatAlive(seat: PlayerInfo | null): boolean {
    if (!seat) return false
    const p = this.presence.get(seat.clientId)
    return !!p && Date.now() - p.ts <= PRESENCE_TTL_MS
  }

  activePeers(): PlayerInfo[] {
    const now = Date.now()
    const out: PlayerInfo[] = []
    const seatOf = (id: string): Color | null => {
      if (this.state.seats.black?.clientId === id) return 1
      if (this.state.seats.white?.clientId === id) return 2
      return null
    }

    for (const [id, p] of this.presence) {
      if (now - p.ts > PRESENCE_TTL_MS) continue
      const color = seatOf(id)
      out.push({
        clientId: id,
        name: id === this.clientId ? this.name : p.name,
        color,
        seat: color === null ? 'spectator' : 'player',
        seen: p.ts,
      })
    }

    // Ourselves, always — even if our presence has not round-tripped yet.
    if (!out.some((p) => p.clientId === this.clientId)) {
      out.unshift({
        clientId: this.clientId,
        name: this.name,
        color: seatOf(this.clientId),
        seat: seatOf(this.clientId) === null ? 'spectator' : 'player',
        seen: now,
      })
    }
    return out
  }

  /** First seat whose occupant is gone, black preferred. */
  seekSeat(): Color | null {
    if (!this.seatAlive(this.state.seats.black)) return 1
    if (!this.seatAlive(this.state.seats.white)) return 2
    return null
  }

  play(index: number) {
    if (!this.ready) return
    this.commit({ ...this.state, hist: [...this.state.hist, index], started: true })
  }

  /**
   * Take back `hist` to a given length and spend one undo from `color`'s budget.
   * The caller works out the length (see `undoTarget` in board.ts) so both sides
   * agree on exactly where to cut.
   *
   * The OPPONENT is compensated: the 1st/2nd/3rd undo of a game hands them
   * 3/5/10 points respectively (18 total). The reward is appended to the room
   * ledger with a stable id so it is claimed exactly once.
   */
  undoTo(length: number, color: Color) {
    if (!this.ready) return
    const key = color === 1 ? 'black' : 'white'
    if (this.state.undosLeft[key] <= 0) return
    if (length < 0 || length > this.state.hist.length) return

    // Which penalty tier this is: 3 total undos → spends 3, then 2, then 1 left.
    const spentBefore = UNDOS_PER_PLAYER - this.state.undosLeft[key]
    const tier = Math.min(spentBefore, UNDO_PENALTY.length - 1)
    const delta = UNDO_PENALTY[tier]

    const opponent = color === 1 ? this.state.seats.white : this.state.seats.black
    const rewards = [...this.state.rewards]
    if (opponent) {
      rewards.push({
        id: `u-${this.clientId.slice(0, 6)}-${this.state.rev}-${tier}`,
        to: opponent.name,
        delta,
        reason: `对手第 ${tier + 1} 次悔棋`,
        at: Date.now(),
      })
    }

    this.commit({
      ...this.state,
      hist: this.state.hist.slice(0, length),
      undosLeft: { ...this.state.undosLeft, [key]: this.state.undosLeft[key] - 1 },
      rewards,
    })
  }

  resign(color: Color) {
    if (!this.ready) return
    if (this.state.resigned !== null) return
    this.commit({ ...this.state, resigned: color, started: true })
  }

  /**
   * Award the win bonus once per game. Called by whichever client first notices
   * the game is over; `winPaid` makes it idempotent, and the reward id is derived
   * from the game's starting revision so it stays stable across retries.
   */
  settleWin(winner: Color) {
    if (!this.ready || this.state.winPaid) return
    const seat = winner === 1 ? this.state.seats.black : this.state.seats.white
    if (!seat) return
    const rewards = [
      ...this.state.rewards,
      {
        id: `w-${this.state.rev}-${winner}`,
        to: seat.name,
        delta: WIN_POINTS,
        reason: '赢得一局',
        at: Date.now(),
      },
    ]
    this.commit({ ...this.state, rewards, winPaid: true })
  }

  /** Change the board size. Only legal between games; clears the position. */
  setSize(size: BoardSize) {
    if (!this.ready) return
    if (size === this.state.size) return
    this.commit({
      ...this.state,
      size,
      hist: [],
      started: false,
      resigned: null,
      undosLeft: { black: UNDOS_PER_PLAYER, white: UNDOS_PER_PLAYER },
      rewards: [],
      winPaid: false,
    })
  }

  reset() {
    if (!this.ready) return
    this.commit({
      ...this.state,
      hist: [],
      started: false,
      resigned: null,
      undosLeft: { black: UNDOS_PER_PLAYER, white: UNDOS_PER_PLAYER },
      // The ledger is per-game: players have already claimed it into their own
      // profile, so clearing it here cannot lose points.
      rewards: [],
      winPaid: false,
    })
  }

  dispose() {
    this.closed = true
    this.stopTimers()
    if (this.readyTimer) clearTimeout(this.readyTimer)
    if (this.seatTimer) clearTimeout(this.seatTimer)

    // Clear our presence so the seat frees up. The game state is deliberately
    // NOT rewritten here: leaving must never be able to rewind a live game.
    if (this.client?.connected) {
      this.client.publish(presenceTopic(this.room, this.clientId), '', {
        qos: 0,
        retain: true,
      })
    }
    try {
      this.client?.end(true)
    } catch {
      /* already closed */
    }
    this.client = null
  }
}

export { randomRoomCode }
