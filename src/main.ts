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
import { ShopPanel } from './shop'
import { Room, UNDOS_PER_PLAYER, type ConnStatus, type GameState, type PlayerInfo } from './sync'

const NAME_KEY = 'gomoku.name'

const app = document.getElementById('app')!

/* ------------------------------------------------------------------ */
/* routing                                                             */
/* ------------------------------------------------------------------ */

function route(): { kind: 'lobby' } | { kind: 'room'; code: string } {
  const hash = location.hash.replace(/^#/, '')
  const m = /^\/r\/([A-Za-z0-9-]+)/.exec(hash)
  if (m) {
    const code = normalizeRoom(m[1])
    if (code.length >= 4) return { kind: 'room', code }
  }
  return { kind: 'lobby' }
}

function gotoRoom(code: string) {
  location.hash = `#/r/${code}`
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  for (const c of children) if (c !== null && c !== false) node.append(c)
  return node
}

function toast(message: string) {
  let host = document.querySelector<HTMLDivElement>('.toast-host')
  if (!host) {
    host = el('div', { class: 'toast-host' })
    document.body.append(host)
  }
  const node = el('div', { class: 'toast' }, message)
  host.append(node)
  setTimeout(() => {
    node.classList.add('leaving')
    setTimeout(() => node.remove(), 220)
  }, 2000)
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard API needs a secure context; fall back to a temp textarea.
    try {
      const ta = el('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.append(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

const savedName = () => localStorage.getItem(NAME_KEY) ?? ''
const storeName = (v: string) => localStorage.setItem(NAME_KEY, v)

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
/* lobby                                                              */
/* ------------------------------------------------------------------ */

let pendingName = savedName()

function renderLobby() {
  const wrap = el('div', { class: 'lobby' })

  const brand = el(
    'div',
    { class: 'brand' },
    el('div', { class: 'brand-mark' }, el('i')),
    el(
      'div',
      {},
      el('h1', {}, '五子棋'),
      el('p', {}, '创建房间，把链接发给朋友，即可远程对战'),
    ),
  )

  const nameInput = el('input', {
    id: 'name',
    type: 'text',
    maxlength: '16',
    placeholder: '你的昵称',
    autocomplete: 'nickname',
  }) as HTMLInputElement
  nameInput.value = pendingName

  const createBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '创建新房间') as HTMLButtonElement

  const codeInput = el('input', {
    id: 'code',
    class: 'code',
    type: 'text',
    maxlength: '12',
    placeholder: 'ABC-DEF',
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement

  const joinBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '加入房间') as HTMLButtonElement

  const form = el(
    'div',
    { class: 'card' },
    el('div', { class: 'field' }, el('label', { for: 'name' }, '昵称'), nameInput),
    createBtn,
    el('div', { class: 'divider' }, '或者加入已有房间'),
    el('div', { class: 'field' }, el('label', { for: 'code' }, '房间码'), codeInput),
    joinBtn,
  )

  const commitName = () => {
    const v = nameInput.value.trim().slice(0, 16)
    pendingName = v
    storeName(v)
    return v
  }

  createBtn.addEventListener('click', () => {
    commitName()
    gotoRoom(randomRoomCode())
  })

  const join = () => {
    commitName()
    const code = normalizeRoom(codeInput.value)
    if (code.length < 4) {
      toast('请输入有效房间码')
      codeInput.focus()
      return
    }
    gotoRoom(code)
  }

  joinBtn.addEventListener('click', join)
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') join()
  })
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createBtn.click()
  })
  codeInput.addEventListener('input', () => {
    const pos = codeInput.selectionStart ?? 0
    codeInput.value = normalizeRoom(codeInput.value)
    codeInput.setSelectionRange(pos, pos)
  })

  wrap.append(brand, form, el('p', { class: 'footnote' }, '无需注册 · 无需服务器 · 纯静态页面直连'))
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
  const myName = pendingName || 'Player'
  const room = new Room(code, myName, {
    onStatus: (s, detail) => onStatus(s, detail),
    onState: (s) => onState(s),
    onPeers: (p) => onPeers(p),
  })

  let lastPosition: Replay = replay([], room.state.size)
  let view: BoardView | null = null
  let status: ConnStatus = 'connecting'
  let peers: PlayerInfo[] = room.activePeers()
  let overlay: HTMLDivElement | null = null
  let settingsOpen = false
  let shopOpen = false
  let partnerStore: ProfileStore | null = null
  let partnerProfile: Profile | null = null

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

  const roomPanel = el(
    'div',
    { class: 'panel' },
    el('div', { class: 'panel-head' }, el('span', {}, '房间'), statusEl),
    roomCodeEl,
    el(
      'div',
      { class: 'share' },
      (() => {
        const input = el('input', { readonly: 'readonly' }) as HTMLInputElement
        input.value = shareUrl(code)
        input.addEventListener('focus', () => input.select())
        return input
      })(),
      (() => {
        const btn = el('button', { class: 'btn btn-ghost', type: 'button' }, '复制') as HTMLButtonElement
        btn.addEventListener('click', async () => {
          const ok = await copyText(shareUrl(code))
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
  const profileStore = new ProfileStore(
    myName,
    () => {
      shop.render()
      renderTurn()
    },
    () => {
      /* profile connection status is not surfaced; the room's status covers it */
    },
  )

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
    if (myColor() === null) {
      toast('你是观战者，无法落子')
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
    view?.invalidate()
    if (document.activeElement !== sizeSelect) sizeSelect.value = String(state.size)
    claimMyRewards(state)
    syncPartner(state)
    renderTurn()
    renderPlayers()
    renderLog()
    renderOverlay()
    shop.render()
  }

  /**
   * Pull every ledger entry addressed to me into my own profile. The store
   * dedupes by entry id, so replaying the same room state is harmless.
   */
  function claimMyRewards(state: GameState) {
    for (const r of state.rewards) {
      if (r.to === myName) profileStore.claim(r.id, r.delta, r.reason)
    }
  }

  /** Mirror the partner's profile so both balances are visible in the shop. */
  function syncPartner(state: GameState) {
    const opponent = state.resigned === null ? null : null
    void opponent
    const seat =
      room.state.seats.black?.clientId === room.clientId
        ? room.state.seats.white
        : room.state.seats.black
    const name = seat?.name
    if (!name || name === myName) return
    if (partnerProfile?.name === name && partnerStore) return

    partnerProfile = null
    partnerStore?.dispose()
    partnerStore = new ProfileStore(
      name,
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

    if (c === null) {
      turnText.replaceChildren(
        el('strong', {}, `轮到${colorLabel(lastPosition.turn)}`),
        el('span', { class: 'dim' }, ' · 观战中'),
      )
      return
    }

    if (status === 'offline') {
      turnText.replaceChildren(el('span', { class: 'dim' }, '连接中断，正在重连…'))
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
    const alive = peers.some((p) => p.clientId === seat?.clientId)
    const isSelf = seat?.clientId === room.clientId
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
    const spectators = peers.filter((p) => p.color === null)
    const rows = [seatRow(BLACK), seatRow(WHITE)]
    for (const sp of spectators) {
      if (sp.clientId === room.clientId && myColor() !== null) continue
      rows.push(
        el(
          'div',
          { class: `player-row${sp.clientId === room.clientId ? ' self' : ''}` },
          el('div', { class: 'stone-dot', style: 'opacity:0' }),
          el('div', { class: 'player-name' }, sp.name || '观战者'),
          el('span', { class: 'tag' }, '观战'),
        ),
      )
    }
    playersEl.replaceChildren(...rows)

    const left = myUndosLeft()
    undoBtn.disabled = !canUndo()
    undoBtn.textContent = myColor() === null ? '悔棋' : `悔棋 (${left})`
    resignBtn.disabled = myColor() === null || isOver()
    resetBtn.disabled = lastPosition.placed === 0 && !isOver()
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

  return {
    destroy() {
      window.removeEventListener('beforeunload', onUnload)
      view?.dispose()
      partnerStore?.dispose()
      profileStore.dispose()
      room.dispose()
      overlay?.remove()
    },
  }
}

function shareUrl(code: string): string {
  const base = location.href.split('#')[0]
  return `${base}#/r/${code}`
}

/* ------------------------------------------------------------------ */
/* bootstrap                                                          */
/* ------------------------------------------------------------------ */

let current: GameView | null = null

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
  if (r.kind === 'lobby') renderLobby()
  else current = mountGame(r.code)
}

window.addEventListener('hashchange', render)
render()

// Keep a couple of things reachable for quick manual checks in the console.
Object.assign(window as unknown as Record<string, unknown>, {
  __gomoku: { WHITE, replay, undoTarget },
})
