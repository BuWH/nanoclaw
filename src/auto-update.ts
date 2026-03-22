/**
 * Auto-Update Loop
 *
 * Polls origin/main for new commits. When detected:
 * 1. git pull --ff-only
 * 2. npm run build
 * 3. process.exit(0) — launchd KeepAlive restarts the process
 *
 * This enables a safe self-modification workflow where the agent creates PRs,
 * the user reviews and merges, and NanoClaw picks up changes automatically.
 */

import { execSync } from 'child_process';

import { logger } from './logger.js';

const AUTO_UPDATE_INTERVAL = 60_000; // 60 seconds
const STARTUP_DELAY = 30_000; // Wait 30s after startup before first check
const FETCH_TIMEOUT = 30_000;
const PULL_TIMEOUT = 60_000;
const BUILD_TIMEOUT = 120_000;

export function startAutoUpdateLoop(): void {
  const projectRoot = process.cwd();

  const check = () => {
    try {
      execSync('git fetch origin main', {
        cwd: projectRoot,
        stdio: 'ignore',
        timeout: FETCH_TIMEOUT,
      });

      const local = execSync('git rev-parse HEAD', {
        cwd: projectRoot,
        encoding: 'utf-8',
      }).trim();

      const remote = execSync('git rev-parse origin/main', {
        cwd: projectRoot,
        encoding: 'utf-8',
      }).trim();

      if (local === remote) return;

      logger.info(
        { localCommit: local.slice(0, 8), remoteCommit: remote.slice(0, 8) },
        'New commits on main detected, pulling and rebuilding',
      );

      execSync('git pull --ff-only origin main', {
        cwd: projectRoot,
        stdio: 'pipe',
        timeout: PULL_TIMEOUT,
      });

      execSync('npm run build', {
        cwd: projectRoot,
        stdio: 'pipe',
        timeout: BUILD_TIMEOUT,
      });

      logger.info('Auto-update rebuild complete, restarting');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Auto-update check failed');
    }
  };

  setTimeout(() => {
    check();
    setInterval(check, AUTO_UPDATE_INTERVAL);
  }, STARTUP_DELAY);

  logger.info(
    { intervalMs: AUTO_UPDATE_INTERVAL, startupDelayMs: STARTUP_DELAY },
    'Auto-update loop started',
  );
}
