import { resolve } from "node:path"

/**
 * Coordinates a helper-owned session move with the asynchronous
 * `session.moved` event stream. The event is a backstop for native moves, but
 * must not write durable state before the helper has verified its own move.
 */
export type SessionMoveCoordinator = {
  begin(sessionID: string, targetDirectory: string): SessionMoveLease
  awaitEvent(sessionID: string, directory?: string): Promise<boolean>
  dispose(): void
}

export type SessionMoveLease = {
  /** The native move completed; suppress its matching event reconciliation. */
  suppressEvent(): void
  /** The native move did not complete; allow a future event to reconcile. */
  cancel(): void
}

type Entry = {
  target: string
  settled: Promise<boolean>
  resolve: (suppress: boolean) => void
  timer?: ReturnType<typeof setTimeout>
}

const SETTLED_ENTRY_TTL_MS = 5_000

export function createSessionMoveCoordinator(): SessionMoveCoordinator {
  const entries = new Map<string, Entry>()

  return {
    begin(sessionID, targetDirectory) {
      // A second helper move for one session supersedes an abandoned lease.
      // Settle it so an already-waiting event stream never deadlocks.
      const prior = entries.get(sessionID)
      if (prior) settle(prior, true)

      let resolveSettled!: (suppress: boolean) => void
      const entry: Entry = {
        target: resolve(targetDirectory),
        settled: new Promise<boolean>((done) => {
          resolveSettled = done
        }),
        resolve: resolveSettled,
      }
      entries.set(sessionID, entry)

      return {
        suppressEvent: () => settle(entry, true),
        cancel: () => settle(entry, false),
      }
    },

    async awaitEvent(sessionID, directory) {
      const entry = entries.get(sessionID)
      if (!entry) return false
      // Empty event directories are still correlated: the event may be the
      // helper move but lacks enough data for a safe mismatch decision.
      if (directory && resolve(directory) !== entry.target) return false

      const suppress = await entry.settled
      if (entries.get(sessionID) === entry) {
        if (entry.timer) clearTimeout(entry.timer)
        entries.delete(sessionID)
      }
      return suppress
    },

    dispose() {
      for (const entry of entries.values()) {
        if (entry.timer) clearTimeout(entry.timer)
        entry.resolve(false)
      }
      entries.clear()
    },
  }

  function settle(entry: Entry, suppress: boolean): void {
    entry.resolve(suppress)
    if (!suppress) {
      if (entry.timer) clearTimeout(entry.timer)
      for (const [sessionID, current] of entries) {
        if (current === entry) entries.delete(sessionID)
      }
      return
    }
    // Most events arrive before the helper settles and consume the entry.
    // Retain a short grace period for a late matching event without leaking
    // coordinator state for sessions whose server did not emit one.
    entry.timer = setTimeout(() => {
      for (const [sessionID, current] of entries) {
        if (current === entry) entries.delete(sessionID)
      }
    }, SETTLED_ENTRY_TTL_MS)
    entry.timer.unref?.()
  }
}
