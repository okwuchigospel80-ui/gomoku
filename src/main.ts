import './style.css'
import { isUnlocked, lock, tryUnlock } from './auth'
import {
  AXIS,
  BLACK,
  BOARD_SIZES,
  EMPTY,
  WHITE,
  colorOf,
  formatRoom,
  normalizeRoom,
  randomRoomCode,
  replay,
  undoTarget,
  type BoardSize,
  type Color,
  type Replay,
} from './board'
import { BoardView } from './renderer'
import { UNDO_PENALTY, WIN_POINTS } from './cards'
import { ProfileStore, type Profile } from './profile'
import { PairStore, sameName, type Pair } from './pairing'
import { ShopPanel } from './shop'
import { Room, UNDOS_PER_PLAYER, type ConnStatus, type GameState, type PlayerInfo } from './sync'
import { copyText, el, nameFromUrl, savedName, shareUrl, storeName, toast } from './dom'
import { mountDrawGuess, type DgView } from './dgmain'

const app = document.getElementById('app')!

/* ------------------------------------------------------------------ */
/* routing                                                             */
/* ------------------------------------------------------------------ */

type Route =
  | { kind: 'lobby' }
  | { kind: 'gomoku'; code: string }
  | { kind: 'drawguess'; code: string }

function route(): Route {
  const hash = location.hash.replace(/^#/, '')
  // `#/d/<code>` is 你画我猜, `#/g/<code>` and the legacy `#/r/<code>` are gomoku.
  // A draw-guess link only resolves while that game is offered; otherwise an old
  // invite would open a screen the lobby no longer lists.
  const dg = /^\/d\/([A-Za-z0-9-]+)/.exec(hash)
  if (dg && DRAWGUESS_ENABLED) {
    const code = normalizeRoom(dg[1])
    if (code.length >= 4) return { kind: 'drawguess', code }
  }
  const gm = /^\/[gr]\/([A-Za-z0-9-]+)/.exec(hash)
  if (gm) {
    const code = normalizeRoom(gm[1])
    if (code.length >= 4) return { kind: 'gomoku', code }
  }
  return { kind: 'lobby' }
}

function gotoRoom(code: string, game: 'g' | 'd') {
  location.hash = `#/${game}/${code}`
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

const colorLabel = (c: Color) => (c === BLACK ? '黑棋' : '白棋')

/* ------------------------------------------------------------------ */
/* password gate                                                      */
/* ------------------------------------------------------------------ */

function renderGate() {
  const input = el('input', {
    id: 'pass',
    type: 'password',
    placeholder: '输入访问密码',
    autocomplete: 'current-password',
    spellcheck: 'false',
  }) as HTMLInputElement

  const btn = el('button', { class: 'btn btn-primary', type: 'button' }, '进入') as HTMLButtonElement
  const err = el('p', { class: 'gate-err' }, '')

  const submit = async () => {
    const value = input.value
    if (!value) {
      input.focus()
      return
    }
    btn.disabled = true
    btn.textContent = '校验中…'
    const ok = await tryUnlock(value)
    if (ok) {
      render()
      return
    }
    btn.disabled = false
    btn.textContent = '进入'
    err.textContent = '密码不正确'
    input.select()
    input.focus()
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit()
  })
  input.addEventListener('input', () => {
    err.textContent = ''
  })
  btn.addEventListener('click', submit)

  const wrap = el(
    'div',
    { class: 'lobby gate' },
    el(
      'div',
      { class: 'brand' },
      el('div', { class: 'brand-mark' }, el('i')),
      el('div', {}, el('h1', {}, '五子棋'), el('p', {}, '私人棋室')),
    ),
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'field' }, el('label', { for: 'pass' }, '访问密码'), input),
      btn,
      err,
      el('p', { class: 'hint' }, '这是私人棋室，需要密码才能进入。密码由棋室主人提供。'),
    ),
  )

  app.replaceChildren(wrap)
  input.focus()
}

/* ------------------------------------------------------------------ */
/* name gate for direct room links                                     */
/* ------------------------------------------------------------------ */

/**
 * Shown when someone opens a room link without a nickname on this device.
 *
 * A shared link deliberately drops `?name=` (see `shareUrl`), so a guest always
 * lands here first. Without this they used to join as the literal name
 * "Player", which made them the wrong person on screen and — because seats are
 * matched by nickname — could even collide with another guest.
 */
function renderNameGate(code: string, game: 'g' | 'd') {
  const input = el('input', {
    id: 'guest-name',
    type: 'text',
    maxlength: '16',
    placeholder: '你的昵称',
    autocomplete: 'nickname',
  }) as HTMLInputElement

  const btn = el('button', { class: 'btn btn-primary', type: 'button' }, '进入房间') as HTMLButtonElement
  const err = el('p', { class: 'gate-err' }, '')

  const submit = () => {
    const v = input.value.trim().slice(0, 16)
    if (!v) {
      err.textContent = '请先填一个昵称'
      input.focus()
      return
    }
    pendingName = v
    storeName(v)
    render()
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit()
  })
  input.addEventListener('input', () => {
    err.textContent = ''
  })
  btn.addEventListener('click', submit)

  const wrap = el(
    'div',
    { class: 'lobby gate' },
    el(
      'div',
      { class: 'brand' },
      el('div', { class: 'brand-mark' }, el('i')),
      el(
        'div',
        {},
        el('h1', {}, game === 'g' ? '五子棋' : '你画我猜'),
        el('p', {}, `房间 ${formatRoom(code)}`),
      ),
    ),
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'field' }, el('label', { for: 'guest-name' }, '昵称'), input),
      btn,
      err,
      el('p', { class: 'hint' }, '昵称就是你和这个房间里积分、卡包的账本名，填一次会记在这台设备上。'),
    ),
  )

  app.replaceChildren(wrap)
  input.focus()
}

/* ------------------------------------------------------------------ */
/* lobby                                                              */
/* ------------------------------------------------------------------ */

let pendingName = nameFromUrl() ?? savedName()

/** One entry in the lobby's game picker. */
interface GameEntry {
  key: 'g' | 'd'
  title: string
  tagline: string
  detail: string
  accent: string
}

/**
 * Whether 你画我猜 is offered.
 *
 * Its code is complete and tested, but it is switched off for now: the live site
 * ships gomoku only. Flip this to `true` to bring it back — nothing else needs to
 * change. Direct `#/d/...` links are refused while it is off, so an old invite
 * cannot drop someone into a screen the lobby no longer offers.
 */
const DRAWGUESS_ENABLED = false

const ALL_GAMES: GameEntry[] = [
  {
    key: 'g',
    title: '五子棋',
    tagline: '轮流落子，先连五者胜',
    detail: '每人 3 次悔棋 · 赢一局 15 分',
    accent: '●○',
  },
  {
    key: 'd',
    title: '你画我猜',
    tagline: '一人画，一人猜，90 秒一回合',
    detail: '猜对 12 分 · 画手 8 分 · 速猜再 +5',
    accent: '✎',
  },
]

const GAMES: GameEntry[] = ALL_GAMES.filter(
  (g) => g.key === 'g' || DRAWGUESS_ENABLED,
)

function renderLobby() {
  const wrap = el('div', { class: 'lobby lobby-home' })

  const brand = el(
    'div',
    { class: 'brand' },
    el('div', { class: 'brand-mark' }, el('i')),
    el('div', {}, el('h1', {}, '我们的小游戏'), el('p', {}, '选一个游戏，创建房间，把链接发给对方')),
  )

  const nameInput = el('input', {
    id: 'name',
    type: 'text',
    maxlength: '16',
    placeholder: '你的昵称',
    autocomplete: 'nickname',
  }) as HTMLInputElement
  nameInput.value = pendingName

  const commitName = () => {
    const v = nameInput.value.trim().slice(0, 16)
    pendingName = v
    storeName(v)
    return v
  }

  const nameField = el(
    'div',
    { class: 'card name-card' },
    el('div', { class: 'field' }, el('label', { for: 'name' }, '昵称（两个游戏共用同一个账户）'), nameInput),
  )

  // One card per game, side by side on wide screens.
  const picks = el('div', { class: 'game-picks' })
  for (const game of GAMES) {
    const create = el(
      'button',
      { class: 'btn btn-primary', type: 'button' },
      `创建${game.title}房间`,
    ) as HTMLButtonElement
    create.addEventListener('click', () => {
      commitName()
      gotoRoom(randomRoomCode(), game.key)
    })
    picks.append(
      el(
        'div',
        { class: 'game-card' },
        el(
          'div',
          { class: 'game-card-head' },
          el('span', { class: 'game-card-mark' }, game.accent),
          el('div', {}, el('h2', {}, game.title), el('p', {}, game.tagline)),
        ),
        el('p', { class: 'game-card-detail' }, game.detail),
        create,
      ),
    )
  }

  // Joining by code: the code alone decides which game opens.
  const codeInput = el('input', {
    id: 'code',
    class: 'code',
    type: 'text',
    maxlength: '12',
    placeholder: 'ABC-DEF',
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement

  const joinBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '进入房间') as HTMLButtonElement
  const joinDrawBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '进你画我猜') as HTMLButtonElement
  const joinHint = el(
    'p',
    { class: 'hint' },
    DRAWGUESS_ENABLED ? '房间码本身分不出是哪个游戏，所以下面选了游戏再进。' : '输入对方给的房间码即可加入。',
  )

  codeInput.addEventListener('input', () => {
    const pos = codeInput.selectionStart ?? 0
    codeInput.value = normalizeRoom(codeInput.value)
    codeInput.setSelectionRange(pos, pos)
  })

  const joinCard = el(
    'div',
    { class: 'card' },
    el('div', { class: 'divider' }, '加入已有房间'),
    el('div', { class: 'field' }, el('label', { for: 'code' }, '房间码'), codeInput),
    DRAWGUESS_ENABLED ? el('div', { class: 'join-row' }, joinBtn, joinDrawBtn) : joinBtn,
    joinHint,
  )

  const join = (game: 'g' | 'd') => {
    commitName()
    const code = normalizeRoom(codeInput.value)
    if (code.length < 4) {
      toast('请输入有效房间码')
      codeInput.focus()
      return
    }
    gotoRoom(code, game)
  }

  joinBtn.addEventListener('click', () => join('g'))
  joinDrawBtn.addEventListener('click', () => join('d'))
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') join('g')
  })
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitName()
  })

  wrap.append(
    brand,
    nameField,
    picks,
    joinCard,
    el('p', { class: 'footnote' }, '无需注册 · 无需服务器 · 纯静态页面直连'),
  )
  app.replaceChildren(wrap)
  nameInput.focus()
}

/* ------------------------------------------------------------------ */
/* game                                                              */
/* ------------------------------------------------------------------ */

interface GameView {
  destroy(): void
}

function mountGame(code: string): GameView {
  // The name gate guarantees a nickname before a room is mounted.
  const room = new Room(code, pendingName, {
    onStatus: (s, detail) => onStatus(s, detail),
    onState: (s) => onState(s),
    onPeers: (p) => onPeers(p),
  })

  /** Current identity; may change when a bound partner is adopted. */
  const myName = (): string => room.name

  let lastPosition: Replay = replay([], room.state.size)
  let view: BoardView | null = null
  let status: ConnStatus = 'connecting'
  let peers: PlayerInfo[] = room.activePeers()
  let overlay: HTMLDivElement | null = null
  let settingsOpen = false
  let shopOpen = false
  let partnerStore: ProfileStore | null = null
  let partnerProfile: Profile | null = null
  /** The binding for THIS room's creator, once known. */
  let pair: Pair | null = null
  let pairStore: PairStore | null = null

  /* ---- DOM ---- */
  const canvas = el('canvas') as HTMLCanvasElement
  const boardFrame = el('div', { class: 'board-frame' }, canvas)

  const turnDot = el('div', { class: 'stone-dot black' })
  const turnText = el('div', {}, '正在连接…')
  const turnStrip = el('div', { class: 'turn-strip' }, turnDot, turnText)

  const boardWrap = el('div', { class: 'board-wrap' }, boardFrame, turnStrip)

  const roomCodeEl = el('div', { class: 'room-code' }, formatRoom(code))
  const statusDot = el('i', { class: 'dot connecting' })
  const statusText = el('span', {}, '连接中')
  const statusEl = el('span', { class: 'status' }, statusDot, statusText)

  const pairBadge = el('div', { class: 'pair-badge' })
  pairBadge.hidden = true

  const roomPanel = el(
    'div',
    { class: 'panel' },
    el('div', { class: 'panel-head' }, el('span', {}, '房间'), statusEl),
    roomCodeEl,
    pairBadge,
    el(
      'div',
      { class: 'share' },
      (() => {
        const input = el('input', { readonly: 'readonly' }) as HTMLInputElement
        input.value = shareUrl(code, 'g')
        input.addEventListener('focus', () => input.select())
        return input
      })(),
      (() => {
        const btn = el('button', { class: 'btn btn-ghost', type: 'button' }, '复制') as HTMLButtonElement
        btn.addEventListener('click', async () => {
          const ok = await copyText(shareUrl(code, 'g'))
          toast(ok ? '链接已复制，发给朋友吧' : '复制失败，请手动选中链接')
        })
        return btn
      })(),
    ),
  )

  const playersEl = el('div', { class: 'players' })

  const undoBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '悔棋') as HTMLButtonElement
  const resignBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '认输') as HTMLButtonElement
  const resetBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '重新开局') as HTMLButtonElement
  const settingsBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '设置') as HTMLButtonElement
  const shopBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '商店') as HTMLButtonElement
  const leaveBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '离开房间') as HTMLButtonElement
  const lockBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '锁定') as HTMLButtonElement

  /* ---- settings panel ---- */
  const sizeSelect = el('select', { class: 'size-select' }) as HTMLSelectElement
  for (const n of BOARD_SIZES) {
    const opt = el('option', { value: String(n) }, `${n} × ${n}`) as HTMLOptionElement
    sizeSelect.append(opt)
  }
  sizeSelect.addEventListener('change', () => {
    const next = Number(sizeSelect.value) as BoardSize
    if (lastPosition.placed > 0) {
      toast('对局进行中不能改棋盘大小，请先重新开局')
      sizeSelect.value = String(room.state.size)
      return
    }
    room.setSize(next)
    toast(`棋盘已切换为 ${next} × ${next}`)
  })

  const settingsBody = el(
    'div',
    { class: 'settings-body' },
    el('div', { class: 'field' }, el('label', {}, '棋盘大小'), sizeSelect),
    el(
      'p',
      { class: 'hint' },
      `悔棋每人 ${UNDOS_PER_PLAYER} 次，切回自己上一手；对方悔棋你得 ${UNDO_PENALTY.join('/')} 分（共 18）。赢一局 ${WIN_POINTS} 分。`,
    ),
  )
  const settingsPanel = el(
    'div',
    { class: 'panel settings-panel' },
    el('div', { class: 'panel-head' }, el('span', {}, '设置')),
    settingsBody,
  )
  settingsPanel.hidden = true

  /* ---- profile + shop ---- */

  /**
   * The profile follows the CURRENT identity, which may change when a bound
   * partner is adopted. Rebuilt whenever the name changes so points and cards
   * always come from the right account.
   */
  let profileStore: ProfileStore = makeProfileStore(myName())

  function makeProfileStore(name: string): ProfileStore {
    return new ProfileStore(
      name,
      () => {
        shop.render()
        renderTurn()
      },
      () => {
        /* profile connection status is not surfaced; the room's status covers it */
      },
    )
  }

  function rebindProfileIfNeeded() {
    if (profileStore.name === myName()) return
    profileStore.dispose()
    profileStore = makeProfileStore(myName())
    profileStore.connect()
    shop.render()
  }

  const shop = new ShopPanel({
    getProfile: () => profileStore.profile,
    getPartner: () => (partnerProfile ? { name: partnerProfile.name, profile: partnerProfile } : null),
    store: () => profileStore,
    onBuy: (card) => {
      const ok = profileStore.buy(card)
      toast(ok ? `已兑换「${card.name}」` : '积分不足')
    },
    onUse: (card) => {
      const store = profileStore
      const ok = store.use(card)
      toast(ok ? `已使用「${card.name}」` : `没有可用的「${card.name}」`)
    },
  })
  shop.render()

  const shopPanel = el(
    'div',
    { class: 'panel shop-panel' },
    el('div', { class: 'panel-head' }, el('span', {}, '积分商店')),
    shop.el,
  )
  shopPanel.hidden = true

  const onUnload = () => room.dispose()

  const actions = el(
    'div',
    { class: 'actions' },
    undoBtn,
    resignBtn,
    resetBtn,
    settingsBtn,
    shopBtn,
    leaveBtn,
    lockBtn,
  )
  const logEl = el('div', { class: 'log' })

  const side = el(
    'div',
    { class: 'side' },
    roomPanel,
    el(
      'div',
      { class: 'panel' },
      el('div', { class: 'panel-head' }, el('span', {}, '对局双方')),
      playersEl,
    ),
    el('div', { class: 'panel' }, el('div', { class: 'panel-head' }, el('span', {}, '操作')), actions),
    settingsPanel,
    shopPanel,
    el('div', { class: 'panel' }, el('div', { class: 'panel-head' }, el('span', {}, '落子记录')), logEl),
  )

  app.replaceChildren(el('div', { class: 'game' }, boardWrap, side))

  view = new BoardView(canvas)
  view.setGridSize(room.state.size)
  canvas.addEventListener('board:place', (ev) => {
    const index = (ev as CustomEvent<number>).detail
    tryPlace(index)
  })

  /* ---- derived state ---- */

  const myColor = (): Color | null => room.color

  /**
   * Single source of truth for "how did this game end". Resigning is folded in
   * here so every renderer (turn strip, overlay, buttons) agrees.
   */
  type Result =
    | { kind: 'playing' }
    | { kind: 'draw' }
    | { kind: 'win'; winner: Color; byResign: boolean }
  const result = (): Result => {
    if (room.state.resigned !== null) {
      return { kind: 'win', winner: room.state.resigned === 1 ? 2 : 1, byResign: true }
    }
    const o = lastPosition.outcome
    if (o.status === 'win') return { kind: 'win', winner: o.winner, byResign: false }
    if (o.status === 'draw') return { kind: 'draw' }
    return { kind: 'playing' }
  }
  const isOver = () => result().kind !== 'playing'

  const myUndosLeft = (): number => {
    const c = myColor()
    if (c === null) return 0
    return c === 1 ? room.state.undosLeft.black : room.state.undosLeft.white
  }

  const isMyTurn = (): boolean => {
    const c = myColor()
    if (c === null) return false
    return !isOver() && lastPosition.turn === c
  }

  /**
   * Undo availability. Each player may take back their OWN last move, up to the
   * per-game budget — allowed on your turn or after the game ended, which is the
   * ordinary friendly rule.
   */
  const canUndo = (): boolean => {
    const c = myColor()
    if (c === null) return false
    if (myUndosLeft() <= 0) return false
    return undoTarget(room.state.hist, room.state.size, c) !== null
  }

  function tryPlace(index: number) {
    if (isOver()) {
      toast('本局已结束')
      return
    }
    if (room.isSuperseded()) {
      toast('这个昵称已在另一台设备上继续对局')
      return
    }
    if (myColor() === null) {
      toast('等待对手加入')
      return
    }
    if (!isMyTurn()) {
      toast('还没轮到你')
      return
    }
    if (lastPosition.board[index] !== EMPTY) return
    room.play(index)
  }

  /* ---- renderers ---- */

  function onStatus(s: ConnStatus, detail?: string) {
    status = s
    statusDot.className = `dot ${s}`
    statusText.textContent =
      s === 'online' ? '已连接' : s === 'connecting' ? '连接中' : s === 'offline' ? '已断开' : '连接异常'
    if (s === 'error' && detail) console.warn('[mqtt]', detail)
    renderTurn()
  }

  function onState(state: GameState) {
    lastPosition = replay(state.hist, state.size)
    view?.setGridSize(state.size)
    view?.setPosition(lastPosition.board, winCells(), lastMoveIndex())
    // A hidden tab throttles requestAnimationFrame, so stones would sit half-drawn
    // until the tab came back. Repaint immediately in that case only, which keeps
    // the pop-in animation for the tab the player is actually looking at.
    view?.paintIfHidden()
    view?.invalidate()
    if (document.activeElement !== sizeSelect) sizeSelect.value = String(state.size)
    ensurePairing(state)
    claimMyRewards(state)
    syncPartner(state)
    renderTurn()
    renderPlayers()
    renderLog()
    renderOverlay()
    shop.render()
  }

  /**
   * Watch (and, on first meeting, create) the binding that ties this room to a
   * pair of players. The owner of the pairing is the room's creator.
   */
  function ensurePairing(state: GameState) {
    const creator = state.creator
    if (!creator) return

    if (!pairStore || !sameName(pairStore.owner, creator)) {
      pairStore?.dispose()
      pairStore = new PairStore(creator, {
        onPair: (p) => {
          pair = p
          // Bound partner exists and I am not the creator: play as them, on
          // whatever device and whatever nickname I typed.
          if (p?.partner && !sameName(creator, room.name)) {
            if (room.adoptPartnerIdentity(p.partner)) {
              toast(`已按绑定身份进入：${p.partner}`)
              rebindProfileIfNeeded()
            }
          }
          syncPartner(state)
          shop.render()
        },
        onStatus: () => {},
      })
      pairStore.connect()
      return
    }

    // Bound already, or a guest has shown up: create the binding if missing.
    if (!pairStore.pair) {
      const creatorIsMe = sameName(creator, myName())
      const guestSeat = [state.seats.black, state.seats.white].find(
        (s) => s && !sameName(s.name, creator),
      )
      if (!creatorIsMe && guestSeat) {
        // The guest is here; the owner's side may be absent, so the guest
        // records the pairing on the owner's behalf (first-write-wins).
        pairStore.bind(myName())
      } else if (creatorIsMe && guestSeat) {
        pairStore.bind(guestSeat.name)
      }
    }
  }

  /**
   * Pull every ledger entry addressed to me into my own profile. The store
   * dedupes by entry id, so replaying the same room state is harmless.
   */
  function claimMyRewards(state: GameState) {
    for (const r of state.rewards) {
      if (r.to === myName()) profileStore.claim(r.id, r.delta, r.reason)
    }
  }

  /**
   * Mirror the partner's profile so both balances and card bags are visible.
   *
   * The partner is resolved from the PAIRING, not from who happens to be seated:
   * an unpaired room's guest takes the partner role once and it sticks, so a
   * later visitor on a different device still plays as the same person.
   */
  function syncPartner(state: GameState) {
    const creator = state.creator
    if (!creator) return
    const me = myName().trim().toLowerCase()
    const creatorIsMe = creator.trim().toLowerCase() === me

    // Which name is "the other side" of this room?
    let partnerName: string | null = null
    if (pair && pair.partner) {
      partnerName = creatorIsMe ? pair.partner : creator
    } else {
      // Not bound yet: the guest in this room becomes the partner.
      const otherSeat = [state.seats.black, state.seats.white].find(
        (s) => s && s.name.trim().toLowerCase() !== creator.trim().toLowerCase(),
      )
      partnerName = creatorIsMe ? (otherSeat?.name ?? null) : creator
    }
    if (!partnerName) return
    if (partnerProfile?.name === partnerName && partnerStore) return

    partnerProfile = null
    partnerStore?.dispose()
    partnerStore = new ProfileStore(
      partnerName,
      (p) => {
        partnerProfile = p
        shop.render()
      },
      () => {},
    )
    partnerStore.connect()
  }

  function onPeers(list: PlayerInfo[]) {
    peers = list
    renderPlayers()
  }

  const winCells = () => (lastPosition.outcome.status === 'win' ? lastPosition.outcome.cells : [])

  /** The most recent placed move, skipping any illegal entries in history. */
  const lastMoveIndex = (): number | null => {
    for (let i = room.state.hist.length - 1; i >= 0; i--) {
      const cell = room.state.hist[i]
      if (lastPosition.board[cell] !== EMPTY) return cell
    }
    return null
  }

  function renderTurn() {
    const c = myColor()
    const r = result()
    view!.nextColor = r.kind === 'playing' ? lastPosition.turn : BLACK
    turnDot.className = `stone-dot ${(lastPosition.turn === BLACK ? 'black' : 'white')}`

    if (r.kind === 'win') {
      const mine = r.winner === c
      // Who resigned decides the wording: "you resigned" vs "opponent resigned".
      const iResigned = room.state.resigned !== null && room.state.resigned === c
      const detail = r.byResign ? (iResigned ? ' · 你认输了' : ' · 对手认输') : mine ? ' 干得漂亮' : ' 再来一局？'
      turnText.replaceChildren(
        el('strong', {}, mine ? '你赢了 🎉' : `${colorLabel(r.winner)}胜`),
        el('span', { class: 'dim' }, detail),
      )
      return
    }
    if (r.kind === 'draw') {
      turnText.replaceChildren(el('strong', {}, '平局'), el('span', { class: 'dim' }, ' 棋盘已满'))
      return
    }

    if (room.isSuperseded()) {
      turnText.replaceChildren(
        el('strong', {}, '已在其他设备继续'),
        el('span', { class: 'dim' }, ' · 这个窗口只读'),
      )
      return
    }

    if (status === 'offline') {
      turnText.replaceChildren(el('span', { class: 'dim' }, '连接中断，正在重连…'))
      return
    }

    if (c === null) {
      turnText.replaceChildren(
        el('strong', {}, `轮到${colorLabel(lastPosition.turn)}`),
        el('span', { class: 'dim' }, ' · 等待对手'),
      )
      return
    }

    if (isMyTurn()) {
      turnText.replaceChildren(
        el('strong', {}, '轮到你落子'),
        el('span', { class: 'dim' }, ` · ${colorLabel(c!)}`),
      )
    } else {
      turnText.replaceChildren(
        el('strong', {}, `等待对手 · ${colorLabel(lastPosition.turn)}回合`),
        el('span', { class: 'dim' }, ` · 你是${colorLabel(c!)}`),
      )
    }
  }

  function seatRow(color: Color): HTMLElement {
    const seat = color === BLACK ? room.state.seats.black : room.state.seats.white
    // Presence is matched by name so a player who switched devices still counts.
    const alive = peers.some(
      (p) => p.name.trim().toLowerCase() === (seat?.name ?? '').trim().toLowerCase(),
    )
    const isSelf = !!seat && seat.name.trim().toLowerCase() === myName().trim().toLowerCase()
    const isTurn = !isOver() && lastPosition.turn === color

    if (!seat || !alive) {
      return el(
        'div',
        { class: 'player-row empty' },
        el('div', { class: `stone-dot ${color === BLACK ? 'black' : 'white'}` }),
        el('div', { class: 'player-name' }, '等待加入…'),
        el('span', { class: 'tag' }, colorLabel(color)),
      )
    }

    return el(
      'div',
      { class: `player-row${isSelf ? ' self' : ''}` },
      el('div', { class: `stone-dot ${color === BLACK ? 'black' : 'white'}` }),
      el('div', { class: 'player-name' }, seat.name),
      isSelf ? el('span', { class: 'tag you' }, '你') : null,
      isTurn ? el('span', { class: 'tag turn' }, '落子中') : el('span', { class: 'tag' }, colorLabel(color)),
    )
  }

  function renderPlayers() {
    // Exactly two seats, no spectators: this is a two-player game.
    playersEl.replaceChildren(seatRow(BLACK), seatRow(WHITE))

    const left = myUndosLeft()
    undoBtn.disabled = !canUndo()
    undoBtn.textContent = myColor() === null ? '悔棋' : `悔棋 (${left})`
    resignBtn.disabled = myColor() === null || isOver()
    resetBtn.disabled = lastPosition.placed === 0 && !isOver()

    // Show the binding so both players know who belongs to this room.
    const creator = room.state.creator
    if (pair && creator) {
      const iAmOwner = sameName(creator, myName())
      const a = iAmOwner ? myName() : creator
      const b = iAmOwner ? pair.partner : myName()
      pairBadge.textContent = `已绑定：${a} ↔ ${b}`
      pairBadge.hidden = false
    } else {
      pairBadge.hidden = true
    }
  }

  function renderLog() {
    if (lastPosition.placed === 0) {
      logEl.replaceChildren()
      return
    }
    const size = lastPosition.size
    const rows: HTMLElement[] = []
    const total = Math.min(lastPosition.placed, 60)
    const start = Math.max(0, lastPosition.placed - total)
    for (let n = lastPosition.placed; n > start; n--) {
      const i = room.state.hist[lastPosition.landed[n - 1]]
      const color = colorOf(n - 1)
      const x = i % size
      const y = Math.floor(i / size)
      const coord = `${AXIS[x]}${size - y}`
      rows.push(
        el(
          'div',
          { class: `log-row${n === lastPosition.placed ? ' last' : ''}` },
          el('span', { class: 'n' }, String(n)),
          el('span', { class: 'c' }, colorLabel(color)),
          el('span', {}, coord),
        ),
      )
    }
    logEl.replaceChildren(...rows)
  }

  function renderOverlay() {
    const r = result()
    if (r.kind === 'playing') {
      overlay?.remove()
      overlay = null
      return
    }
    // Settle the win bonus once; `winPaid` in the room state makes it idempotent.
    if (r.kind === 'win' && !room.state.winPaid) room.settleWin(r.winner)
    if (overlay) return

    const c = myColor()
    const title =
      r.kind === 'draw'
        ? '平局'
        : r.winner === c
          ? '你赢了 🎉'
          : c === null
            ? `${colorLabel(r.winner)}胜`
            : '你输了'

    const iResigned = room.state.resigned !== null && room.state.resigned === c
    const sub =
      r.kind === 'win' && r.byResign
        ? iResigned
          ? '你已认输'
          : '对手认输'
        : '棋盘上已标出获胜连子'

    const again = el('button', { class: 'btn btn-primary', type: 'button' }, '再来一局') as HTMLButtonElement
    again.addEventListener('click', () => room.reset())

    const close = el('button', { class: 'btn btn-ghost', type: 'button' }, '看看棋盘') as HTMLButtonElement
    close.addEventListener('click', () => {
      overlay?.remove()
      overlay = null
    })

    overlay = el(
      'div',
      { class: 'overlay' },
      el(
        'div',
        { class: 'overlay-card' },
        el('h2', {}, title),
        el('p', {}, sub),
        el('div', { class: 'overlay-actions' }, again, close),
      ),
    )
    boardFrame.append(overlay)
  }

  /* ---- actions ---- */

  undoBtn.addEventListener('click', () => {
    const c = myColor()
    if (c === null || !canUndo()) return
    const target = undoTarget(room.state.hist, room.state.size, c)
    if (target === null) return
    room.undoTo(target, c)
    toast(`已悔棋，还剩 ${Math.max(0, myUndosLeft() - 1)} 次`)
  })

  resignBtn.addEventListener('click', () => {
    const c = myColor()
    if (c === null || isOver()) return
    if (!window.confirm('确认认输？本局判负。')) return
    room.resign(c)
  })

  resetBtn.addEventListener('click', () => {
    room.reset()
    toast('已重新开局')
  })

  settingsBtn.addEventListener('click', () => {
    settingsOpen = !settingsOpen
    settingsPanel.hidden = !settingsOpen
    settingsBtn.classList.toggle('active', settingsOpen)
  })

  shopBtn.addEventListener('click', () => {
    shopOpen = !shopOpen
    shopPanel.hidden = !shopOpen
    shopBtn.classList.toggle('active', shopOpen)
    if (shopOpen) shop.render()
  })

  leaveBtn.addEventListener('click', () => {
    room.dispose()
    location.hash = '#/'
  })

  lockBtn.addEventListener('click', () => {
    room.dispose()
    lock()
    render()
  })

  window.addEventListener('beforeunload', onUnload)

  /* ---- go ---- */

  room.connect()
  profileStore.connect()
  pair = null

  return {
    destroy() {
      window.removeEventListener('beforeunload', onUnload)
      view?.dispose()
      partnerStore?.dispose()
      pairStore?.dispose()
      profileStore.dispose()
      room.dispose()
      overlay?.remove()
    },
  }
}

/* ------------------------------------------------------------------ */
/* bootstrap                                                          */
/* ------------------------------------------------------------------ */

let current: GameView | DgView | null = null

function render() {
  current?.destroy()
  current = null

  // The gate comes first: no room is joined and no broker connection is opened
  // until the password has been accepted on this device.
  if (!isUnlocked()) {
    renderGate()
    return
  }

  const r = route()
  if (r.kind === 'lobby') {
    // A stale `#/d/...` invite falls through to the lobby now that the game is
    // switched off. Say so instead of silently landing on a different screen.
    if (!DRAWGUESS_ENABLED && /^#\/d\//.test(location.hash)) {
      toast('你画我猜暂时下线了')
    }
    renderLobby()
    return
  }

  // A room link carries no nickname (share links strip `?name=`), so ask for one
  // before joining instead of silently playing as "Player".
  if (!pendingName.trim()) {
    renderNameGate(r.code, r.kind === 'drawguess' ? 'd' : 'g')
    return
  }

  if (r.kind === 'drawguess') current = mountDrawGuess(r.code, pendingName)
  else current = mountGame(r.code)
}

window.addEventListener('hashchange', render)
render()

// Keep a couple of things reachable for quick manual checks in the console.
Object.assign(window as unknown as Record<string, unknown>, {
  __gomoku: { WHITE, replay, undoTarget },
})
