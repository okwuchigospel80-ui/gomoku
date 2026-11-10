// 你画我猜 — the screen.
//
// Split from `main.ts` because the two games share a lobby and nothing else. The
// room transport lives in `dgsync.ts`, the rules and pure maths in `drawguess.ts`,
// the canvas in `drawview.ts`; this file is the wiring and the DOM.
//
// The privacy rule shows up here in one place: only the drawer ever resolves a
// word (`pickWord`). The guesser's view is built from `wordLen`/`level` alone.

import {
  ADVANCE_MS,
  DRAWER_POINTS,
  FAST_BONUS,
  FAST_MS,
  GUESS_POINTS,
  MAX_STROKES,
  ROUND_MS,
  awardsFor,
  findMySeat,
  isGameOver,
  isRoundActive,
  matchesAnswer,
  other,
  pickWord,
  remainingMs,
  type DgState,
  type Guess,
  type Seat,
} from './drawguess.ts'
import { DgRoom, type ConnStatus, type Peer, type Secret } from './dgsync.ts'
import { DrawCanvas } from './drawview.ts'
import { LEVEL_LABEL, charLength } from './words.ts'
import { ProfileStore, type Profile } from './profile.ts'
import { PairStore, sameName, type Pair } from './pairing.ts'
import { ShopPanel } from './shop.ts'
import { copyText, el, shareUrl, toast } from './dom.ts'

export interface DgView {
  destroy(): void
}

const seatLabel = (seat: Seat) => (seat === 1 ? '甲位' : '乙位')

export function mountDrawGuess(code: string, name: string): DgView {
  const app = document.getElementById('app')!
  const room = new DgRoom(code, name, {
    onStatus: (s, detail) => onStatus(s, detail),
    onState: (s) => onState(s),
    onPeers: (p) => onPeers(p),
    onSecret: (s) => onSecret(s),
  })

  /** Identity may change when a bound partner is adopted. */
  const myName = (): string => room.name
  const mySeat = (): Seat | null => room.seat

  let peers: Peer[] = room.activePeers()
  let shopOpen = false
  let settingsOpen = false
  let partnerStore: ProfileStore | null = null
  let partnerProfile: Profile | null = null
  let pair: Pair | null = null
  let pairStore: PairStore | null = null

  /** The secret word this client is drawing. Held in memory ONLY. */
  let word: string | null = null
  /** Round the current `word` belongs to; guards against a stale reload race. */
  let wordRound = 0
  /** Last state we rendered, so the timer tick can read it without a closure. */
  let snapshot: DgState = room.state
  /** Pending auto-advance timer after a round result. */
  let advanceTimer: ReturnType<typeof setTimeout> | null = null
  /** Guess timestamps we have already judged (avoids re-publishing). */
  const judged = new Set<number>()
  /** Round we have already armed locally; stops the clock being restarted. */
  let armedRound = 0

  /* ------------------------------------------------------------------ */
  /* DOM                                                                 */
  /* ------------------------------------------------------------------ */

  const canvas = el('canvas', { class: 'dg-canvas' }) as HTMLCanvasElement
  const canvasFrame = el('div', { class: 'dg-frame' }, canvas)

  const roundChip = el('span', { class: 'dg-chip' }, '准备中')
  const timerChip = el('span', { class: 'dg-chip dg-timer' }, '90')
  const roleChip = el('span', { class: 'dg-chip dg-role' }, '')
  const turnStrip = el('div', { class: 'turn-strip dg-strip' }, roundChip, timerChip, roleChip)

  const boardWrap = el('div', { class: 'board-wrap dg-wrap' }, canvasFrame, turnStrip)

  const roomCodeEl = el('div', { class: 'room-code' }, `DG-${code.slice(0, 3)}-${code.slice(3)}`)
  const statusDot = el('i', { class: 'dot connecting' })
  const statusText = el('span', {}, '连接中')
  const statusEl = el('span', { class: 'status' }, statusDot, statusText)

  const pairBadge = el('div', { class: 'pair-badge' })
  pairBadge.hidden = true

  const shareInput = el('input', { readonly: 'readonly' }) as HTMLInputElement
  shareInput.value = shareUrl(code, 'd')
  shareInput.addEventListener('focus', () => shareInput.select())
  const copyBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '复制') as HTMLButtonElement
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(shareUrl(code, 'd'))
    toast(ok ? '链接已复制，发给对方吧' : '复制失败，请手动选中链接')
  })

  const roomPanel = el(
    'div',
    { class: 'panel' },
    el('div', { class: 'panel-head' }, el('span', {}, '房间'), statusEl),
    roomCodeEl,
    pairBadge,
    el('div', { class: 'share' }, shareInput, copyBtn),
  )

  const playersEl = el('div', { class: 'players' })

  /* ---- word / status panel ---- */

  const wordHintEl = el('div', { class: 'dg-word-hint' })
  const wordSlotsEl = el('div', { class: 'dg-slots' })
  const actionRow = el('div', { class: 'dg-actions' })
  const promptEl = el('p', { class: 'hint dg-prompt' }, '')

  const wordPanel = el(
    'div',
    { class: 'panel dg-word-panel' },
    el('div', { class: 'panel-head' }, el('span', {}, '本回合')),
    wordHintEl,
    wordSlotsEl,
    promptEl,
    actionRow,
  )

  /* ---- guesser input ---- */

  const guessingInput = el('input', {
    type: 'text',
    maxlength: '20',
    placeholder: '输入你的答案，回车提交',
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement
  const guessingBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '猜') as HTMLButtonElement
  const guessingPanel = el(
    'div',
    { class: 'panel dg-guess-panel' },
    el('div', { class: 'panel-head' }, el('span', {}, '猜一猜')),
    el('div', { class: 'dg-guess-row' }, guessingInput, guessingBtn),
    el('p', { class: 'hint' }, `猜对 ${GUESS_POINTS} 分；剩 ${Math.round(FAST_MS / 1000)} 秒以上再 +${FAST_BONUS}。`),
  )
  guessingPanel.hidden = true

  /* ---- guesses log ---- */

  const guessLog = el('div', { class: 'dg-log' })
  const guessPanel = el(
    'div',
    { class: 'panel' },
    el('div', { class: 'panel-head' }, el('span', {}, '猜测记录')),
    guessLog,
  )

  /* ---- scoreboard ---- */

  const scoreEl = el('div', { class: 'dg-scoreboard' })
  const scorePanel = el(
    'div',
    { class: 'panel' },
    el('div', { class: 'panel-head' }, el('span', {}, '得分')),
    scoreEl,
  )

  /* ---- settings ---- */

  const roundsSelect = el('select', { class: 'size-select' }) as HTMLSelectElement
  for (const n of [3, 5, 7, 9]) {
    roundsSelect.append(el('option', { value: String(n) }, `${n} 回合`) as HTMLOptionElement)
  }
  roundsSelect.addEventListener('change', () => {
    const next = Number(roundsSelect.value)
    if (room.state.round > 1 || room.state.scores.length > 0) {
      toast('游戏进行中不能改回合数，请先重新开始')
      roundsSelect.value = String(room.state.totalRounds)
      return
    }
    room.setTotalRounds(next)
    toast(`已设为 ${next} 回合`)
  })

  const settingsPanel = el(
    'div',
    { class: 'panel settings-panel' },
    el('div', { class: 'panel-head' }, el('span', {}, '设置')),
    el('div', { class: 'settings-body' }, el('div', { class: 'field' }, el('label', {}, '总回合数'), roundsSelect)),
    el(
      'p',
      { class: 'hint' },
      `每回合 ${Math.round(ROUND_MS / 1000)} 秒。猜对：猜的人 ${GUESS_POINTS} 分、画手 ${DRAWER_POINTS} 分；剩 ${Math.round(FAST_MS / 1000)} 秒以上猜对再 +${FAST_BONUS}。超时双方 0 分。`,
    ),
  )
  settingsPanel.hidden = true

  /* ---- profile + shop (shared account with gomoku) ---- */

  let profileStore: ProfileStore = makeProfileStore(myName())

  function makeProfileStore(n: string): ProfileStore {
    return new ProfileStore(
      n,
      () => {
        shop.render()
      },
      () => {},
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
      const ok = profileStore.use(card)
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

  /* ---- actions ---- */

  const startBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '开始新游戏') as HTMLButtonElement
  const againBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '再来一局') as HTMLButtonElement
  const clearBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '清空') as HTMLButtonElement
  const settingsBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '设置') as HTMLButtonElement
  const shopBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '商店') as HTMLButtonElement
  const leaveBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '离开') as HTMLButtonElement

  const actions = el(
    'div',
    { class: 'actions' },
    startBtn,
    againBtn,
    clearBtn,
    settingsBtn,
    shopBtn,
    leaveBtn,
  )

  const side = el(
    'div',
    { class: 'side' },
    roomPanel,
    wordPanel,
    guessingPanel,
    el('div', { class: 'panel' }, el('div', { class: 'panel-head' }, el('span', {}, '对局双方')), playersEl),
    scorePanel,
    guessPanel,
    el('div', { class: 'panel' }, el('div', { class: 'panel-head' }, el('span', {}, '操作')), actions),
    settingsPanel,
    shopPanel,
  )

  const overlayHost = el('div', { class: 'dg-overlay-host' })
  app.replaceChildren(el('div', { class: 'game dg-game' }, boardWrap, side), overlayHost)

  const view = new DrawCanvas(canvas, {
    onStroke: (pts, w) => onLocalStroke(pts, w),
  })
  view.setEnabled(false)

  /* ------------------------------------------------------------------ */
  /* derived state                                                       */
  /* ------------------------------------------------------------------ */

  const iAmDrawer = (): boolean => {
    const seat = mySeat()
    return seat !== null && snapshot.drawer === seat
  }

  const over = (): boolean => isGameOver(snapshot)

  /* ------------------------------------------------------------------ */
  /* network handlers                                                    */
  /* ------------------------------------------------------------------ */

  function onStatus(s: ConnStatus, detail?: string) {
    statusDot.className = `dot ${s}`
    statusText.textContent =
      s === 'online' ? '已连接' : s === 'connecting' ? '连接中' : s === 'offline' ? '已断开' : '连接异常'
    if (s === 'error' && detail) console.warn('[mqtt]', detail)
    renderAll()
  }
  function onPeers(list: Peer[]) {
    peers = list
    renderPlayers()
    renderWordPanel()
  }

  function onSecret(secret: Secret | null) {
    // Only a drawer has a secret. If the retained message is for another round,
    // ignore it — a fresh word will be published when that round starts.
    if (!secret) return
    if (secret.round !== room.state.round) return
    if (!iAmDrawer()) return
    if (word && wordRound === secret.round) return
    word = secret.text
    wordRound = secret.round
    renderWordPanel()
  }

  function onState(state: DgState) {
    const prevRound = snapshot.round
    const prevResult = snapshot.roundResult
    snapshot = state

    ensurePairing(state)
    claimMyAwards(state)
    syncPartner()
    syncSecretForRound(state)
    reconcileJudged(state)

    view.sync(state.strokes)
    view.setEnabled(iAmDrawer() && isRoundActive(state) && !room.isSuperseded())

    if (document.activeElement !== roundsSelect) roundsSelect.value = String(state.totalRounds)

    // A round just closed: schedule the advance on both sides.
    if (state.roundResult && !prevResult) {
      scheduleAdvance(state)
      toast(resultToast(state))
      // Drop the retained copy of our word as soon as it stops being needed.
      if (iAmDrawer()) room.publishSecret(null)
    }
    // A new round began.
    if (state.round !== prevRound) {
      clearAdvanceTimer()
      word = null
      wordRound = 0
      judged.clear()
      armedRound = 0
      if (iAmDrawer()) ensureWordForRound(state)
    }

    renderAll()
  }

  /**
   * The drawer resolves its word. On a reload the retained secret may already
   * carry it; otherwise the deterministic picker produces the same word the
   * previous session was drawing, so a refresh never changes the answer.
   */
  function syncSecretForRound(state: DgState) {
    if (!iAmDrawer() || state.roundResult || isGameOver(state)) return
    if (word && wordRound === state.round && charLength(word) === state.wordLen) return
    if (!state.wordLen) return
    const remembered = room.secretFor(state.round)
    if (remembered && charLength(remembered) === state.wordLen) {
      word = remembered
      wordRound = state.round
      return
    }
    // The shared state says a word exists but this client has none: rebuild it
    // from the same deterministic seed the original drawer used.
    const picked = pickWord(code, state.round)
    word = picked.text
    wordRound = state.round
    room.publishSecret({ round: state.round, text: picked.text, level: picked.level })
  }

  /**
   * Drawer-side: publish the word length (never the word) and start the clock.
   * Only runs once the game is actually started, so the waiting screen does not
   * burn the first round's 90 seconds.
   */
  function ensureWordForRound(state: DgState) {
    if (!iAmDrawer() || isGameOver(state)) return
    if (state.startedAt <= 0) return
    if (state.roundResult) return
    if (state.wordLen > 0 && state.roundStart > 0) return
    if (armedRound === state.round) return
    armedRound = state.round
    const picked = pickWord(code, state.round)
    word = picked.text
    wordRound = state.round
    room.publishSecret({ round: state.round, text: picked.text, level: picked.level })
    room.publishWord(charLength(picked.text), picked.level)
  }

  /** Calls the arm step from the render loop; guarded, so it is cheap. */
  function armRoundIfDrawer() {
    if (!iAmDrawer()) return
    ensureWordForRound(snapshot)
  }

  /** Drawer-side: judge every newly appended guess exactly once. */
  function reconcileJudged(state: DgState) {
    if (!iAmDrawer() || !word || state.roundResult || !isRoundActive(state)) return
    const mine = mySeat()
    if (mine === null) return
    for (const g of state.guesses) {
      if (g.by === mine) continue
      if (judged.has(g.at)) continue
      judged.add(g.at)
      if (matchesAnswer(g.text, word)) {
        room.finish({ kind: 'guessed', by: other(mine), at: g.at })
        toast(`猜对了：${g.text}`)
        return
      }
      room.markWrong(g.at)
    }
  }

  /** Anyone may close a round that ran out of time; `finish` is idempotent. */
  function checkTimeout(state: DgState) {
    if (state.roundResult || isGameOver(state)) return
    if (state.roundStart <= 0) return
    if (remainingMs(state) > 0) return
    room.finish({ kind: 'timeout', at: state.roundStart + ROUND_MS })
  }

  function scheduleAdvance(state: DgState) {
    clearAdvanceTimer()
    const delay = Math.max(0, state.roundResult ? state.roundResult.at + ADVANCE_MS - Date.now() : ADVANCE_MS)
    advanceTimer = setTimeout(() => {
      advanceTimer = null
      if (!room.state.roundResult) return
      room.advance()
    }, Math.min(ADVANCE_MS, Math.max(600, delay)))
  }

  function clearAdvanceTimer() {
    if (advanceTimer) clearTimeout(advanceTimer)
    advanceTimer = null
  }

  /* ------------------------------------------------------------------ */
  /* profile linkage                                                     */
  /* ------------------------------------------------------------------ */

  function ensurePairing(state: DgState) {
    const creator = state.creator
    if (!creator) return

    if (!pairStore || !sameName(pairStore.owner, creator)) {
      pairStore?.dispose()
      pairStore = new PairStore(creator, {
        onPair: (p) => {
          pair = p
          if (p?.partner && !sameName(creator, room.name)) {
            if (room.adoptPartnerIdentity(p.partner)) {
              toast(`已按绑定身份进入：${p.partner}`)
              rebindProfileIfNeeded()
            }
          }
          syncPartner()
          shop.render()
        },
        onStatus: () => {},
      })
      pairStore.connect()
    }

    if (pairStore.pair) return
    const creatorIsMe = sameName(creator, myName())
    const guest = ([1, 2] as const).map((s) => state.seats[s]).find((x) => x && !sameName(x.name, creator))
    if (!creatorIsMe && guest) pairStore.bind(myName())
    else if (creatorIsMe && guest) pairStore.bind(guest.name)
  }

  /** Pull this game's awards into my own profile. Idempotent by award id. */
  function claimMyAwards(state: DgState) {
    const mine = findMySeat(state, myName())
    if (!mine) return
    for (const award of awardsFor(state)) {
      if (award.seat !== mine.seat) continue
      profileStore.claim(award.id, award.delta, award.reason)
    }
  }

  function syncPartner() {
    const creator = snapshot.creator
    if (!creator) return
    const creatorIsMe = sameName(creator, myName())
    let partnerName: string | null = null
    if (pair?.partner) partnerName = creatorIsMe ? pair.partner : creator
    else {
      const otherSeat = ([1, 2] as const)
        .map((s) => snapshot.seats[s])
        .find((x) => x && !sameName(x.name, creator))
      partnerName = creatorIsMe ? (otherSeat?.name ?? null) : creator
    }
    if (!partnerName || partnerProfile?.name === partnerName) return
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

  /* ------------------------------------------------------------------ */
  /* rendering                                                           */
  /* ------------------------------------------------------------------ */

  function renderAll() {
    armRoundIfDrawer()
    syncSecretForRound(snapshot)
    renderWordPanel()
    renderPlayers()
    renderScore()
    renderGuesses()
    renderOverlay()
    renderActions()
    renderStrip()
    view.setEnabled(iAmDrawer() && isRoundActive(snapshot) && !room.isSuperseded())
  }

  function renderStrip() {
    roundChip.textContent = over() ? '已结束' : `第 ${snapshot.round} / ${snapshot.totalRounds} 回合`
    roleChip.textContent =
      mySeat() === null ? '旁观' : iAmDrawer() ? '你是画手' : '你是猜的人'
    roleChip.classList.toggle('dg-role-drawer', iAmDrawer())
    timerChip.textContent = formatClock()
  }

  function formatClock(): string {
    if (over()) return '—'
    if (snapshot.roundResult) return '本回合结束'
    if (snapshot.roundStart <= 0) return `${Math.round(ROUND_MS / 1000)}`
    const ms = remainingMs(snapshot)
    const s = Math.ceil(ms / 1000)
    return ms > 0 ? `${s}s` : '0s'
  }

  function renderWordPanel() {
    const mine = mySeat()
    const drawing = iAmDrawer()
    const active = isRoundActive(snapshot)

    if (over()) {
      wordHintEl.textContent = '整局结束'
      wordHintEl.className = 'dg-word-hint done'
      wordSlotsEl.replaceChildren()
      promptEl.textContent = '结算见下方，或开一局新的。'
      guessingPanel.hidden = true
      return
    }

    if (mine === null) {
      wordHintEl.textContent = '等待入座'
      wordSlotsEl.replaceChildren()
      promptEl.textContent = '房间已满，或对局尚未开始。'
      guessingPanel.hidden = true
      return
    }

    if (drawing) {
      wordHintEl.className = 'dg-word-hint drawer'
      if (word) {
        wordHintEl.replaceChildren(
          el('span', { class: 'dg-word' }, word),
          el('span', { class: 'dg-word-meta' }, `${LEVEL_LABEL[snapshot.level]} · 你来画`),
        )
        promptEl.textContent = '只画不写；这个字只有你能看到。'
      } else {
        wordHintEl.textContent = '正在抽词…'
        promptEl.textContent = '稍等一下，词马上就来。'
      }
      wordSlotsEl.replaceChildren()
      guessingPanel.hidden = true
      return
    }

    // Guesser view: length + level only. The word is never resolved here.
    wordHintEl.className = 'dg-word-hint'
    const len = snapshot.wordLen
    wordHintEl.replaceChildren(
      el('span', { class: 'dg-word' }, len > 0 ? `${len} 个字` : '等待出题'),
      el('span', { class: 'dg-word-meta' }, len > 0 ? LEVEL_LABEL[snapshot.level] : ''),
    )
    wordSlotsEl.replaceChildren(...Array.from({ length: len }, () => el('span', { class: 'dg-slot' })))
    guessingPanel.hidden = !active
    promptEl.textContent = active
      ? `画手正在画 · 剩 ${Math.ceil(remainingMs(snapshot) / 1000)} 秒`
      : snapshot.roundResult
        ? '本回合已结束，马上进入下一回合'
        : '等待画手出题…'

    const seat = mySeat()
    const canGuess = active && seat !== null
    guessingInput.disabled = !canGuess
    guessingBtn.disabled = !canGuess
  }

  function renderPlayers() {
    const rows: HTMLElement[] = []
    for (const seat of [1, 2] as const) {
      const info = snapshot.seats[seat]
      const isSelf = !!info && sameName(info.name, myName())
      const alive = peers.some((p) => p.seat === seat)
      const drawing = snapshot.drawer === seat && !over()

      if (!info || (!alive && !isSelf)) {
        rows.push(
          el(
            'div',
            { class: 'player-row empty' },
            el('div', { class: 'stone-dot black' }),
            el('div', { class: 'player-name' }, '等待加入…'),
            el('span', { class: 'tag' }, seatLabel(seat)),
          ),
        )
        continue
      }

      rows.push(
        el(
          'div',
          { class: `player-row${isSelf ? ' self' : ''}` },
          el('div', { class: `stone-dot ${seat === 1 ? 'black' : 'white'}` }),
          el('div', { class: 'player-name' }, info.name),
          isSelf ? el('span', { class: 'tag you' }, '你') : null,
          drawing ? el('span', { class: 'tag turn' }, '画手中') : el('span', { class: 'tag' }, seatLabel(seat)),
        ),
      )
    }
    playersEl.replaceChildren(...rows)

    const creator = snapshot.creator
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

  function renderScore() {
    const rows: HTMLElement[] = []
    const total1 = snapshot.scores.reduce((n, s) => n + s.points[1], 0)
    const total2 = snapshot.scores.reduce((n, s) => n + s.points[2], 0)
    for (const seat of [1, 2] as const) {
      const name = snapshot.seats[seat]?.name ?? '—'
      const total = seat === 1 ? total1 : total2
      const isSelf = sameName(name, myName())
      rows.push(
        el(
          'div',
          { class: `dg-score-row${isSelf ? ' self' : ''}` },
          el('span', { class: `stone-dot ${seat === 1 ? 'black' : 'white'}` }),
          el('span', { class: 'dg-score-name' }, name),
          el('span', { class: 'dg-score-total' }, String(total)),
        ),
      )
    }
    // Per-round breakdown, newest first.
    const history = [...snapshot.scores].reverse().map((sc) =>
      el(
        'div',
        { class: 'dg-round-row' },
        el('span', { class: 'n' }, `R${sc.round}`),
        el('span', { class: 'c' }, `${seatLabel(sc.drawer)} 画`),
        el(
          'span',
          { class: 'dg-round-pts' },
          `${sc.points[1]} : ${sc.points[2]}`,
        ),
      ),
    )
    scoreEl.replaceChildren(...rows, ...history)
  }

  function renderGuesses() {
    const list: Guess[] = snapshot.guesses
    if (list.length === 0) {
      guessLog.replaceChildren(el('div', { class: 'shop-empty' }, '还没有人猜过'))
      return
    }
    const rows = list
      .slice(-12)
      .reverse()
      .map((g) => {
        const wrong = snapshot.wrong.includes(g.at)
        return el(
          'div',
          { class: `dg-guess-log-row${wrong ? ' wrong' : ''}` },
          el('span', { class: 'dg-guess-log-name' }, snapshot.seats[g.by]?.name ?? seatLabel(g.by)),
          el('span', { class: 'dg-guess-log-text' }, g.text),
          el('span', { class: 'dg-guess-log-mark' }, wrong ? '✕' : ''),
        )
      })
    guessLog.replaceChildren(...rows)
  }

  function resultToast(state: DgState): string {
    if (!state.roundResult) return ''
    if (state.roundResult.kind === 'timeout') return '时间到，本回合无人得分'
    return `猜对了！${snapshot.seats[state.roundResult.by]?.name ?? ''} 猜出答案`
  }

  function renderActions() {
    const seatsFilled = snapshot.seats[1] !== null && snapshot.seats[2] !== null
    const notStarted = snapshot.startedAt === 0
    startBtn.hidden = !notStarted
    startBtn.disabled = !seatsFilled || mySeat() === null
    startBtn.textContent = seatsFilled ? '开始新游戏' : '等待对手加入'

    againBtn.hidden = !over()
    clearBtn.hidden = over() || !iAmDrawer() || !isRoundActive(snapshot)
    clearBtn.disabled = !iAmDrawer() || !isRoundActive(snapshot)
    settingsBtn.classList.toggle('active', settingsOpen)
    shopBtn.classList.toggle('active', shopOpen)
  }

  function renderOverlay() {
    overlayHost.replaceChildren()
    if (!over()) return
    const mine = mySeat()
    const t1 = snapshot.scores.reduce((n, s) => n + s.points[1], 0)
    const t2 = snapshot.scores.reduce((n, s) => n + s.points[2], 0)
    const mineTotal = mine === 1 ? t1 : mine === 2 ? t2 : null
    const theirTotal = mine === 1 ? t2 : mine === 2 ? t1 : null

    const title =
      mineTotal === null
        ? '对局结束'
        : theirTotal === null
          ? '对局结束'
          : mineTotal > theirTotal
            ? '你们赢了 🎉'
            : mineTotal < theirTotal
              ? '这局输了一点'
              : '打平了'

    const again = el('button', { class: 'btn btn-primary', type: 'button' }, '再来一局') as HTMLButtonElement
    again.addEventListener('click', () => startNewGame())
    const close = el('button', { class: 'btn btn-ghost', type: 'button' }, '看看画') as HTMLButtonElement
    close.addEventListener('click', () => overlayHost.replaceChildren())

    const overlay = el(
      'div',
      { class: 'overlay dg-overlay' },
      el(
        'div',
        { class: 'overlay-card' },
        el('h2', {}, title),
        el('p', {}, `${t1} : ${t2} · 共 ${snapshot.scores.length} 回合`),
        el('div', { class: 'overlay-actions' }, again, close),
      ),
    )
    overlayHost.append(overlay)
  }

  /* ------------------------------------------------------------------ */
  /* local actions                                                       */
  /* ------------------------------------------------------------------ */

  function onLocalStroke(pts: number[], w: number) {
    if (!iAmDrawer()) return
    if (!isRoundActive(snapshot)) return
    if (snapshot.strokes.length >= MAX_STROKES) {
      toast(`本回合笔数已达 ${MAX_STROKES}，请清空后继续`)
      return
    }
    room.appendStroke(pts, w)
  }

  function submitGuess() {
    const seat = mySeat()
    const text = guessingInput.value.trim()
    if (seat === null || !text) return
    if (!isRoundActive(snapshot)) {
      toast('本回合已经结束')
      return
    }
    const at = Date.now()
    room.appendGuess(seat, text, at)
    guessingInput.value = ''
  }

  function startNewGame() {
    if (snapshot.seats[1] === null || snapshot.seats[2] === null) {
      toast('需要两个人才能开始')
      return
    }
    room.startGame(snapshot.totalRounds, 1)
    word = null
    wordRound = 0
    armedRound = 0
    judged.clear()
    toast('新游戏开始，甲位先画')
  }

  startBtn.addEventListener('click', startNewGame)
  againBtn.addEventListener('click', startNewGame)
  guessingBtn.addEventListener('click', submitGuess)
  guessingInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitGuess()
  })
  clearBtn.addEventListener('click', () => {
    if (!iAmDrawer()) return
    if (!window.confirm('清空整张画布？')) return
    room.setStrokes([])
    view.clearLocal()
  })
  settingsBtn.addEventListener('click', () => {
    settingsOpen = !settingsOpen
    settingsPanel.hidden = !settingsOpen
    renderActions()
  })
  shopBtn.addEventListener('click', () => {
    shopOpen = !shopOpen
    shopPanel.hidden = !shopOpen
    shop.render()
    renderActions()
  })
  leaveBtn.addEventListener('click', () => {
    room.dispose()
    location.hash = '#/'
  })

  /* ------------------------------------------------------------------ */
  /* clock                                                               */
  /* ------------------------------------------------------------------ */

  const tick = setInterval(() => {
    timerChip.textContent = formatClock()
    // Close the round once the clock is gone. `isRoundActive` turns false at
    // exactly that moment, so it must NOT gate this check — doing so meant the
    // timeout branch could never run and rounds would hang forever. `finish` is
    // idempotent, so both sides may race it every second.
    if (!snapshot.roundResult && remainingMs(snapshot) <= 0) checkTimeout(snapshot)
    if (snapshot.roundResult && !advanceTimer) scheduleAdvance(snapshot)
    if (iAmDrawer()) renderStrip()
  }, 1000)

  /* ------------------------------------------------------------------ */
  /* go                                                                  */
  /* ------------------------------------------------------------------ */

  room.connect()
  profileStore.connect()

  // Console handle for manual checks, mirroring `__gomoku` in main.ts.
  Object.assign(window as unknown as Record<string, unknown>, {
    __dg: {
      state: () => snapshot,
      room,
      canvas: view,
      me: () => ({ name: myName(), seat: mySeat(), drawer: iAmDrawer(), superseded: room.isSuperseded() }),
    },
  })

  const onUnload = () => {
    room.dispose()
  }
  window.addEventListener('beforeunload', onUnload)

  return {
    destroy() {
      clearInterval(tick)
      clearAdvanceTimer()
      window.removeEventListener('beforeunload', onUnload)
      view.dispose()
      partnerStore?.dispose()
      pairStore?.dispose()
      profileStore.dispose()
      room.dispose()
    },
  }
}
