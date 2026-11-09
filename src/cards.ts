// Shop catalog.
//
// Privacy note: this file is public (the site is a static bundle on a public
// repo), so the cards carry NEUTRAL code names only. The real meaning of each
// card lives in `card-legend.md`, which is NOT committed. Keep that property if
// you edit this file: never put the real name or a revealing description here.
//
// The wire payload uses only the opaque `id`, so MQTT traffic reveals nothing
// beyond "someone bought c03".

export type CardGroup = 'violet' | 'amber' | 'slate'

export interface CardDef {
  /** Stable, opaque wire id. Never renumber: existing inventories reference it. */
  id: string
  /** Neutral display name. Map it to its real meaning in card-legend.md. */
  name: string
  price: number
  /** Deliberately bland. Must not hint at the real effect. */
  desc: string
  group: CardGroup
}

export const CARDS: readonly CardDef[] = [
  // --- 第一组 ---
  { id: 'c01', name: '卡 A', price: 1, group: 'violet', desc: '轻量级小互动，随取随用。' },
  { id: 'c02', name: '卡 B', price: 10, group: 'violet', desc: '中等强度的互动，适合有心情的时候。' },
  { id: 'c03', name: '卡 C', price: 20, group: 'violet', desc: '较重的互动，需要对方配合。' },
  { id: 'c04', name: '卡 D', price: 50, group: 'violet', desc: '大额稀有卡，留到特别的日子。' },
  { id: 'c05', name: '卡 E', price: 100, group: 'violet', desc: '最高档的卡，用一次抵很多局。' },

  // --- 第二组 ---
  { id: 'c06', name: '卡 F', price: 2, group: 'amber', desc: '日常小确幸，随手兑换不心疼。' },
  { id: 'c07', name: '卡 G', price: 3, group: 'amber', desc: '日常向，一分钟内能兑现。' },
  { id: 'c08', name: '卡 H', price: 5, group: 'amber', desc: '需要对方花点心思的小事。' },
  { id: 'c09', name: '卡 I', price: 10, group: 'amber', desc: '会影响对局走向的一次干预。' },
  { id: 'c10', name: '卡 J', price: 15, group: 'amber', desc: '一次性的豁免额度。' },
  { id: 'c11', name: '卡 K', price: 20, group: 'amber', desc: '需要早起配合的项目。' },
  { id: 'c12', name: '卡 L', price: 25, group: 'amber', desc: '需要提前安排时间的事。' },
  { id: 'c13', name: '卡 M', price: 30, group: 'amber', desc: '要花半小时的事情。' },
  { id: 'c14', name: '卡 N', price: 40, group: 'amber', desc: '一次性的大件心意。' },

  // --- 第三组 ---
  { id: 'c15', name: '卡 O', price: 8, group: 'slate', desc: '对局中的一次性豁免。' },
  { id: 'c16', name: '卡 P', price: 12, group: 'slate', desc: '对局中的一次额外机会。' },
  { id: 'c17', name: '卡 Q', price: 20, group: 'slate', desc: '影响下一局结算的加成。' },
]

export const CARD_BY_ID = new Map(CARDS.map((c) => [c.id, c]))

export const GROUP_LABEL: Record<CardGroup, string> = {
  violet: '第一组',
  amber: '第二组',
  slate: '第三组',
}

/** Scoring constants, exported so the UI and the rules cannot drift apart. */
export const WIN_POINTS = 15
/** Points the OPPONENT receives when you spend your 1st / 2nd / 3rd undo. */
export const UNDO_PENALTY = [3, 5, 10] as const
