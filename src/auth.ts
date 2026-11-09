// Client-side gate.
//
// This is a curtain, not a lock. Everything runs in the browser, so the bundle
// (and the hash below) is readable and the check can be bypassed by anyone who
// opens devtools. What it does buy you: someone who stumbles on the URL cannot
// wander in, and the game only talks to the broker after the password is
// accepted. Treat it as "keep the room private from casual visitors", not as
// security for anything valuable.
//
// The stored value is a SHA-256 of the password, so the plaintext never sits in
// the bundle. It still does not stop offline guessing — pick a long password.

const PASS_HASH = '9862e9c89ea58aa4cbc3814bc5c5858f093d1e555609db1c66071c34cf46f796'
const STORE_KEY = 'gomoku.pass'
/** How long a successful unlock is remembered on this device. */
const GRACE_MS = 30 * 24 * 60 * 60 * 1000

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

interface Stored {
  hash: string
  at: number
}

function readStored(): Stored | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return null
    const o = JSON.parse(raw) as Partial<Stored>
    if (typeof o.hash !== 'string' || typeof o.at !== 'number') return null
    return { hash: o.hash, at: o.at }
  } catch {
    return null
  }
}

/** True when this device already unlocked recently (and the password is unchanged). */
export function isUnlocked(): boolean {
  const s = readStored()
  if (!s) return false
  if (s.hash !== PASS_HASH) return false
  return Date.now() - s.at < GRACE_MS
}

/** Check a typed password; on success remember it on this device. */
export async function tryUnlock(input: string): Promise<boolean> {
  const ok = (await sha256(input.trim())) === PASS_HASH
  if (ok) {
    localStorage.setItem(STORE_KEY, JSON.stringify({ hash: PASS_HASH, at: Date.now() } satisfies Stored))
  }
  return ok
}

/** Forget the unlock on this device, so the password is asked again. */
export function lock(): void {
  localStorage.removeItem(STORE_KEY)
}
