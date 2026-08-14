/**
 * Run every dsh-git-worktree test suite in one process, reporting pass/fail
 * per suite. Exit code is non-zero when any suite fails.
 *
 * Run: node test/run-all.js
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const suites = [
  'unit-parse.js',    // pure parsers (lib/parse.js)
  'unit-git.js',      // git runner + helpers (lib/git.js)
  'test.js',          // original functional suite (tools + route handlers)
  'tools-edge.js',    // 9 tools × boundary matrix against real repos
  'routes-http.js',   // real-HTTP route surface (methods, bodies, caps, timeout)
  'client-unit.js',   // client pure helpers (sanitizeName, sessionsSame, api)
  'client-dom.js',    // jsdom panel interaction tests
  'flows.js',         // real-user-operation flows (panel + agent sequences)
]

let failed = 0
for (const suite of suites) {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, suite)], { stdio: 'inherit' })
    child.on('close', (code) => resolve(code))
  })
  const ok = result === 0
  if (!ok) failed += 1
  console.log(ok ? `✅ ${suite}` : `❌ ${suite} (exit ${result})`)
}

if (failed > 0) {
  console.error(`\n${failed} suite(s) failed`)
  process.exit(1)
}
console.log('\n✅ all suites passed')
