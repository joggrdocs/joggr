#!/usr/bin/env node
/**
 * Joggr offboarding — status check.
 *
 * Read-only. Reports whether the CLI, hook, and gg-* skills/agents
 * are gone. Exits 0 when offboarded, 1 when something remains.
 *
 * Requires Node 20+.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  fileExists,
  findGitRootFromCwd,
  findJoggrCliDeps,
  findJoggrEntries,
  findJoggrHooks,
  getBackupDir,
  getClaudeHomeDir,
  getClaudeSettingsPath,
  hasBinary,
  isJoggrCommand,
} from './lib/utils.mjs'

const findings = []

console.log('Joggr offboarding — status')
console.log('--------------------------\n')

await checkCli()
await checkHook()
await checkGgEntries()
await checkProjectDep()
await checkBackup()

const fails = findings.filter((f) => f.kind === 'fail').length
const passes = findings.filter((f) => f.kind === 'pass').length
const todos = findings.filter((f) => f.kind === 'todo').length

console.log(`\n${passes} pass, ${fails} fail, ${todos} todo`)
if (fails === 0 && todos === 0) console.log('\nFully offboarded.')
else if (fails > 0) console.log('\nRun `node offboard.mjs` to clean up the FAIL items.')

process.exit(fails > 0 ? 1 : 0)

async function checkCli() {
  const stuck = ['jog', 'joggr'].filter((bin) => hasBinary(bin))
  if (stuck.length === 0) {
    pass('Neither jog nor joggr is on PATH')
  } else {
    fail(`${stuck.join(' / ')} still on PATH`, 'Uninstall manually: npm/pnpm/bun remove -g @joggr/cli')
  }
}

async function checkProjectDep() {
  // Walking up from CWD so the check works whether the user invoked
  // status.mjs from inside the offboarding tool dir or from anywhere
  // under their project tree.
  const gitRoot = await findGitRootFromCwd()
  if (!gitRoot) {
    pass('No nearby git repo to scan for project-level @joggr/cli dependency')
    return
  }
  const matches = await findJoggrCliDeps(gitRoot)
  if (matches.length === 0) {
    pass(`No package.json under ${gitRoot} lists @joggr/cli as a dependency`)
    return
  }
  const list = matches.map((m) => `    - ${m.path}  (${m.field})`).join('\n')
  todo(
    `@joggr/cli is still a dependency in ${matches.length} package.json file${matches.length === 1 ? '' : 's'}`,
    `Remove it and re-install, otherwise the next install will pull it back in:\n${list}`
  )
}

async function checkHook() {
  const settingsPath = getClaudeSettingsPath()
  let settings
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf-8'))
  } catch (err) {
    if (err?.code === 'ENOENT') {
      pass(`No Claude settings file at ${settingsPath}`)
      return
    }
    fail(`Could not read or parse ${settingsPath}`, err.message)
    return
  }

  const matches = findJoggrHooks(settings)
  if (matches.length === 0) {
    pass(`No Joggr hook in ${settingsPath}`)
    return
  }
  const detail = matches
    .flatMap((entry) => entry.hooks.filter((h) => isJoggrCommand(h?.command)).map((h) => h.command))
    .join(', ')
  fail(`Found ${matches.length} Joggr hook entries in ${settingsPath}`, `command(s): ${detail}`)
}

async function checkGgEntries() {
  const claudeDir = getClaudeHomeDir()
  for (const sub of ['skills', 'agents']) {
    const path = join(claudeDir, sub)
    let entries
    try {
      entries = await findJoggrEntries(path)
    } catch (err) {
      fail(`Could not read ${path}`, err.message)
      continue
    }
    if (entries.length === 0) pass(`No gg-* entries in ${path}`)
    else fail(`${entries.length} gg-* entries remain in ${path}`, `entries: ${entries.join(', ')}`)
  }
}

async function checkBackup() {
  const backupDir = getBackupDir()
  if (!(await fileExists(backupDir))) {
    pass(`No backup directory at ${backupDir}`)
    return
  }
  todo(`Backup directory exists: ${backupDir}`, 'Run `node restore.mjs` to undo, or `rm -rf` it to commit.')
}

function pass(label) {
  findings.push({ kind: 'pass', label })
  console.log(`  PASS  ${label}`)
}
function fail(label, detail) {
  findings.push({ kind: 'fail', label })
  console.log(`  FAIL  ${label}`)
  if (detail) console.log(`        ${detail}`)
}
function todo(label, detail) {
  findings.push({ kind: 'todo', label })
  console.log(`  TODO  ${label}`)
  if (detail) console.log(`        ${detail}`)
}
