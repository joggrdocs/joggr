/**
 * Integration tests for offboard.mjs / status.mjs / restore.mjs.
 *
 * Happy-path coverage only. Tests use CLAUDE_HOME +
 * JOGGR_OFFBOARD_BACKUP_DIR env vars so they never touch the user's
 * real Claude state, and JOGGR_OFFBOARD_SKIP_UNINSTALL so they never
 * try to uninstall the CLI globally.
 */

import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const OFFBOARD = join(root, 'offboard.mjs')
const STATUS = join(root, 'status.mjs')
const RESTORE = join(root, 'restore.mjs')

function run(script, { args = ['--yes'], env = {} } = {}) {
  const result = spawnSync('node', [script, ...args], {
    env: { ...process.env, JOGGR_OFFBOARD_SKIP_UNINSTALL: '1', ...env },
    encoding: 'utf-8',
  })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function writeSettings(path, { withSibling = false } = {}) {
  const exitHooks = [{ type: 'command', command: 'jog app --plan', timeout: 100 }]
  if (withSibling) exitHooks.push({ type: 'command', command: 'echo personal' })
  const settings = {
    hooks: {
      PermissionRequest: [
        { matcher: '*', hooks: [{ type: 'command', command: 'notify.sh' }] },
        { matcher: 'ExitPlanMode', hooks: exitHooks },
      ],
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'cleanup.sh' }] }],
    },
  }
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`)
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

describe('offboard → restore round-trip', () => {
  let fake
  let backup
  let env

  beforeEach(async () => {
    fake = await mkdtemp(join(tmpdir(), 'offboard-int-'))
    backup = join(tmpdir(), `offboard-bkp-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    env = { CLAUDE_HOME: fake, JOGGR_OFFBOARD_BACKUP_DIR: backup }

    await mkdir(join(fake, 'skills', 'gg-plan'), { recursive: true })
    await mkdir(join(fake, 'skills', 'user-skill'), { recursive: true })
    await mkdir(join(fake, 'agents'), { recursive: true })
    await writeFile(join(fake, 'skills', 'gg-plan', 'SKILL.md'), 'joggr')
    await writeFile(join(fake, 'skills', 'user-skill', 'SKILL.md'), 'mine')
    await writeFile(join(fake, 'agents', 'gg-planner.md'), 'joggr')
    await writeSettings(join(fake, 'settings.json'))
  })

  it('round-trip is byte-identical and restores gg-* entries', async () => {
    const before = await sha256(join(fake, 'settings.json'))

    const off = run(OFFBOARD, { env })
    assert.equal(off.status, 0, off.stderr)

    const res = run(RESTORE, { env })
    assert.equal(res.status, 0, res.stderr)

    assert.equal(await sha256(join(fake, 'settings.json')), before)

    await rm(fake, { recursive: true, force: true })
  })

  it('preserves non-Joggr siblings under the same ExitPlanMode entry', async () => {
    await writeSettings(join(fake, 'settings.json'), { withSibling: true })

    const off = run(OFFBOARD, { env })
    assert.equal(off.status, 0, off.stderr)

    const after = JSON.parse(await readFile(join(fake, 'settings.json'), 'utf-8'))
    const exitEntries = after.hooks.PermissionRequest.filter((e) => e.matcher === 'ExitPlanMode')
    assert.equal(exitEntries.length, 1)
    assert.equal(exitEntries[0].hooks.length, 1)
    assert.equal(exitEntries[0].hooks[0].command, 'echo personal')

    await rm(fake, { recursive: true, force: true })
    await rm(backup, { recursive: true, force: true })
  })

  it('refuses a second offboard when a backup already exists', async () => {
    const off1 = run(OFFBOARD, { env })
    assert.equal(off1.status, 0, off1.stderr)

    const off2 = run(OFFBOARD, { env })
    assert.equal(off2.status, 1)
    assert.match(off2.stderr + off2.stdout, /previous offboarding backup exists/)

    await rm(fake, { recursive: true, force: true })
    await rm(backup, { recursive: true, force: true })
  })

  it('restore fails loud when settings.json has been edited since offboard', async () => {
    const off = run(OFFBOARD, { env })
    assert.equal(off.status, 0, off.stderr)

    const current = JSON.parse(await readFile(join(fake, 'settings.json'), 'utf-8'))
    current.customField = 'i made this'
    await writeFile(join(fake, 'settings.json'), JSON.stringify(current, null, 2))

    const res = run(RESTORE, { env })
    assert.equal(res.status, 1)
    assert.match(res.stderr, /edited since offboarding/)

    await rm(fake, { recursive: true, force: true })
    await rm(backup, { recursive: true, force: true })
  })
})

describe('status.mjs', () => {
  let fake
  let backup

  beforeEach(async () => {
    fake = await mkdtemp(join(tmpdir(), 'offboard-status-'))
    backup = join(tmpdir(), `offboard-status-bkp-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(join(fake, 'skills'), { recursive: true })
    await mkdir(join(fake, 'agents'), { recursive: true })
  })

  it('exits 0 on a clean machine', async () => {
    const res = run(STATUS, {
      env: { CLAUDE_HOME: fake, HOME: fake, JOGGR_OFFBOARD_BACKUP_DIR: backup },
      args: [],
    })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, /Fully offboarded/)

    await rm(fake, { recursive: true, force: true })
  })

  it('exits 1 when a Joggr hook is present', async () => {
    await writeSettings(join(fake, 'settings.json'))

    const res = run(STATUS, {
      env: { CLAUDE_HOME: fake, HOME: fake, JOGGR_OFFBOARD_BACKUP_DIR: backup },
      args: [],
    })
    assert.equal(res.status, 1)
    assert.match(res.stdout, /FAIL/)

    await rm(fake, { recursive: true, force: true })
  })
})
