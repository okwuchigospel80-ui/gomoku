// Shop panel: balance, bag, catalog, and the score history.
//
// Cards are consumed with a single click — no state machine, by request. Using a
// card drops one copy from the bag; the partner sees the same inventory because
// it is part of the shared profile.

import { CARDS, GROUP_LABEL, type CardDef, type CardGroup } from './cards'
import { canAfford, type Profile, type ProfileStore } from './profile'

export interface ShopOptions {
  /** Live profile of the local player. */
  getProfile: () => Profile
  /** Live profile of the partner, when known. */
  getPartner: () => { name: string; profile: Profile } | null
  store: () => ProfileStore | null
  onBuy: (card: CardDef) => void
  onUse: (card: CardDef) => void
}

/** One line of the score history, built from the append-only ledger. */
interface HistoryRow {
  at: number
  /** null for card events that do not move the balance on their own. */
  delta: number | null
  text: string
  tone: 'earn' | 'spend' | 'card'
}

// Neutral bullets: the group names on screen must not hint at content.
const thumb = (g: CardGroup) => (g === 'intimate' ? '♡' : g === 'life' ? '✦' : '⚑')

export class ShopPanel {
  readonly el: HTMLDivElement
  private balanceEl: HTMLDivElement
  private bagEl: HTMLDivElement
  private catalogEl: HTMLDivElement
  private partnerEl: HTMLDivElement
  private historyEl: HTMLDivElement
  private opts: ShopOptions

  constructor(opts: ShopOptions) {
    this.opts = opts

    this.balanceEl = document.createElement('div')
    this.balanceEl.className = 'shop-balance'

    this.partnerEl = document.createElement('div')
    this.partnerEl.className = 'shop-partner'

    this.bagEl = document.createElement('div')
    this.bagEl.className = 'shop-bag'

    this.historyEl = document.createElement('div')
    this.historyEl.className = 'shop-history'

    this.catalogEl = document.createElement('div')
    this.catalogEl.className = 'shop-catalog'

    this.el = document.createElement('div')
    this.el.className = 'shop'
    this.el.append(
      this.balanceEl,
      this.partnerEl,
      section('我的卡包', this.bagEl),
      section('积分记录', this.historyEl),
      section('商店', this.catalogEl),
    )
  }

  /** Re-render everything. Cheap: the catalog is ~17 rows. */
  render() {
    const p = this.opts.getProfile()
    const partner = this.opts.getPartner()

    this.balanceEl.replaceChildren(
      text('div', 'shop-points', String(p.points)),
      text('div', 'shop-points-label', `${p.name} · 积分`),
    )

    if (partner) {
      this.partnerEl.replaceChildren(
        text('span', 'shop-partner-name', partner.name),
        text('span', 'shop-partner-points', `${partner.profile.points} 分`),
        text('span', 'shop-partner-cards', `${bagCount(partner.profile)} 张卡`),
      )
      this.partnerEl.hidden = false
    } else {
      this.partnerEl.hidden = true
    }

    this.renderBag(p)
    this.renderHistory(p)
    this.renderCatalog(p)
  }

  /**
   * Score history, newest first. Derived from the same ledger that produces the
   * balance, so the numbers here always add up to `p.points`.
   */
  private renderHistory(p: Profile) {
    const rows: HistoryRow[] = []
    for (const e of p.entries) {
      if (e.kind === 'points') {
        const card = /兑换 (.+)/.exec(e.reason)
        if (card) {
          // The debit that accompanies a purchase is folded into the buy row.
          continue
        }
        rows.push({
          at: e.at,
          delta: e.delta,
          text: e.reason || (e.delta >= 0 ? '得分' : '扣分'),
          tone: e.delta >= 0 ? 'earn' : 'spend',
        })
      } else if (e.kind === 'buy') {
        const card = CARDS.find((c) => c.id === e.cardId)
        rows.push({
          at: e.at,
          delta: card ? -card.price : null,
          text: `兑换 ${card?.name ?? e.cardId}`,
          tone: 'card',
        })
      } else {
        const card = CARDS.find((c) => c.id === e.cardId)
        rows.push({ at: e.at, delta: null, text: `使用 ${card?.name ?? e.cardId}`, tone: 'card' })
      }
    }

    if (rows.length === 0) {
      this.historyEl.replaceChildren(text('div', 'shop-empty', '还没有记录，赢一局或等对手悔棋就有分了'))
      return
    }

    rows.sort((a, b) => b.at - a.at)
    const shown = rows.slice(0, 30)
    this.historyEl.replaceChildren(
      ...shown.map((r) => {
        const row = document.createElement('div')
        row.className = `history-row ${r.tone}`
        const sign = r.delta === null ? '' : r.delta > 0 ? `+${r.delta}` : String(r.delta)
        row.append(
          text('span', 'history-time', shortTime(r.at)),
          text('span', 'history-text', r.text),
          text('span', 'history-delta', sign),
        )
        return row
      }),
    )
    if (rows.length > shown.length) {
      this.historyEl.append(text('div', 'shop-empty', `仅显示最近 ${shown.length} 条`))
    }
  }

  private renderBag(p: Profile) {
    const owned = Object.entries(p.bag).filter(([, n]) => n > 0)
    if (owned.length === 0) {
      this.bagEl.replaceChildren(text('div', 'shop-empty', '还没有卡片，去下面换一张吧'))
      return
    }
    const rows = owned.map(([id, count]) => {
      const card = CARDS.find((c) => c.id === id)
      if (!card) return document.createElement('span')
      const row = document.createElement('div')
      row.className = 'bag-row'
      row.append(
        text('span', 'bag-name', `${thumb(card.group)} ${card.name}`),
        text('span', 'bag-count', `×${count}`),
      )
      const use = document.createElement('button')
      use.className = 'btn btn-ghost bag-use'
      use.type = 'button'
      use.textContent = '使用'
      use.addEventListener('click', () => {
        if (!window.confirm(`使用「${card.name}」？使用后这张卡就没了。`)) return
        this.opts.onUse(card)
        this.render()
      })
      row.append(use)
      return row
    })
    this.bagEl.replaceChildren(...rows)
  }

  private renderCatalog(p: Profile) {
    const groups: CardGroup[] = ['intimate', 'life', 'pact']
    const out: HTMLElement[] = []
    for (const g of groups) {
      out.push(text('div', 'catalog-group', GROUP_LABEL[g]))
      for (const card of CARDS.filter((c) => c.group === g)) {
        const afford = canAfford(p, card)
        const row = document.createElement('div')
        row.className = `catalog-row${afford ? '' : ' disabled'}`
        row.append(
          text('span', 'catalog-price', `${card.price}`),
          (() => {
            const mid = document.createElement('div')
            mid.className = 'catalog-mid'
            mid.append(text('div', 'catalog-name', card.name), text('div', 'catalog-desc', card.desc))
            return mid
          })(),
        )
        const buy = document.createElement('button')
        buy.className = 'btn btn-primary catalog-buy'
        buy.type = 'button'
        buy.textContent = afford ? '兑换' : '不足'
        buy.disabled = !afford
        buy.addEventListener('click', () => {
          this.opts.onBuy(card)
          this.render()
        })
        row.append(buy)
        out.push(row)
      }
    }
    this.catalogEl.replaceChildren(...out)
  }
}

function section(title: string, body: HTMLElement): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'shop-section'
  wrap.append(text('div', 'shop-section-title', title), body)
  return wrap
}

function text<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  content: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  n.className = cls
  n.textContent = content
  return n
}

function bagCount(p: Profile): number {
  return Object.values(p.bag).reduce((a, b) => a + b, 0)
}

/** "今天 14:32" / "11-07 09:15" — compact but unambiguous. */
function shortTime(at: number): string {
  if (!at) return ''
  const d = new Date(at)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) return `今天 ${hm}`
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${md} ${hm}`
}
