/**
 * Auto-Update Loop
 *
 * Polls origin/main for new commits. When detected:
 * 1. Ensure working tree is on main (self-heal if an agent left it on a branch)
 * 2. Stash any dirty state left behind
 * 3. Quiesce the queue (stop accepting new work, wait for containers to drain)
 * 4. git pull --ff-only  (or reset --hard as fallback)
 * 5. npm run build
 * 6. process.exit(0) — launchd KeepAlive restarts the process
 *
 * The main checkout is treated as a read-only production environment.
 * All development must happen in git worktrees under /tmp/nanoclaw-*.
 */

import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const AUTO_UPDATE_INTERVAL = 60_000; // 60 seconds
const STARTUP_DELAY = 30_000; // Wait 30s after startup before first check
const FETCH_TIMEOUT = 30_000;
const PULL_TIMEOUT = 60_000;
const BUILD_TIMEOUT = 120_000;
const QUIESCE_TIMEOUT = 180_000; // Max 3 minutes to wait for containers to drain

/** File written before restart so the next boot can report what changed. */
export const UPDATE_CHANGELOG_PATH = path.join(
  DATA_DIR,
  'last-update-changelog.txt',
);

interface QueueHandle {
  getActiveCount(): number;
  quiesce(): Promise<void>;
  unquiesce(): void;
}

/**
 * Resolve the directory containing the current Node binary so we can build
 * a PATH that includes npm/npx.  When NanoClaw is launched via launchd the
 * default shell PATH (/usr/bin:/bin) doesn't contain the Homebrew or nvm
 * managed node/npm, so bare `npm run build` fails with "command not found".
 */
function resolveNodeBinDir(): string {
  return path.dirname(process.execPath);
}

/** Run a git command and return trimmed stdout. */
function git(args: string, cwd: string, timeout?: number): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout,
  }).trim();
}

/**
 * Ensure the working tree is on the main branch.
 *
 * Agents sometimes leave the main checkout on a feature branch by accident.
 * Instead of looping forever comparing HEAD to origin/main (which will never
 * match on a different branch), detect this and self-heal:
 *   1. Stash any uncommitted changes (so checkout doesn't fail)
 *   2. git checkout main
 *
 * Returns true if we're on main (or recovered successfully), false if
 * recovery failed and we should skip this cycle.
 */
function ensureOnMain(cwd: string): boolean {
  const branch = git('rev-parse --abbrev-ref HEAD', cwd);

  if (branch === 'main') return true;

  logger.warn({ branch }, 'Main checkout is not on main branch — self-healing');

  // Stash any dirty state so checkout succeeds
  const dirty = git('status --porcelain', cwd);
  if (dirty) {
    logger.warn(
      { fileCount: dirty.split('\n').length },
      'Stashing dirty working tree before branch recovery',
    );
    execSync('git stash -u', { cwd, stdio: 'pipe' });
  }

  try {
    execSync('git checkout main', { cwd, stdio: 'pipe' });
    logger.info('Recovered: checked out main branch');
    return true;
  } catch (err) {
    logger.error(
      { err, branch },
      'Failed to checkout main — skipping auto-update cycle',
    );
    return false;
  }
}

/**
 * Stash any uncommitted changes in the working tree.
 *
 * Agents may leave behind modified files (e.g. debug edits, partial work).
 * Rather than failing the pull, we stash them. The main checkout is a
 * production environment — uncommitted changes here are never intentional.
 */
function stashIfDirty(cwd: string): void {
  const dirty = git('status --porcelain', cwd);
  if (!dirty) return;

  logger.warn(
    { fileCount: dirty.split('\n').length },
    'Stashing dirty working tree before auto-update pull',
  );
  execSync('git stash -u', { cwd, stdio: 'pipe' });
}

/**
 * Determine whether origin/main has commits that local main doesn't.
 *
 * The old approach (`local !== remote`) broke when local was ahead of remote
 * (e.g. the checkout was on a feature branch with extra commits). This
 * caused an infinite restart loop because the SHAs never matched yet
 * `git pull` had nothing to do.
 *
 * The correct check: does origin/main contain commits not reachable from HEAD?
 * `git merge-base --is-ancestor <remote> <local>` exits 0 when remote is
 * an ancestor of local (i.e. local already contains everything in remote).
 */
function hasRemoteUpdates(
  cwd: string,
  localSha: string,
  remoteSha: string,
): boolean {
  if (localSha === remoteSha) return false;

  const result = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', remoteSha, localSha],
    { cwd },
  );

  // exit 0 = remote is ancestor of local -> no update needed
  // exit 1 = remote has commits local doesn't -> update needed
  return result.status !== 0;
}

export function startAutoUpdateLoop(queue?: QueueHandle): void {
  const projectRoot = process.cwd();
  const nodeBinDir = resolveNodeBinDir();

  // Prepend the Node binary's directory to PATH so npm/npx are reachable
  // even when launched from a minimal launchd/systemd environment.
  const execEnv = {
    ...process.env,
    PATH: `${nodeBinDir}:${process.env.PATH || '/usr/bin:/bin'}`,
  };

  let checking = false;

  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      // Phase 1: Fetch latest remote state (read-only, safe to do before quiesce).
      execSync('git fetch origin main', {
        cwd: projectRoot,
        stdio: 'ignore',
        timeout: FETCH_TIMEOUT,
      });

      // Phase 2: Quick check — do we even need to update? Read HEAD and
      // origin/main to decide. If we're on the wrong branch, HEAD won't
      // match origin/main and hasRemoteUpdates will likely return true,
      // which is fine — we'll fix the branch after quiescing.
      const currentHead = git('rev-parse HEAD', projectRoot);
      const remote = git('rev-parse origin/main', projectRoot);

      // Fast path: if HEAD already matches origin/main, nothing to do.
      // This avoids quiescing the queue on every 60s cycle.
      if (currentHead === remote) return;

      // We may need to update (or self-heal the branch). Use the more
      // expensive ancestor check after we know the SHAs differ.
      const branch = git('rev-parse --abbrev-ref HEAD', projectRoot);
      const onMain = branch === 'main';

      // If we're on main and local already contains remote, no update needed.
      if (onMain && !hasRemoteUpdates(projectRoot, currentHead, remote)) return;

      logger.info(
        {
          localCommit: currentHead.slice(0, 8),
          remoteCommit: remote.slice(0, 8),
          branch,
        },
        onMain
          ? 'New commits on main detected, pulling and rebuilding'
          : 'Wrong branch detected, will self-heal after quiescing',
      );

      // Phase 3: Quiesce the queue — stop accepting new work and wait for
      // all running containers to drain. This must happen BEFORE we mutate
      // the working tree (checkout, stash, pull) because containers may
      // mount the project directory read-only.
      if (queue) {
        const active = queue.getActiveCount();
        if (active > 0) {
          logger.info(
            { activeContainers: active },
            'Quiescing queue — waiting for containers to drain',
          );
          const drained = await Promise.race([
            queue.quiesce().then(() => true),
            new Promise<false>((r) =>
              setTimeout(() => r(false), QUIESCE_TIMEOUT),
            ),
          ]);
          if (!drained) {
            logger.warn(
              { activeContainers: queue.getActiveCount() },
              'Quiesce timed out, deferring auto-update to next cycle',
            );
            queue.unquiesce();
            return;
          }
          logger.info('All containers drained, proceeding with update');
        } else {
          // No active containers — quiesce immediately to block new work
          // during pull/build.
          queue.quiesce();
        }
      }

      // Phase 4: Now that the queue is quiesced and no containers are
      // reading the working tree, safely recover the branch and clean
      // dirty state.
      if (!ensureOnMain(projectRoot)) return;
      stashIfDirty(projectRoot);

      // Re-read HEAD after potential branch switch — it may have changed.
      const local = git('rev-parse HEAD', projectRoot);

      // Phase 5: Pull. Try --ff-only first (clean fast-forward). If that
      // fails (e.g. local diverged from remote due to leftover commits),
      // fall back to reset --hard. The main checkout is a production
      // environment — local-only commits here are never intentional.
      try {
        execSync('git pull --ff-only origin main', {
          cwd: projectRoot,
          stdio: 'pipe',
          timeout: PULL_TIMEOUT,
          env: execEnv,
        });
      } catch (pullErr) {
        logger.warn(
          { err: pullErr },
          'Fast-forward pull failed — falling back to hard reset',
        );
        execSync('git reset --hard origin/main', {
          cwd: projectRoot,
          stdio: 'pipe',
          timeout: PULL_TIMEOUT,
        });
      }

      // Collect a human-readable summary of what changed.  Strip commit
      // hashes and conventional commit prefixes (fix:, feat:, etc.).
      // Written to disk only after a successful build (see below).
      let changelogText = '';
      try {
        const newHead = git('rev-parse HEAD', projectRoot);
        const range = `${local}..${newHead}`;

        // Try --first-parent --no-merges first (clean linear history).
        // If that yields nothing (e.g. only merge commits), fall back to
        // --first-parent alone, then strip "Merge pull request" lines.
        let subjects = git(
          `log --format=%s --first-parent --no-merges ${range}`,
          projectRoot,
        );

        if (!subjects) {
          subjects = git(`log --format=%s --first-parent ${range}`, projectRoot)
            .split('\n')
            .filter((s) => !/^Merge (pull request|branch) /i.test(s))
            .join('\n')
            .trim();
        }

        logger.info(
          { range, subjectCount: subjects ? subjects.split('\n').length : 0 },
          'Changelog subjects collected',
        );

        if (subjects) {
          changelogText = subjects
            .split('\n')
            .map((s) => s.replace(/^[a-z]+(\([^)]*\))?:\s*/i, '').trim())
            .filter(Boolean)
            .map((s) => `• ${s.charAt(0).toUpperCase()}${s.slice(1)}`)
            .join('\n');
        }
      } catch (changelogErr) {
        logger.warn({ err: changelogErr }, 'Failed to build changelog text');
      }

      execSync('npm run build', {
        cwd: projectRoot,
        stdio: 'pipe',
        timeout: BUILD_TIMEOUT,
        env: execEnv,
      });

      // Persist changelog only after a successful build so a failed
      // update doesn't leave a stale file that misleads the next restart.
      if (changelogText) {
        try {
          fs.mkdirSync(path.dirname(UPDATE_CHANGELOG_PATH), {
            recursive: true,
          });
          fs.writeFileSync(UPDATE_CHANGELOG_PATH, changelogText, 'utf-8');
          logger.info(
            { path: UPDATE_CHANGELOG_PATH, length: changelogText.length },
            'Changelog written to disk',
          );
        } catch (writeErr) {
          logger.warn({ err: writeErr }, 'Failed to write update changelog');
        }
      } else {
        logger.warn(
          'No changelog text generated — restart message will be bare',
        );
      }

      logger.info('Auto-update rebuild complete, restarting');
      process.exit(0);
    } catch (err) {
      // If we quiesced but failed to update, re-open the queue so normal
      // processing resumes.
      if (queue) queue.unquiesce();
      logger.error({ err }, 'Auto-update check failed');
    } finally {
      checking = false;
    }
  };

  setTimeout(() => {
    check();
    setInterval(check, AUTO_UPDATE_INTERVAL);
  }, STARTUP_DELAY);

  logger.info(
    {
      intervalMs: AUTO_UPDATE_INTERVAL,
      startupDelayMs: STARTUP_DELAY,
      nodeBinDir,
    },
    'Auto-update loop started',
  );
}
