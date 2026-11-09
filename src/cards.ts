// Shop catalog.
//
// Privacy note: this repo is public, so the five intimate cards are labelled with
// pinyin initials only (QQ / SW / KJ / ZA / HH). Their descriptions are the
// original wording. The real name mapping lives in `card-legend.md`, which is
// NOT committed.
//
// The wire payload uses only the opaque `id`, so MQTT traffic reveals nothing
// beyond "someone bought c03".

export type CardGroup = 'intimate' | 'life' | 'pact'

export interface CardDef {
  /** Stable, opaque wire id. Never renumber: existing inventories reference it. */
  id: string
  /** Display name. The intimate ones are initials; see card-legend.md. */
  name: string
  price: number
  desc: string
  group: CardGroup
}

export const CARDS: readonly CardDef[] = [
  // --- 私密向：名称只用首字母，简介保持原样 ---
  { id: 'c01', name: 'QQ卡', price: 1, group: 'intimate', desc: '碰一下的轻吻，点到就好。' },
  { id: 'c02', name: 'SW卡', price: 10, group: 'intimate', desc: '一个缠人一点的长吻。' },
  { id: 'c03', name: 'KJ卡', price: 20, group: 'intimate', desc: '让对方为你服务一次。' },
  { id: 'c04', name: 'ZA卡', price: 50, group: 'intimate', desc: '让对方主动，节奏由你定，直到你满意。' },
  { id: 'c05', name: 'HH卡', price: 100, group: 'intimate', desc: '无条件原谅一次，之后不再提起。' },

  // --- 生活向：原名 ---
  { id: 'c06', name: '拥抱卡', price: 2, group: 'life', desc: '30 秒拥抱，期间不许说话。' },
  { id: 'c07', name: '赞美卡', price: 3, group: 'life', desc: '认真夸你三句，不许敷衍。' },
  { id: 'c08', name: '点歌卡', price: 5, group: 'life', desc: '对方唱一首你点的歌。' },
  { id: 'c09', name: '观战指点卡', price: 10, group: 'life', desc: '让对方替你走一步，落点由对方决定。' },
  { id: 'c10', name: '家务豁免卡', price: 15, group: 'life', desc: '免做一次指定家务。' },
  { id: 'c11', name: '早餐卡', price: 20, group: 'life', desc: '对方把早餐送到床边。' },
  { id: 'c12', name: '约会卡', price: 25, group: 'life', desc: '对方安排一次约会，你只负责出席。' },
  { id: 'c13', name: '按摩卡', price: 30, group: 'life', desc: '15 分钟肩颈按摩。' },
  { id: 'c14', name: '情书卡', price: 40, group: 'life', desc: '手写一段话，拍照发你。' },

  // --- 约定向：原名 ---
  { id: 'c15', name: '免罚卡', price: 8, group: 'pact', desc: '本局你悔棋一次，不送对方分（口头约定）。' },
  { id: 'c16', name: '悔棋保护卡', price: 12, group: 'pact', desc: '额外获得一次悔棋机会（口头约定）。' },
  { id: 'c17', name: '双倍卡', price: 20, group: 'pact', desc: '下一局赢了按 30 分结算（口头约定）。' },
]

export const CARD_BY_ID = new Map(CARDS.map((c) => [c.id, c]))

export const GROUP_LABEL: Record<CardGroup, string> = {
  intimate: '私密',
  life: '生活',
  pact: '约定',
}

/** Scoring constants, exported so the UI and the rules cannot drift apart. */
export const WIN_POINTS = 15
/** Points the OPPONENT receives when you spend your 1st / 2nd / 3rd undo. */
export const UNDO_PENALTY = [3, 5, 10] as const
