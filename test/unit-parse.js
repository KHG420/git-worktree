/**
 * Unit tests for the pure git-output parsers (lib/parse.js) — including the
 * odd inputs real git produces: detached/bare/prunable worktrees, ahead/behind
 * sync lines, unborn branches, rename entries, and degenerate empty output.
 *
 * Run: node test/unit-parse.js
 */
import assert from 'node:assert/strict'
import { parseBranchList, parseStatus, parseWorktreeList } from '../lib/parse.js'

let passed = 0
const t = (name, fn) => {
  try {
    fn()
    passed += 1
  } catch (error) {
    console.error(`✗ ${name}`)
    throw error
  }
}

// ── parseWorktreeList ───────────────────────────────────────────────────────

t('worktree list: primary + linked with branches', () => {
  const out = [
    'worktree /repo',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /repo/.dsh-wt/feat',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/feat',
    '',
  ].join('\n')
  const wts = parseWorktreeList(out)
  assert.equal(wts.length, 2)
  assert.deepEqual(wts[0], {
    path: '/repo', head: '1111111111111111111111111111111111111111',
    branch: 'main', detached: false, bare: false,
  })
  assert.equal(wts[1].path, '/repo/.dsh-wt/feat')
  assert.equal(wts[1].branch, 'feat')
})

t('worktree list: detached and bare entries', () => {
  const out = [
    'worktree /repo',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /repo/.dsh-wt/detached',
    'HEAD 3333333333333333333333333333333333333333',
    'detached',
    '',
    'worktree /repo/.dsh-wt/bare',
    'HEAD 4444444444444444444444444444444444444444',
    'branch refs/heads/x',
    'bare',
    '',
  ].join('\n')
  const wts = parseWorktreeList(out)
  assert.equal(wts.length, 3)
  assert.equal(wts[1].detached, true)
  assert.equal(wts[1].branch, null)
  assert.equal(wts[2].bare, true)
  assert.equal(wts[2].branch, 'x')
})

t('worktree list: prunable/locked lines are ignored, entry survives', () => {
  const out = [
    'worktree /repo',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /repo/.dsh-wt/stale',
    'HEAD 5555555555555555555555555555555555555555',
    'branch refs/heads/stale',
    'prunable gitdir file points to non-existent location',
    'locked',
    '',
  ].join('\n')
  const wts = parseWorktreeList(out)
  assert.equal(wts.length, 2)
  assert.equal(wts[1].path, '/repo/.dsh-wt/stale')
  assert.equal(wts[1].branch, 'stale')
})

t('worktree list: empty input', () => {
  assert.deepEqual(parseWorktreeList(''), [])
  assert.deepEqual(parseWorktreeList('\n\n'), [])
})

t('worktree list: no trailing newline', () => {
  const wts = parseWorktreeList('worktree /repo\nHEAD abc\ndetached')
  assert.equal(wts.length, 1)
  assert.equal(wts[0].detached, true)
})

t('worktree list: paths containing spaces survive raw', () => {
  const wts = parseWorktreeList('worktree /repo with space\nHEAD abc\nbranch refs/heads/main\n')
  assert.equal(wts[0].path, '/repo with space')
})

t('worktree list: HEAD/branch keys before any worktree line are ignored', () => {
  assert.deepEqual(parseWorktreeList('HEAD abc\nbranch refs/heads/x\n'), [])
})

// ── parseBranchList ─────────────────────────────────────────────────────────

const B = (rows) => rows.map((r) => r.join('\t')).join('\n')

t('branch list: with upstream and HEAD marker', () => {
  const out = B([
    ['main', '*', 'abc1234', 'origin/main'],
    ['feat', ' ', 'def5678', ''],
  ])
  const bs = parseBranchList(out)
  assert.equal(bs.length, 2)
  assert.deepEqual(bs[0], { name: 'main', head: true, sha: 'abc1234', upstream: 'origin/main' })
  assert.deepEqual(bs[1], { name: 'feat', head: false, sha: 'def5678', upstream: null })
})

t('branch list: empty input and blank lines', () => {
  assert.deepEqual(parseBranchList(''), [])
  assert.deepEqual(parseBranchList('\n  \n'), [])
})

t('branch list: malformed rows with missing fields', () => {
  const out = 'lone\n' // no tabs at all
  const bs = parseBranchList(out)
  assert.equal(bs.length, 1)
  assert.equal(bs[0].name, 'lone')
  assert.equal(bs[0].head, false)
  assert.equal(bs[0].sha, null)
  assert.equal(bs[0].upstream, null)
})

// ── parseStatus ─────────────────────────────────────────────────────────────

t('status: clean repo', () => {
  const s = parseStatus('## main\n')
  assert.deepEqual(s, { branch: 'main', ahead: 0, behind: 0, entries: [] })
})

t('status: ahead/behind sync line', () => {
  const s = parseStatus('## main...origin/main [ahead 1, behind 2]\n')
  assert.equal(s.branch, 'main')
  assert.equal(s.ahead, 1)
  assert.equal(s.behind, 2)
})

t('status: ahead only / behind only', () => {
  assert.equal(parseStatus('## main...origin/main [ahead 3]\n').ahead, 3)
  assert.equal(parseStatus('## main...origin/main [behind 4]\n').behind, 4)
  assert.equal(parseStatus('## main...origin/main [behind 4]\n').ahead, 0)
})

t('status: dirty entry kinds (modified, untracked, staged, renamed)', () => {
  const s = parseStatus([
    '## main',
    ' M a.txt',           // modified, unstaged
    '?? untracked.txt',   // untracked
    'A  staged.txt',      // staged
    'R  old.txt -> new.txt', // renamed
  ].join('\n'))
  assert.equal(s.entries.length, 4, 'all four entries parsed')
  assert.deepEqual(s.entries, [
    { x: ' ', y: 'M', path: 'a.txt' },
    { x: '?', y: '?', path: 'untracked.txt' },
    { x: 'A', y: ' ', path: 'staged.txt' },
    { x: 'R', y: ' ', path: 'old.txt -> new.txt' },
  ])
})

t('status: one-char paths keep the full path', () => {
  const s = parseStatus('## main\n M x\n')
  assert.deepEqual(s.entries, [{ x: ' ', y: 'M', path: 'x' }])
})

t('status: detached HEAD', () => {
  const s = parseStatus('## HEAD (no branch)\n')
  assert.equal(s.branch, '(detached)')
})

t('status: unborn branch — branch name parsed, not the phrase', () => {
  assert.equal(parseStatus('## No commits yet on main\n').branch, 'main')
  assert.equal(parseStatus('## No commits yet on feature/foo\n').branch, 'feature/foo')
  assert.equal(parseStatus('## Initial commit on main\n').branch, 'main')
})

t('status: empty input', () => {
  assert.deepEqual(parseStatus(''), { branch: null, ahead: 0, behind: 0, entries: [] })
})

t('status: a file literally named "## x" is an entry, not a branch line', () => {
  const s = parseStatus('?? ## x\n')
  assert.equal(s.branch, null)
  assert.deepEqual(s.entries, [{ x: '?', y: '?', path: '## x' }])
})

console.log(`✅ unit-parse: ${passed} assertions passed`)
