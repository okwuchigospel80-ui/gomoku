// Shop panel: shows the player's balance and their bag, plus the catalog.
//
// Cards are consumed with a single click — no state machine, by request. Using a
// card records a local "已使用" note and drops one copy from the bag; the partner
// sees the same inventory (it is part of the shared profile) but the "已使用"
// line is local-only, since it is a courtesy note rather than game data.

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

// Neutral bullets: the group names on screen must not hint at content.
const thumb = (g: CardGroup) => (g === 'violet' ? '◆' : g === 'amber' ? '◆' : '◆')

export class ShopPanel {
  readonly el: HTMLDivElement
  private balanceEl: HTMLDivElement
  private bagEl: HTMLDivElement
  private catalogEl: HTMLDivElement
  private partnerEl: HTMLDivElement
  private opts: ShopOptions

  constructor(opts: ShopOptions) {
    this.opts = opts

    this.balanceEl = document.createElement('div')
    this.balanceEl.className = 'shop-balance'

    this.partnerEl = document.createElement('div')
    this.partnerEl.className = 'shop-partner'

    this.bagEl = document.createElement('div')
    this.bagEl.className = 'shop-bag'

    this.catalogEl = document.createElement('div')
    this.catalogEl.className = 'shop-catalog'

    this.el = document.createElement('div')
    this.el.className = 'shop'
    this.el.append(
      this.balanceEl,
      this.partnerEl,
      section('我的卡包', this.bagEl),
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
    this.renderCatalog(p)
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
    const groups: CardGroup[] = ['violet', 'amber', 'slate']
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
