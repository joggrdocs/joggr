/** Constants shared across the offboarding scripts. */

/** Prefix for every Joggr-authored skill and agent file. */
export const JOGGR_NAME_PREFIX = 'gg-'

/** The Claude Code hook matcher Joggr installs under. */
export const JOGGR_HOOK_MATCHER = 'ExitPlanMode'

/** Binaries Joggr publishes as the `bin` field of @joggr/cli. */
export const JOGGR_BINARY_NAMES = Object.freeze(['jog', 'joggr'])

/** npm package names we look for in project package.json dependencies. */
export const JOGGR_PACKAGE_NAMES = Object.freeze(['@joggr/cli'])

/** Directory name for the offboarding backup (peer to ~/.claude/). */
export const JOGGR_BACKUP_DIRNAME = '.joggr-offboard-backup'

/** Package managers we try to uninstall @joggr/cli through. */
export const PACKAGE_MANAGERS = Object.freeze([
  { name: 'npm', cmd: 'npm', uninstallArgs: ['uninstall', '-g', '@joggr/cli'] },
  { name: 'pnpm', cmd: 'pnpm', uninstallArgs: ['rm', '-g', '@joggr/cli'] },
  { name: 'bun', cmd: 'bun', uninstallArgs: ['remove', '-g', '@joggr/cli'] },
])
