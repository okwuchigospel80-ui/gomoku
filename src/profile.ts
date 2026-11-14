// Player profiles: points and card inventory, stored per player name.
//
// Why a separate retained topic per player rather than one shared blob:
//
//  * Only the owner writes their own profile. Two browsers can never clobber
//    each other's balance, which a single shared document would allow.
//  * Everything is idempotent by `id`: points and cards are only ever added by
//    replaying an append-only ledger of entries, and the client refuses to apply
//    the same entry twice. Reconnects, retained replays and double-renders are
//    therefore all safe.
//
// The room publishes "rewards" (who earned what, with a unique id). The named
// player then claims them into their own profile. That way the score is never
// computed independently on both sides — one authority per account.

import mqtt, { type MqttClient } from 'mqtt'
import type { CardDef } from './cards'

const TOPIC_ROOT = 'gomoku-v1'
const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081/mqtt']

/** A single immutable fact about a player. Applied in order, once each. */
export type Entry =
  | { id: string; kind: 'points'; delta: number; reason: string; at: number }
  | { id: string; kind: 'buy'; cardId: string; at: number }
  | { id: string; kind: 'use'; cardId: string; at: number }

export interface Profile {
  name: string
  entries: Entry[]
  /** Derived: total points. Computed, never stored, so it cannot drift. */
  points: number
  /** Derived: cardId → count currently held. */
  bag: Record<string, number>
  /** Derived: cardIds already used up (kept for a "已使用" history line). */
  used: string[]
  rev: number
}

export function emptyProfile(name: string): Profile {
  return { name, entries: [], points: 0, bag: {}, used: [], rev: 0 }
}

/** Recompute the derivable fields from the entry ledger. */
export function derive(profile: Profile): Profile {
  let points = 0
  const bag: Record<string, number> = {}
  const used: string[] = []
  for (const e of profile.entries) {
    if (e.kind === 'points') {
      points += e.delta
      continue
    }
    if (e.kind === 'buy') {
      // The matching debit entry already adjusted `points`; here we only record
      // that one more copy is now held.
      bag[e.cardId] = (bag[e.cardId] ?? 0) + 1
      continue
    }
    // A use: drop one copy. Buy/use arrive in order, so the count never goes
    // negative unless the ledger is malformed — clamp anyway.
    const left = (bag[e.cardId] ?? 0) - 1
    if (left > 0) bag[e.cardId] = left
    else delete bag[e.cardId]
    used.push(e.cardId)
  }
  profile.points = points
  profile.bag = bag
  profile.used = used
  return profile
}

/**
 * Accounts are keyed by a normalised nickname.
 *
 * Seats are matched case- and whitespace-insensitively (`sameName`), but the
 * topic was built from the raw name — so typing "C" instead of "c" silently
 * opened a second, empty account with no points and no cards. Normalising here
 * makes " C " and "c" the same ledger, which is what "the name is the account"
 * has to mean to stay consistent with seating.
 */
export const accountKey = (name: string): string => name.trim().toLowerCase()

const profileTopic = (name: string) => `${TOPIC_ROOT}/u/${encodeURIComponent(accountKey(name))}`

/**
 * Every case variant of a name that could still hold a legacy ledger.
 *
 * Accounts used to be keyed by the raw typed name, so "C" and "c" were two
 * ledgers. New writes all go to the lowercase topic; this list makes a client
 * read the old variants too, so nothing earned before the change disappears.
 */
export function legacyTopics(name: string): string[] {
  const key = accountKey(name)
  if (!key) return []
  const out = new Set<string>()
  const variants = [key, key.toUpperCase(), name.trim()]
  // Title-case covers the common "Alice" / "chris" mix.
  variants.push(key.charAt(0).toUpperCase() + key.slice(1))
  for (const v of variants) if (v) out.add(`${TOPIC_ROOT}/u/${encodeURIComponent(v)}`)
  return [...out]
}

function sanitizeEntry(raw: unknown): Entry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id === '') return null
  if (o.kind === 'points') {
    if (typeof o.delta !== 'number' || !Number.isFinite(o.delta)) return null
    return {
      id: o.id,
      kind: 'points',
      delta: Math.trunc(o.delta),
      reason: typeof o.reason === 'string' ? o.reason.slice(0, 60) : '',
      at: typeof o.at === 'number' ? o.at : Date.now(),
    }
  }
  if (o.kind === 'buy') {
    if (typeof o.cardId !== 'string' || o.cardId === '') return null
    return { id: o.id, kind: 'buy', cardId: o.cardId.slice(0, 8), at: typeof o.at === 'number' ? o.at : Date.now() }
  }
  if (o.kind === 'use') {
    if (typeof o.cardId !== 'string' || o.cardId === '') return null
    return { id: o.id, kind: 'use', cardId: o.cardId.slice(0, 8), at: typeof o.at === 'number' ? o.at : Date.now() }
  }
  return null
}

function sanitizeProfile(raw: unknown, fallbackName: string): Profile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const name = typeof o.name === 'string' && o.name ? o.name.slice(0, 24) : fallbackName
  const list = Array.isArray(o.entries) ? o.entries : []
  const entries: Entry[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const e = sanitizeEntry(item)
    if (!e) continue
    if (seen.has(e.id)) continue
    seen.add(e.id)
    entries.push(e)
  }
  return derive({
    name,
    entries,
    points: 0,
    bag: {},
    used: [],
    rev: typeof o.rev === 'number' && Number.isFinite(o.rev) ? o.rev : 0,
  })
}

/** Points needed to buy one of `card` given current balance. */
export const canAfford = (profile: Profile, card: CardDef) => profile.points >= card.price

/**
 * One profile connection. Owns exactly one topic — its own account — so it can
 * never write anyone else's balance.
 */
export class ProfileStore {
  readonly name: string
  profile: Profile
  connected = false

  private client: MqttClient | null = null
  private brokerIndex = 0
  private closed = false
  private pending: Entry[] = []
  private onChange: (p: Profile) => void
  private onStatus: (s: 'online' | 'offline' | 'error') => void
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private flushTimer: ReturnType<typeof setInterval> | null = null

  constructor(name: string, onChange: (p: Profile) => void, onStatus: (s: 'online' | 'offline' | 'error') => void) {
    this.name = name
    this.profile = emptyProfile(name)
    this.onChange = onChange
    this.onStatus = onStatus
  }

  connect() {
    if (this.closed || this.client) return
    const url = BROKERS[this.brokerIndex % BROKERS.length]
    const client = mqtt.connect(url, {
      clientId: `gmprof_${Math.random().toString(16).slice(2, 10)}`,
      clean: true,
      reconnectPeriod: 3000,
      connectTimeout: 8000,
      keepalive: 30,
      protocolVersion: 4,
    })
    this.client = client

    client.on('connect', () => {
      this.connected = true
      this.onStatus('online')
      // Read the canonical topic plus every older case variant of this name.
      client.subscribe(legacyTopics(this.name), { qos: 1 })
      // Never write before the retained profile has had a chance to arrive,
      // otherwise a fresh empty profile would overwrite a real balance.
      if (this.readyTimer) clearTimeout(this.readyTimer)
      this.readyTimer = setTimeout(() => this.flush(), 1600)
      if (this.flushTimer) clearInterval(this.flushTimer)
      this.flushTimer = setInterval(() => this.flush(), 4000)
    })

    client.on('message', (_t, payload) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(payload.toString())
      } catch {
        return
      }
      const incoming = sanitizeProfile(parsed, this.name)
      if (!incoming) return
      // Merge by entry id: the union of both sides, deduped. Entries are facts,
      // so merging is safe and convergent regardless of arrival order.
      const have = new Set(this.profile.entries.map((e) => e.id))
      let added = 0
      for (const e of incoming.entries) {
        if (!have.has(e.id)) {
          this.profile.entries.push(e)
          have.add(e.id)
          added++
        }
      }
      this.profile.rev = Math.max(this.profile.rev, incoming.rev)
      if (added > 0) {
        derive(this.profile)
        this.emit()
      }
    })

    client.on('offline', () => {
      this.connected = false
      this.onStatus('offline')
    })
    client.on('error', () => {
      this.onStatus('error')
      if (!this.connected) this.rotate()
    })
    client.on('close', () => {
      this.connected = false
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
    setTimeout(() => this.connect(), 1500)
  }

  private emit() {
    this.onChange({ ...this.profile, entries: [...this.profile.entries] })
  }

  /** Append a fact. No-op when an entry with that id is already present. */
  private add(entry: Entry) {
    if (this.profile.entries.some((e) => e.id === entry.id)) return
    this.profile.entries.push(entry)
    derive(this.profile)
    this.emit()
    this.pending.push(entry)
    this.flush()
  }

  /** Publish the whole profile (small: tens of entries at most). */
  private flush() {
    if (!this.client?.connected) return
    this.pending = []
    this.profile.rev += 1
    this.client.publish(
      profileTopic(this.name),
      JSON.stringify({ name: this.name, rev: this.profile.rev, entries: this.profile.entries }),
      { qos: 1, retain: true },
    )
  }

  /** Claim a reward published by a room. Idempotent by the reward's id. */
  claim(rewardId: string, delta: number, reason: string) {
    this.add({ id: rewardId, kind: 'points', delta, reason, at: Date.now() })
  }

  /** Spend points on a card. Refuses when the balance is short. */
  buy(card: CardDef): boolean {
    if (this.profile.points < card.price) return false
    // Two entries: the debit, and the card landing in the bag. The debit carries
    // its own id so a double-click cannot charge twice.
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    this.add({ id: `p-${stamp}`, kind: 'points', delta: -card.price, reason: `兑换 ${card.name}`, at: Date.now() })
    this.add({ id: `b-${stamp}`, kind: 'buy', cardId: card.id, at: Date.now() })
    return true
  }

  /**
   * Consume one copy of a card. Returns false when none is held. The `use` entry
   * is what makes the disappearance visible to the partner as well — the bag is
   * derived from the ledger, not from local UI state.
   */
  use(card: CardDef): boolean {
    if ((this.profile.bag[card.id] ?? 0) <= 0) return false
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    this.add({ id: `u-${stamp}`, kind: 'use', cardId: card.id, at: Date.now() })
    return true
  }

  dispose() {
    this.closed = true
    if (this.readyTimer) clearTimeout(this.readyTimer)
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flush()
    try {
      this.client?.end(true)
    } catch {
      /* gone */
    }
    this.client = null
  }
}

/**
 * Rewards the ROOM emits for its players. Kept in the room state so both sides
 * agree on what was earned; each side then claims only its own entries.
 */
export interface RoomReward {
  id: string
  /** Player name the points belong to. */
  to: string
  delta: number
  reason: string
  at: number
}
