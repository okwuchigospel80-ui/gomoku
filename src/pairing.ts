// Pairing: a room belongs to a PAIR of players.
//
// Rule (by request): when A creates a room and B walks in, that room is bound to
// the pair (A, B) forever. Afterwards, whoever opens A's room is treated as B —
// on any device — because they are the partner of A. Rooms created by B work the
// same way with the roles reversed. Both players can see each other's points and
// cards.
//
// Storage: one retained MQTT message per OWNER name:
//     gomoku-v1/pair/<ownerName>  ->  { owner, partner, at }
//
// The pairing is established once, by the first guest to sit down, and is never
// overwritten afterwards (see `bind`). That makes it stable across reloads,
// devices and browsers, which is the whole point.

import mqtt, { type MqttClient } from 'mqtt'

const TOPIC_ROOT = 'gomoku-v1'
const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081/mqtt']

/** How long a new client waits for the retained pairing before deciding none exists. */
const RETAIN_WAIT_MS = 1600

export interface Pair {
  /** Room creator / owner of this pairing. */
  owner: string
  /** The fixed partner. */
  partner: string
  at: number
}

// Same rule as profiles: the owner key is normalised, or "C" and "c" would be
// two different bindings for the same person.
export const pairTopic = (owner: string) =>
  `${TOPIC_ROOT}/pair/${encodeURIComponent(owner.trim().toLowerCase())}`

/** Case variants that may still hold a pairing written before keys were normalised. */
export function legacyPairTopics(owner: string): string[] {
  const key = owner.trim().toLowerCase()
  if (!key) return []
  const out = new Set<string>()
  for (const v of [key, key.toUpperCase(), owner.trim(), key.charAt(0).toUpperCase() + key.slice(1)]) {
    if (v) out.add(`${TOPIC_ROOT}/pair/${encodeURIComponent(v)}`)
  }
  return [...out]
}

const norm = (s: string) => s.trim().toLowerCase()

export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return norm(a) === norm(b)
}

function sanitize(raw: unknown): Pair | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.owner !== 'string' || !o.owner.trim()) return null
  if (typeof o.partner !== 'string' || !o.partner.trim()) return null
  return {
    owner: o.owner.slice(0, 24),
    partner: o.partner.slice(0, 24),
    at: typeof o.at === 'number' ? o.at : 0,
  }
}

export interface PairEvents {
  /** Fired whenever the pairing for `owner` is known or changes. */
  onPair(pair: Pair | null): void
  onStatus(ok: boolean): void
}

/**
 * Watches one owner's pairing and can create it once.
 *
 * Only the owner's side ever writes this topic, so there is no contention: the
 * guest contributes their name to the room state, and the owner (or the guest
 * acting for the room) creates the record on first meeting.
 */
export class PairStore {
  readonly owner: string
  pair: Pair | null = null
  ready = false

  private client: MqttClient | null = null
  private brokerIndex = 0
  private closed = false
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private events: PairEvents

  constructor(owner: string, events: PairEvents) {
    this.owner = owner
    this.events = events
  }

  connect() {
    if (this.closed || this.client) return
    this.open()
  }

  private open() {
    if (this.closed) return
    const url = BROKERS[this.brokerIndex % BROKERS.length]
    const client = mqtt.connect(url, {
      clientId: `gmpair_${Math.random().toString(16).slice(2, 10)}`,
      clean: true,
      reconnectPeriod: 3000,
      connectTimeout: 8000,
      keepalive: 30,
      protocolVersion: 4,
    })
    this.client = client

    client.on('connect', () => {
      this.events.onStatus(true)
      client.subscribe(legacyPairTopics(this.owner), { qos: 1 })
      if (this.readyTimer) clearTimeout(this.readyTimer)
      // If nothing arrives, the room has never been paired.
      this.readyTimer = setTimeout(() => {
        if (!this.ready) {
          this.ready = true
          this.events.onPair(this.pair)
        }
      }, RETAIN_WAIT_MS)
    })

    client.on('message', (_t, payload) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(payload.toString())
      } catch {
        return
      }
      const incoming = sanitize(parsed)
      if (!incoming) return
      this.pair = incoming
      this.ready = true
      if (this.readyTimer) clearTimeout(this.readyTimer)
      this.events.onPair(incoming)
    })

    client.on('offline', () => this.events.onStatus(false))
    client.on('error', () => {
      this.events.onStatus(false)
      if (!this.client?.connected) this.rotate()
    })
  }

  private rotate() {
    this.brokerIndex++
    if (this.brokerIndex >= BROKERS.length) return
    const old = this.client
    this.client = null
    try {
      old?.end(true)
    } catch {
      /* gone */
    }
    setTimeout(() => this.open(), 1500)
  }

  /**
   * Establish the pairing if it does not exist yet. Never overwrites: once a
   * room is bound, that binding stands.
   */
  bind(partner: string): void {
    if (this.pair) return
    if (!partner.trim() || sameName(partner, this.owner)) return
    const pair: Pair = { owner: this.owner, partner: partner.slice(0, 24), at: Date.now() }
    this.pair = pair
    if (this.client?.connected) {
      this.client.publish(pairTopic(this.owner), JSON.stringify(pair), { qos: 1, retain: true })
    }
    this.events.onPair(pair)
  }

  dispose() {
    this.closed = true
    if (this.readyTimer) clearTimeout(this.readyTimer)
    try {
      this.client?.end(true)
    } catch {
      /* gone */
    }
    this.client = null
  }
}

/**
 * Decides who a client is in a given room.
 *
 *  - The room's creator is themselves.
 *  - If the room is already paired, anyone else is the partner.
 *  - Before pairing, the first guest to arrive becomes the partner (and the
 *    binding is written).
 */
export function resolveRole(
  me: string,
  creator: string,
  pair: Pair | null,
): { role: 'owner' | 'partner'; partnerName: string | null } {
  if (sameName(me, creator)) {
    return { role: 'owner', partnerName: pair?.partner ?? null }
  }
  return { role: 'partner', partnerName: pair?.partner ?? null }
}
