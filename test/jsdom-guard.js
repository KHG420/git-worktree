/**
 * Shared jsdom/window error guard for the DOM test suites.
 *
 * React's event system (and any code a suite mounts) must not throw an
 * uncaught exception out of a jsdom window. Those exceptions used to be
 * printed to stderr while the suite still exited 0 (the legacy
 * `attachEvent`/`detachEvent` TypeError reachable when react-dom loads before
 * the global `document` exists). `installJsdomGuards` records every window
 * `error` / `unhandledrejection` event and every jsdom `jsdomError` — forwards
 * them to the real console, never suppressing them — and exposes
 * `assertClean()` so a runner can fail the suite with the actual messages.
 */

/**
 * Install the guard over one jsdom window (and optionally its virtual console).
 * @param window - the jsdom `window` whose uncaught errors must be recorded.
 * @param virtualConsole - the JSDOM `virtualConsole` (or null).
 * @returns `{ errors, take, assertClean }`; `assertClean` throws when any
 *   recorded error is pending and clears the record.
 */
export function installJsdomGuards(window, virtualConsole) {
  const errors = []
  const record = (error) => {
    errors.push(error instanceof Error ? error : new Error(String(error)))
  }
  if (window !== null && window !== undefined && typeof window.addEventListener === 'function') {
    window.addEventListener('error', (event) => {
      record(event?.error ?? new Error(event?.message ?? 'window error'))
    })
    window.addEventListener('unhandledrejection', (event) => {
      record(event?.reason ?? new Error('unhandled rejection'))
    })
  }
  if (virtualConsole !== null && virtualConsole !== undefined && typeof virtualConsole.on === 'function') {
    virtualConsole.on('jsdomError', record)
  }
  return {
    errors,
    take() {
      const taken = errors.slice()
      errors.length = 0
      return taken
    },
    assertClean(label = 'jsdom/window') {
      if (errors.length === 0) return
      const messages = errors.map((error) => error?.message ?? String(error))
      errors.length = 0
      throw new Error(`${label}: unexpected ${messages.length} error(s): ${messages.join('; ')}`)
    },
  }
}
