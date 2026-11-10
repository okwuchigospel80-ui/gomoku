// MQTT transport for 你画我猜 — the same serverless pattern as `sync.ts`, with a
// separate topic namespace so the two games can never touch each other.
//
// Topics (all under `gomoku-v1/dg/<room>`):
//
//   state              the room: round, drawer, strokes, guesses, scores. Retained.
//   p/<clientId>       presence heartbeat. Retained, one per client.
//   secret/<clientId>  THE WORD, written only by the seat that is drawing, read
//                      back only by that seat after a reload.
//
// The secret topic is per-client on purpose. It is not private in a cryptographic
// sense — anyone who subscribes to `gomoku-v1/dg/+/secret/+` can read it — but it
// keeps the word out of the shared state, so the guesser's own browser never
// receives it and a casual observer of the state topic learns only the length.
//
// Heartbeats NEVER write the room state. That rule is inherited from the gomoku
// room, where a heartbeat republishing a stale board silently erased moves.

import mqtt, { type MqttClient } from 'mqtt'
import { sameName } from './pairing.ts'
import {
  advanceRound,
  adoptDg,
  emptyDgState,
  finishRound,
  isGameOver,
  sanitizeDg,
  withGuess,
  withStroke,
  withWrong,
  type DgState,
  type Seat,
  type Stroke,
} from './drawguess.ts'

const TOPIC_ROOT = 'gomoku-v1'
const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081/mqtt']

const HEARTBEAT_MS = 8000
/** Retained snapshot grace period. Never publish before this elapses. */
const RETAIN_WAIT_MS = 1800
const PRESENCE_TTL_MS = 25000

/** The word we are drawing / drew, kept in memory and on our own secret topic. */
export interface Secret {
  round: number
  text: string
  level: string
}

export interface Peer {
  clientId: string
  name: string
  seat: Seat | null
  seen: number
}

export type ConnStatus = 'connecting' | 'online' | 'offline' | 'error'

export interface DgEvents {
  onStatus(status: ConnStatus, detail?: string): void
  onState(state: DgState): void
  onPeers(peers: Peer[]): void
  /** The retained secret for the CURRENT round arrived (or was cleared). */
  onSecret(secret: Secret | null): void
}

export function makeClientId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const roomTopic = (room: string) => `${TOPIC_ROOT}/dg/${room}`
const stateTopic = (room: string) => `${roomTopic(room)}/state`
const presenceTopic = (room: string, id: string) => `${roomTopic(room)}/p/${id}`
const secretTopic = (room: string, id: string) => `${roomTopic(room)}/secret/${id}`

function parseSecret(raw: string): Secret | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (typeof o.round !== 'number' || !Number.isFinite(o.round)) return null
    if (typeof o.text !== 'string' || !o.text) return null
    return {
      round: Math.trunc(o.round),
      text: o.text.slice(0, 12),
      level: typeof o.level === 'string' ? o.level.slice(0, 8) : 'easy',
    }
  } catch {
    return null
  }
}

export class DgRoom {
  readonly room: string
  readonly clientId = makeClientId()
  state: DgState = emptyDgState()
  connected = false
  ready = false

  private client: MqttClient | null = null
  private _name: string
  private events: DgEvents
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private peersTick: ReturnType<typeof setInterval> | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private seatTimer: ReturnType<typeof setTimeout> | null = null
  private brokerIndex = 0
  private closed = false
  private rotateAttempts = 0
  private mySeat: Seat | null = null
  /** False once this client has been superseded by another device. */
  private wantPlay = true
  private presence = new Map<string, { name: string; ts: number }>()
  /** Latest secret seen on our own topic; the app owns the real copy. */
  private secret: Secret | null = null
  /** Set while the state was adopted without us ever having seen a snapshot. */
  private sawRemote = false

  constructor(room: string, name: string, events: DgEvents) {
    this.room = room
    this._name = name.slice(0, 24) || 'Player'
    this.events = events
  }

  get name(): string {
    return this._name
  }

  setName(name: string) {
    this._name = name.slice(0, 24) || 'Player'
    this.publishPresence()
  }

  get seat(): Seat | null {
    return this.mySeat
  }

  get isCreator(): boolean {
    return sameName(this.state.creator, this._name)
  }

  /**
   * True when my nickname holds a seat but ANOTHER LIVE client has taken it.
   *
   * The liveness check matters: right after a reload the retained state still
   * carries the previous page's client id until our takeover write lands. Without
   * it, a refreshed drawer would briefly believe itself superseded, disable the
   * canvas, and refuse to draw.
   */
  isSuperseded(): boolean {
    const holder = this.findMySeat()
    if (!holder || !holder.clientId || holder.clientId === this.clientId) return false
    const now = Date.now()
    for (const [id, p] of this.presence) {
      if (id === holder.clientId && now - p.ts <= PRESENCE_TTL_MS) return true
    }
    return false
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
      clientId: `gomokudg_${this.clientId}`,
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
        [stateTopic(this.room), `${roomTopic(this.room)}/p/+`, secretTopic(this.room, this.clientId)],
        { qos: 1 },
        (err) => {
          if (err) this.events.onStatus('error', err.message)
        },
      )

      // Wait for retained messages before deciding the room is brand new.
      if (this.readyTimer) clearTimeout(this.readyTimer)
      this.readyTimer = setTimeout(() => this.becomeReady(), RETAIN_WAIT_MS)

      this.publishPresence()
      this.startTimers()
    })

    client.on('message', (topic, payload) => {
      if (topic.endsWith(`/secret/${this.clientId}`)) {
        const text = payload.toString()
        const next = text ? parseSecret(text) : null
        this.secret = next
        this.events.onSecret(next)
        return
      }
      if (topic.includes('/p/')) {
        const info = this.parsePresence(payload)
        if (!info || info.clientId === this.clientId) return
        this.presence.set(info.clientId, { name: info.name, ts: Date.now() })
        this.events.onPeers(this.activePeers())
        this.scheduleSeatAttempt()
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(payload.toString())
      } catch {
        return
      }
      const incoming = sanitizeDg(parsed)
      if (!incoming) return
      this.sawRemote = true
      this.adopt(incoming)
      this.syncMySeat()
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
      if (typeof o.clientId !== 'string' || !o.clientId) return null
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

  /** Presence says "I am here" and nothing else. It never carries game state. */
  private publishPresence() {
    this.presence.set(this.clientId, { name: this._name, ts: Date.now() })
    if (!this.client?.connected) return
    this.client.publish(
      presenceTopic(this.room, this.clientId),
      JSON.stringify({ clientId: this.clientId, name: this._name, ts: Date.now() }),
      { qos: 0, retain: true },
    )
  }

  private becomeReady() {
    if (this.ready) return
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    this.ready = true
    // Nothing arrived: we are the first one here and may initialise the room.
    if (!this.sawRemote) this.ensureCreator()
    // Creator first, then seats: seat 1 belongs to the creator, so the order
    // decides which side of the board we sit on.
    this.claimSeatIfPossible()
    this.syncMySeat()
    this.events.onState(this.state)
    this.events.onPeers(this.activePeers())
  }

  /**
   * The creator is the first person in the room, stored by NICKNAME so the role
   * survives a device change. Only written when the room is genuinely empty.
   */
  private ensureCreator() {
    if (isGameOver(this.state)) return
    if (this.state.creator) return
    this.commit({ ...this.state, creator: this._name, updatedAt: Date.now() })
  }

  private adopt(incoming: DgState) {
    const merged = adoptDg(this.state, incoming)
    if (!merged) return
    this.state = merged
    this.events.onState(merged)
  }

  private findMySeat(): { seat: Seat; clientId: string } | null {
    if (!this._name.trim()) return null
    for (const seat of [1, 2] as const) {
      const info = this.state.seats[seat]
      if (info && sameName(info.name, this._name)) {
        return { seat, clientId: info.clientId }
      }
    }
    return null
  }

  private syncMySeat() {
    const holder = this.findMySeat()
    this.mySeat = holder?.seat ?? null
    if (!this.mySeat && this.wantPlay) this.scheduleSeatAttempt()
  }

  private scheduleSeatAttempt() {
    if (!this.ready || this.closed || !this.wantPlay || this.mySeat !== null) return
    if (this.seatTimer) return
    this.seatTimer = setTimeout(() => {
      this.seatTimer = null
      if (this.closed || this.mySeat !== null || !this.wantPlay) return
      this.claimSeatIfPossible()
    }, 500 + Math.random() * 600)
  }

  /** Seats follow the pairing: the room's creator always takes seat 1. */
  private claimSeatIfPossible() {
    if (!this.wantPlay) return

    const holder = this.findMySeat()
    if (holder) {
      this.mySeat = holder.seat
      const info = this.state.seats[holder.seat]!
      if (info.clientId !== this.clientId) {
        // Same nickname, new device: take the seat over so the old window goes
        // read-only instead of the two fighting over the pen.
        this.commit({
          ...this.state,
          seats: { ...this.state.seats, [holder.seat]: { ...info, clientId: this.clientId } },
        })
      }
      return
    }

    const creator = this.state.creator
    if (!creator) return
    const seat: Seat = this.isCreator ? 1 : 2
    if (this.state.seats[seat]) {
      // The seat is taken. Before pairing, fall back to the other free one.
      const free: Seat | null = this.state.seats[1] ? (this.state.seats[2] ? null : 2) : 1
      if (!free) return
      this.takeSeat(free)
      return
    }
    this.takeSeat(seat)
  }

  private takeSeat(seat: Seat) {
    this.mySeat = seat
    this.commit({
      ...this.state,
      seats: { ...this.state.seats, [seat]: { name: this._name, clientId: this.clientId } },
    })
  }

  /**
   * Adopt a bound partner's identity, exactly like the gomoku room: anyone who
   * opens the creator's paired room plays as the partner.
   */
  adoptPartnerIdentity(partnerName: string): boolean {
    if (sameName(this._name, partnerName)) return false
    if (this.isCreator) return false
    this._name = partnerName
    this.mySeat = null
    this.claimSeatIfPossible()
    return true
  }

  /** Publish a new authoritative snapshot, bumping the revision. */
  commit(next: DgState) {
    if (!this.ready) return
    const snapshot: DgState = {
      ...next,
      rev: this.state.rev + 1,
      updatedAt: Date.now(),
      writer: this.clientId,
    }
    this.state = snapshot
    this.mySeat =
      ([1, 2] as const).find((s) => sameName(snapshot.seats[s]?.name, this._name)) ?? this.mySeat
    this.events.onState(snapshot)
    this.events.onPeers(this.activePeers())
    if (this.client?.connected) {
      this.client.publish(stateTopic(this.room), JSON.stringify(snapshot), {
        qos: 1,
        retain: true,
      })
    }
  }

  /** Start a brand-new game, preserving seats and the binding. */
  startGame(totalRounds: number, drawer: Seat = 1) {
    if (!this.ready) return
    this.commit({
      ...emptyDgState(totalRounds),
      // Keep the room's identity; only the game fields reset.
      seats: this.state.seats,
      creator: this.state.creator ?? this._name,
      startedAt: Date.now(),
      drawer,
    })
  }

  /** Publish the word length + level once the drawer has committed to a word. */
  publishWord(wordLen: number, level: DgState['level']) {
    if (!this.ready) return
    this.commit({ ...this.state, wordLen, level, roundStart: Date.now() })
  }

  appendStroke(pts: number[], w: number): boolean {
    if (!this.ready) return false
    const result = withStroke(this.state, pts, w)
    if (!result.accepted) return false
    this.commit(result.state)
    return true
  }

  /** Replace the whole stroke list — used by 清空. */
  setStrokes(strokes: Stroke[]) {
    if (!this.ready) return
    this.commit({ ...this.state, strokes: strokes.map((s) => ({ pts: [...s.pts], w: s.w, seq: s.seq })) })
  }

  appendGuess(by: Seat, text: string, at: number): boolean {
    if (!this.ready) return false
    const result = withGuess(this.state, by, text, at)
    if (!result.accepted) return false
    this.commit(result.state)
    return true
  }

  markWrong(at: number) {
    if (!this.ready) return
    const next = withWrong(this.state, at)
    if (next !== this.state) this.commit(next)
  }

  /** Close the current round; the pure function scores it and is idempotent. */
  finish(result: DgState['roundResult']) {
    if (!this.ready || !result) return
    const next = finishRound(this.state, result)
    if (next !== this.state) this.commit(next)
  }

  advance() {
    if (!this.ready) return
    const next = advanceRound(this.state)
    if (next !== this.state) this.commit(next)
  }

  /** Update scores without touching the round (used when a result is settled). */
  setScores(scores: DgState['scores']) {
    if (!this.ready) return
    this.commit({ ...this.state, scores })
  }

  setTotalRounds(totalRounds: number) {
    if (!this.ready) return
    if (this.state.round > 1 || this.state.scores.length > 0) return
    this.commit({ ...this.state, totalRounds })
  }

  /** Write our own secret topic: memory + retained broker copy for reloads. */
  publishSecret(secret: Secret | null) {
    this.secret = secret
    if (!this.client?.connected) return
    this.client.publish(secretTopic(this.room, this.clientId), secret ? JSON.stringify(secret) : '', {
      qos: 1,
      retain: true,
    })
  }

  /** The retained secret for a given round, if we have already seen it. */
  secretFor(round: number): string | null {
    return this.secret && this.secret.round === round ? this.secret.text : null
  }

  activePeers(): Peer[] {
    const now = Date.now()
    const out: Peer[] = []
    const liveAt = (name: string): number | null => {
      let best: number | null = null
      for (const [, p] of this.presence) {
        if (now - p.ts > PRESENCE_TTL_MS) continue
        if (!sameName(p.name, name)) continue
        best = Math.max(best ?? 0, p.ts)
      }
      return best
    }
    for (const seat of [1, 2] as const) {
      const info = this.state.seats[seat]
      if (!info) continue
      const seen = liveAt(info.name)
      const isMe = sameName(info.name, this._name)
      if (seen === null && !isMe) continue
      out.push({ clientId: info.clientId, name: info.name, seat, seen: seen ?? now })
    }
    return out
  }

  dispose() {
    this.closed = true
    this.stopTimers()
    if (this.readyTimer) clearTimeout(this.readyTimer)
    if (this.seatTimer) clearTimeout(this.seatTimer)
    // Clear presence so the seat frees up. The state is deliberately untouched:
    // leaving must never be able to rewind a live round.
    if (this.client?.connected) {
      this.client.publish(presenceTopic(this.room, this.clientId), '', { qos: 0, retain: true })
      this.client.publish(secretTopic(this.room, this.clientId), '', { qos: 1, retain: true })
    }
    try {
      this.client?.end(true)
    } catch {
      /* already closed */
    }
    this.client = null
  }
}
