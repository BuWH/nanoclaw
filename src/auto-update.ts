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
import { withGitLock } from './git-lock.js';
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

/** File that records the last known-good commit SHA for rollback. */
export const UPDATE_KNOWN_GOOD_PATH = path.join(DATA_DIR, '.known-good-commit');

/** Marker written BEFORE pull so the next boot can compute the changelog. */
export const PRE_UPDATE_HEAD_PATH = path.join(DATA_DIR, '.pre-update-head');

/** Tracks the last HEAD SHA that was announced, preventing duplicate changelogs. */
export const LAST_ANNOUNCED_HEAD_PATH = path.join(
  DATA_DIR,
  '.last-announced-head',
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
 * Compute a human-readable changelog between two SHAs.
 *
 * Uses three strategies in order:
 * 1. Merge commit subjects (PR titles from GitHub merge flow)
 * 2. Merge commit bodies (PR descriptions)
 * 3. Non-merge commit subjects (squash-merge flow)
 *
 * Returns empty string if no meaningful subjects found or on error.
 */
export function computeChangelog(
  fromSha: string,
  toSha: string,
  cwd: string,
): string {
  try {
    const range = `${fromSha}..${toSha}`;
    logger.info({ fromSha, toSha, range }, 'Computing changelog for range');

    // Strategy 1: merge commit subjects with "Merge pull request" prefix
    // stripped -- gives the PR title, the most user-friendly summary.
    let subjects = git(`log --format=%s --first-parent ${range}`, cwd)
      .split('\n')
      .map((s) => s.replace(/^Merge pull request #\d+ from \S+\s*/i, '').trim())
      .filter(Boolean)
      .join('\n')
      .trim();

    // Strategy 2: extract PR description from merge commit body.
    if (!subjects) {
      const body = git(`log --format=%b --first-parent ${range}`, cwd);
      if (body) {
        subjects = body
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .filter((s) => !/^Merge (pull request|branch) /i.test(s))
          .join('\n')
          .trim();
      }
    }

    // Strategy 3: non-merge commits (squash-merge flow).
    if (!subjects) {
      subjects = git(`log --format=%s --no-merges ${range}`, cwd);
    }

    logger.info(
      { range, subjectCount: subjects ? subjects.split('\n').length : 0 },
      'Changelog subjects collected',
    );

    if (!subjects) return '';

    return subjects
      .split('\n')
      .map((s) => s.replace(/^[a-z]+(\([^)]*\))?:\s*/i, '').trim())
      .filter(Boolean)
      .map((s) => `• ${s.charAt(0).toUpperCase()}${s.slice(1)}`)
      .join('\n');
  } catch (err) {
    logger.warn({ err }, 'Failed to compute changelog text');
    return '';
  }
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
    {
      cwd,
    },
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

  /** Prune stale worktrees and warn if count is high. */
  const maintainWorktrees = () => {
    try {
      execSync('git worktree prune', {
        cwd: projectRoot,
        stdio: 'pipe',
        timeout: 10000,
      });
      const worktreeList = execSync('git worktree list --porcelain', {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 10000,
      });
      const worktreeCount = worktreeList
        .split('\n')
        .filter((l) => l.startsWith('worktree ')).length;
      if (worktreeCount > 8) {
        logger.warn(
          { worktreeCount },
          'High worktree count — consider cleaning up stale worktrees',
        );
      }
    } catch (err) {
      logger.debug({ err }, 'Worktree maintenance failed (non-fatal)');
    }
  };

  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      // Phase 1: Fetch latest remote state (read-only, no lock needed).
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
      if (currentHead === remote) {
        return;
      }

      // We may need to update (or self-heal the branch). Use the more
      // expensive ancestor check after we know the SHAs differ.
      const branch = git('rev-parse --abbrev-ref HEAD', projectRoot);
      const onMain = branch === 'main';

      // If we're on main and local already contains remote, no update needed.
      if (onMain && !hasRemoteUpdates(projectRoot, currentHead, remote)) {
        return;
      }

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
      // dirty state. Wrapped in git lock to prevent concurrent git ops.
      const pullResult = await withGitLock('auto-update:pull', () => {
        if (!ensureOnMain(projectRoot)) return { ok: false as const };
        stashIfDirty(projectRoot);

        // Re-read HEAD after potential branch switch -- it may have changed.
        const localSha = git('rev-parse HEAD', projectRoot);

        // Save known-good commit for rollback (use post-checkout SHA on main)
        try {
          fs.mkdirSync(path.dirname(UPDATE_KNOWN_GOOD_PATH), {
            recursive: true,
          });
          fs.writeFileSync(UPDATE_KNOWN_GOOD_PATH, localSha);
        } catch (saveErr) {
          logger.warn({ err: saveErr }, 'Failed to save known-good commit');
        }

        // Capture SHA on main BEFORE pull — this is the changelog base.
        // `localSha` is read after ensureOnMain, so it's the correct
        // pre-pull state on the main branch (not a feature branch SHA).
        const prePullSha = localSha;

        // Write pre-update marker BEFORE pull. This is the crash-safe anchor:
        // if the process is killed at any point after this (SIGTERM, build
        // failure, etc.), the next boot can compute the changelog as
        // prePullSha..HEAD.
        try {
          fs.writeFileSync(PRE_UPDATE_HEAD_PATH, prePullSha, 'utf-8');
          logger.info(
            { prePullSha, path: PRE_UPDATE_HEAD_PATH },
            'Pre-update HEAD marker written',
          );
        } catch (markerErr) {
          logger.warn(
            { err: markerErr },
            'Failed to write pre-update HEAD marker (non-fatal)',
          );
        }

        // Phase 5: Pull. Try --ff-only first (clean fast-forward). If that
        // fails (e.g. local diverged from remote due to leftover commits),
        // fall back to reset --hard. The main checkout is a production
        // environment -- local-only commits here are never intentional.
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

        return { ok: true as const, localSha, prePullSha };
      });

      if (!pullResult.ok) return;

      // Check if pull actually changed HEAD. If not (pure branch recovery,
      // main was already up-to-date), skip rebuild and restart.
      const newHead = git('rev-parse HEAD', projectRoot);
      if (pullResult.prePullSha === newHead) {
        logger.info(
          { prePullSha: pullResult.prePullSha },
          'Branch recovered to main but no new commits — skipping rebuild',
        );
        // Clean up the pre-update marker since there's nothing to announce.
        try {
          fs.unlinkSync(PRE_UPDATE_HEAD_PATH);
        } catch {
          /* ignore */
        }
        if (queue) queue.unquiesce();
        return;
      }

      // Secondary guard: if HEAD matches the last announced SHA, another
      // process cycle already handled this update. Skip to avoid infinite
      // restart loops where the same SHA keeps triggering rebuilds.
      try {
        const lastAnnounced = fs
          .readFileSync(LAST_ANNOUNCED_HEAD_PATH, 'utf-8')
          .trim();
        if (newHead === lastAnnounced) {
          logger.info(
            { newHead, lastAnnounced },
            'HEAD matches last announced SHA — skipping rebuild to prevent restart loop',
          );
          try {
            fs.unlinkSync(PRE_UPDATE_HEAD_PATH);
          } catch {
            /* ignore */
          }
          if (queue) queue.unquiesce();
          return;
        }
      } catch {
        // File doesn't exist — first update, proceed normally
      }

      try {
        execSync('npm run build', {
          cwd: projectRoot,
          stdio: 'pipe',
          timeout: BUILD_TIMEOUT,
          env: execEnv,
        });
      } catch (buildErr) {
        logger.error(
          { err: buildErr },
          'Build failed after pull — rolling back to known-good commit',
        );
        try {
          const knownGood = fs
            .readFileSync(UPDATE_KNOWN_GOOD_PATH, 'utf-8')
            .trim();
          if (!/^[0-9a-f]{40}$/i.test(knownGood)) {
            logger.error(
              { knownGood },
              'Invalid known-good SHA, skipping rollback',
            );
            process.exit(1);
          }
          execSync(`git reset --hard ${knownGood}`, {
            cwd: projectRoot,
            stdio: 'pipe',
            timeout: PULL_TIMEOUT,
          });
          execSync('npm run build', {
            cwd: projectRoot,
            stdio: 'pipe',
            timeout: BUILD_TIMEOUT,
            env: execEnv,
          });
          logger.info(
            { rolledBackTo: knownGood },
            'Rollback successful, continuing without restart',
          );
          // Clean up pre-update marker — the update failed, so the next
          // boot shouldn't try to compute a changelog from a stale SHA.
          try {
            fs.unlinkSync(PRE_UPDATE_HEAD_PATH);
          } catch {
            /* may not exist */
          }
          if (queue) queue.unquiesce();
          return; // Don't exit — we're back on known-good code
        } catch (rollbackErr) {
          logger.fatal(
            { err: rollbackErr },
            'Rollback also failed — exiting for manual intervention',
          );
          process.exit(1);
        }
      }

      logger.info(
        { newHead, prePullSha: pullResult.prePullSha },
        'Auto-update rebuild complete, restarting',
      );
      process.exit(0);
    } catch (err) {
      // If we quiesced but failed to update, re-open the queue so normal
      // processing resumes.
      if (queue) queue.unquiesce();
      logger.error({ err }, 'Auto-update check failed');
    } finally {
      maintainWorktrees();
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
