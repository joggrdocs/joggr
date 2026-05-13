/**
 * Shared helpers for the offboarding scripts. Node 20+, no runtime deps.
 */

import { access, constants, readFile, readdir, rename } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import {
  JOGGR_BACKUP_DIRNAME,
  JOGGR_BINARY_NAMES,
  JOGGR_HOOK_MATCHER,
  JOGGR_NAME_PREFIX,
  JOGGR_PACKAGE_NAMES,
} from './constants.mjs'

/** True if `path` exists and is accessible (any error → false). */
export async function fileExists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * True if `bin` is on the user's real PATH.
 *
 * `node_modules/.bin/` entries are filtered out before the check — the
 * status script is meant to report on globally-installed binaries, and
 * `npm run` would otherwise inject the local project's `.bin/` and
 * false-positive when run from inside any repo that has `@joggr/cli`
 * as a dependency.
 */
export function hasBinary(bin) {
  const cleanPath = (process.env.PATH ?? '')
    .split(':')
    .filter((p) => p && !p.includes('/node_modules/.bin'))
    .join(':')
  const result = spawnSync('sh', ['-c', 'command -v "$1"', '_', bin], {
    stdio: 'ignore',
    env: { ...process.env, PATH: cleanPath },
  })
  return result.status === 0
}

/** Move `src` to `dst` via `rename`. Throws on any error — happy path only. */
export async function moveFile(src, dst) {
  await rename(src, dst)
}

/** True if a hook command string invokes `jog` / `joggr` (basename match). */
export function isJoggrCommand(command) {
  if (typeof command !== 'string') return false
  const firstToken = command.trim().split(/\s+/)[0]
  if (!firstToken) return false
  return JOGGR_BINARY_NAMES.includes(basename(firstToken))
}

/** Return Joggr-matching entries from `settings.hooks.PermissionRequest`. */
export function findJoggrHooks(settings) {
  const entries = settings?.hooks?.PermissionRequest ?? []
  if (!Array.isArray(entries)) return []
  return entries.filter(
    (e) => e?.matcher === JOGGR_HOOK_MATCHER && Array.isArray(e?.hooks) && e.hooks.some((h) => isJoggrCommand(h?.command))
  )
}

/**
 * Surgically remove Joggr hook commands from `PermissionRequest`,
 * preserving non-Joggr siblings. Drops an entry whose `hooks` empties.
 */
export function withoutJoggrHooks(settings) {
  const entries = settings?.hooks?.PermissionRequest ?? []
  if (!Array.isArray(entries)) return { entries: [], removed: 0 }
  let removed = 0
  const result = []
  for (const entry of entries) {
    if (entry?.matcher !== JOGGR_HOOK_MATCHER) {
      result.push(entry)
      continue
    }
    const hooks = Array.isArray(entry?.hooks) ? entry.hooks : []
    const kept = hooks.filter((h) => !isJoggrCommand(h?.command))
    const dropped = hooks.length - kept.length
    if (dropped === 0) {
      result.push(entry)
      continue
    }
    removed += dropped
    if (kept.length > 0) result.push({ ...entry, hooks: kept })
  }
  return { entries: result, removed }
}

/** `gg-*` entries inside a Claude subdir (`skills` / `agents`). [] on ENOENT. */
export async function findJoggrEntries(dir) {
  try {
    const entries = await readdir(dir)
    return entries.filter((name) => name.startsWith(JOGGR_NAME_PREFIX))
  } catch (err) {
    if (err?.code === 'ENOENT') return []
    throw err
  }
}

export function getClaudeHomeDir() {
  return process.env.CLAUDE_HOME || join(homedir(), '.claude')
}

export function getClaudeSettingsPath() {
  return join(getClaudeHomeDir(), 'settings.json')
}

export function getBackupDir() {
  return process.env.JOGGR_OFFBOARD_BACKUP_DIR || join(homedir(), JOGGR_BACKUP_DIRNAME)
}

export function getBackupSettingsPath() {
  return join(getBackupDir(), 'settings.json')
}

export function getPostOffboardSettingsPath() {
  return join(getBackupDir(), 'settings.post-offboard.json')
}

export function getBackupSubdir(subdir) {
  return join(getBackupDir(), subdir)
}

/**
 * Walk upward from `startDir` looking for a `.git` entry. Stops at the
 * filesystem root or `$HOME`, whichever comes first.
 *
 * @param {string} [startDir]
 * @returns {Promise<string | null>}
 */
export async function findGitRootFromCwd(startDir = process.cwd()) {
  const home = homedir()
  let current = resolve(startDir)
  while (true) {
    if (await fileExists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return null
    if (current === home) return null
    current = parent
  }
}

/**
 * Walk `root` looking for `package.json` files that list any
 * `JOGGR_PACKAGE_NAMES` in their dependencies / devDependencies /
 * peerDependencies / optionalDependencies. Returns the absolute path
 * and which field hit. Skips `node_modules` and common build dirs.
 *
 * @param {string} root
 * @returns {Promise<Array<{ path: string, field: string, name: string }>>}
 */
export async function findJoggrCliDeps(root) {
  const skipDirs = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'out',
    '.next',
    '.turbo',
    '.cache',
    'coverage',
  ])
  const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
  /** @type {Array<{ path: string, field: string, name: string }>} */
  const matches = []

  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isFile() && entry.name === 'package.json') {
        try {
          const pkg = JSON.parse(await readFile(full, 'utf-8'))
          for (const field of fields) {
            const deps = pkg[field]
            if (!deps || typeof deps !== 'object') continue
            for (const name of JOGGR_PACKAGE_NAMES) {
              if (name in deps) {
                matches.push({ path: full, field, name })
                break
              }
            }
          }
        } catch {
          // Skip unreadable / unparseable package.json silently.
        }
        continue
      }
      if (entry.isDirectory() && !skipDirs.has(entry.name)) {
        await walk(full)
      }
    }
  }

  await walk(root)
  return matches
}
