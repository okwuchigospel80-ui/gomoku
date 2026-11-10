// Small DOM helpers shared by the lobby and both games.
//
// These lived inside `main.ts`; the draw-guess screen needs the same toast, the
// same clipboard fallback and the same `?name=` rule, so they moved here rather
// than being copied a second time.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  for (const c of children) if (c !== null && c !== false) node.append(c)
  return node
}

export function toast(message: string) {
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

export async function copyText(text: string): Promise<boolean> {
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

const NAME_KEY = 'gomoku.name'

export const savedName = () => localStorage.getItem(NAME_KEY) ?? ''
export const storeName = (v: string) => localStorage.setItem(NAME_KEY, v)

/**
 * A `?name=` in the URL wins over the stored name. This makes it possible to
 * share a link that signs the other person straight in under their nickname, and
 * it lets two tabs on the same browser use different names (localStorage is
 * shared across tabs, so without this they would collide).
 */
export function nameFromUrl(): string | null {
  const raw = new URLSearchParams(location.search).get('name')
  if (!raw) return null
  const v = raw.trim().slice(0, 16)
  return v || null
}

/**
 * Share link for a room. Keeps any `?sharecode=` (host-level gate) but drops our
 * own `?name=` so the guest is asked for their nickname instead of inheriting it.
 */
export function shareUrl(code: string, game: 'g' | 'd'): string {
  const url = new URL(location.href)
  url.searchParams.delete('name')
  url.hash = `#/${game}/${code}`
  return url.toString()
}
