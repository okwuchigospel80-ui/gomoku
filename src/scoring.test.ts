// Scoring and inventory tests. Run with: node --test src/scoring.test.ts
// No DOM, no network — the ledger maths is what we want to pin down.

import assert from 'node:assert/strict'
import test from 'node:test'
import { CARDS, UNDO_PENALTY, WIN_POINTS, CARD_BY_ID } from './cards.ts'
import { derive, emptyProfile, type Entry, type Profile } from './profile.ts'

const pts = (id: string, delta: number): Entry => ({ id, kind: 'points', delta, reason: 't', at: 0 })
const buy = (id: string, cardId: string): Entry => ({ id, kind: 'buy', cardId, at: 0 })
const use = (id: string, cardId: string): Entry => ({ id, kind: 'use', cardId, at: 0 })

function profileWith(entries: Entry[]): Profile {
  return derive({ ...emptyProfile('t'), entries })
}

/* ---------------- catalog ---------------- */

test('catalog ids are unique and every id resolves', () => {
  const ids = CARDS.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const c of CARDS) assert.equal(CARD_BY_ID.get(c.id)?.name, c.name)
})

test('catalog has the prices the user specified', () => {
  const price = (id: string) => CARD_BY_ID.get(id)?.price
  assert.equal(price('c01'), 1)
  assert.equal(price('c02'), 10)
  assert.equal(price('c03'), 20)
  assert.equal(price('c04'), 50)
  assert.equal(price('c05'), 100)
})

test('undo penalties sum to 18 and wins are worth 15', () => {
  assert.deepEqual([...UNDO_PENALTY], [3, 5, 10])
  assert.equal(UNDO_PENALTY.reduce((a, b) => a + b, 0), 18)
  assert.equal(WIN_POINTS, 15)
})

test('every card has a non-empty description', () => {
  for (const c of CARDS) assert.ok(c.desc.trim().length > 0, `${c.name} missing desc`)
})

/* ---------------- ledger maths ---------------- */

test('empty profile is zero points, empty bag', () => {
  const p = profileWith([])
  assert.equal(p.points, 0)
  assert.deepEqual(p.bag, {})
})

test('points accumulate', () => {
  const p = profileWith([pts('a', 3), pts('b', 5), pts('c', 10), pts('d', 15)])
  assert.equal(p.points, 33)
})

test('three undos against you pay 3 then 5 then 10', () => {
  const p = profileWith([
    pts('u1', UNDO_PENALTY[0]),
    pts('u2', UNDO_PENALTY[1]),
    pts('u3', UNDO_PENALTY[2]),
  ])
  assert.equal(p.points, 18)
})

test('buying debits points and adds one copy', () => {
  const p = profileWith([
    pts('win1', 15),
    pts('debit', -10),
    buy('buy1', 'c02'),
  ])
  assert.equal(p.points, 5)
  assert.deepEqual(p.bag, { c02: 1 })
})

test('buying the same card twice stacks the count', () => {
  const p = profileWith([
    pts('s', 100),
    pts('d1', -1),
    buy('b1', 'c01'),
    pts('d2', -1),
    buy('b2', 'c01'),
  ])
  assert.equal(p.points, 98)
  assert.deepEqual(p.bag, { c01: 2 })
})

test('using a card removes exactly one copy', () => {
  const p = profileWith([
    pts('s', 100),
    pts('d1', -1),
    buy('b1', 'c01'),
    pts('d2', -1),
    buy('b2', 'c01'),
    use('u1', 'c01'),
  ])
  assert.equal(p.points, 98) // using does not refund
  assert.deepEqual(p.bag, { c01: 1 })
})

test('using the last copy drops the key entirely', () => {
  const p = profileWith([pts('s', 5), pts('d', -1), buy('b', 'c01'), use('u', 'c01')])
  assert.deepEqual(p.bag, {})
  assert.deepEqual(p.used, ['c01'])
})

test('using a card you do not own never makes the count negative', () => {
  const p = profileWith([use('u1', 'c01')])
  assert.deepEqual(p.bag, {})
})

test('balance can go negative only if the ledger is malformed (still deterministic)', () => {
  // A spend without a matching credit — the UI prevents this, but the maths
  // must not crash or produce NaN.
  const p = profileWith([pts('d', -50)])
  assert.equal(p.points, -50)
})

test('duplicate entry ids are the caller’s job; derive applies what it is given', () => {
  // ProfileStore.add() rejects duplicates before they reach the ledger; here we
  // only document that derive is a pure fold.
  const p = profileWith([pts('same', 5), pts('same', 5)])
  assert.equal(p.points, 10)
})

/* ---------------- affordability ---------------- */

test('affordability compares against the exact price', () => {
  const card = CARD_BY_ID.get('c04')! // 做爱卡 50
  assert.equal(profileWith([pts('a', 49)]).points >= card.price, false)
  assert.equal(profileWith([pts('a', 50)]).points >= card.price, true)
})

test('the full intended price ladder is monotonic-ish by group', () => {
  const first = CARDS.filter((c) => c.group === 'violet').map((c) => c.price)
  // Ascending within the first group, so the shop reads as a ladder.
  assert.deepEqual(first, [...first].sort((a, b) => a - b))
})

test('catalog leaks no real card names', () => {
  // This file is public in the deployed bundle. Guard against someone pasting
  // the real wording back in by accident.
  const forbidden = ['亲亲', '舌吻', '口交', '做爱', '和好', '拥抱', '赞美', '点歌', '家务', '早餐', '约会', '按摩', '情书']
  const blob = JSON.stringify(CARDS)
  for (const word of forbidden) {
    assert.equal(blob.includes(word), false, `catalog still contains "${word}"`)
  }
})
