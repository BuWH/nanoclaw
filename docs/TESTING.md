# NanoClaw Test Documentation

## Overview

- Test framework: Vitest 4.x
- Run all: `npx vitest run`
- Run specific: `npx vitest run src/delivery-ack.test.ts`
- Run with coverage: `npx vitest run --coverage`

## Test Categories

### Unit Tests

Tests isolated modules with no external dependencies.

| File | Module | Tests | Key Scenarios |
|------|--------|-------|---------------|
| delivery-ack.test.ts | delivery-ack.ts | 6 | Map lifecycle, TTL eviction, run isolation, idempotent recording |
| formatting.test.ts | formatting.ts | 33 | XML escaping, message formatting, trigger pattern matching, internal tag stripping, outbound formatting, trigger gating |
| group-folder.test.ts | group-folder.ts | 5 | Folder name validation, path traversal rejection, safe path resolution |
| timezone.test.ts | timezone.ts | 2 | UTC-to-local conversion, multi-timezone support |
| container-runtime.test.ts | container-runtime.ts | 8 | Readonly mount args, stop command, runtime detection, orphan cleanup |
| auto-update.test.ts | auto-update.ts | 9 | Changelog computation, HEAD marker persistence, dedup guard, startup flow |
| sender-allowlist.test.ts | sender-allowlist.ts | 19 | Allowlist loading, allow/deny logic, per-chat overrides, trigger filtering, drop mode |
| session-rotation.test.ts | session-rotation.ts | 10 | Transcript size calculation, rotation threshold, context file generation |
| task-scheduler.test.ts | task-scheduler.ts | 4 | Invalid folder pausing, interval drift prevention, once-task handling, missed interval skip |
| git-lock.test.ts | git-lock.ts | 18 | Lock acquire/release, stale lock detection, withGitLock retry, PID ownership |
| ipc-watcher.test.ts | ipc-watcher.ts | 1 | Directory listing with withFileTypes, error handling |

### Integration Tests

Tests module interactions with real SQLite DB or multi-module coordination.

| File | Modules | Tests | Key Scenarios |
|------|---------|-------|---------------|
| run-ledger.test.ts | run-ledger.ts + db.ts | 38 | State machine transitions, dead letters, retry, history, stats, pruning, error metadata columns, getRecentErrors, getErrorsByGroup, acked-with-error visibility |
| db.test.ts | db.ts | 23 | Message CRUD, query limits, chat metadata, task CRUD, registered group isMain |
| ipc-auth.test.ts | ipc.ts + db.ts | 35 | Authorization matrix for IPC operations (schedule/pause/resume/cancel task, register/refresh groups, restart, message send, cron/interval/once schedules, context_mode) |
| routing.test.ts | routing.ts + db.ts | 14 | JID ownership patterns (WhatsApp, Telegram), group listing, registration marking, mixed-platform ordering |
| credential-proxy.test.ts | credential-proxy.ts | 5 | API-key injection, OAuth replacement, hop-by-hop header stripping, upstream error handling |
| op-ipc.test.ts | op-ipc.ts | 11 | 1Password IPC: get_item, get_otp, field filtering, error handling, non-main group blocking |
| x-ipc.test.ts | x-ipc.ts | 37 | X/Twitter IPC: script spawning, process group kill, JSON parsing, tweet cache CRUD/TTL/pruning |
| x-health.test.ts | x-health.ts | 26 | Health check, version detection, auto-update flow, interval scheduling |
| remote-control.test.ts | remote-control.ts | 17 | Session spawning, file descriptor management, state persistence, restore/stop lifecycle |
| group-queue.test.ts | group-queue.ts | 32 | Per-group concurrency, global slot limits, task/message lanes, preemption, priority queue, idle detection, shutdown |
| channels/registry.test.ts | channels/registry.ts | - | Channel registry operations |
| channels/telegram.test.ts | channels/telegram.ts | - | Telegram channel adapter |

### E2E Tests (Mock Container)

Tests full message pipeline with mocked Docker spawn.

| File | Pipeline | Tests | Key Scenarios |
|------|----------|-------|---------------|
| e2e.test.ts | message -> format -> container -> reply | 5 | Basic pipeline, multi-message formatting, internal tag stripping, container error, timeout |
| e2e-ipc.test.ts | container crash -> error metadata -> dedup | 6 | Streaming output + crash (no dup), crash without output (error fields populated), exitCode/durationMs/stderrTail/logFile presence, run_ledger error metadata queries |
| e2e-queue.test.ts | multi-group scheduling -> priority | 11 | Concurrency, main-group priority, soft reserve, preemption, task/message coexistence, queue metrics, error slot recovery, burst handling |
| container-runner.test.ts | container spawn -> timeout/output -> exit | 4 | Timeout after output (success), timeout without output (error), normal exit, error exit metadata (exitCode, durationMs, stderrTail, logFile) |

### E2E Tests (Real Container)

Tests with actual Docker containers. Skipped when Docker unavailable.

| File | What's Real | Tests | Key Scenarios |
|------|-------------|-------|---------------|
| e2e-real-container.test.ts | Docker, filesystem I/O | 4 | IPC file structure, delivery ack recording, multi-runId isolation, missing runId handling |

## Mock Patterns

- **config.js**: Test paths (`/tmp/nanoclaw-test-*`), short timeouts (5s vs 30min)
- **logger.js**: Silent (`vi.fn()` for debug/info/warn/error)
- **fs**: Partial mock (`existsSync`, `mkdirSync`, `writeFileSync`, `readFileSync`, etc.)
- **child_process**: Fake EventEmitter process with `stdin`/`stdout`/`stderr` as PassThrough streams
- **mount-security**: Always returns empty (no allowlist check)
- **env.js**: Returns empty env object
- **container-runtime**: Mock Docker commands

## Key Test Helpers

- `_initTestDatabase()`: Fresh in-memory SQLite per test (from `db.ts`)
- `_resetForTest()`: Clear delivery-ack in-memory map (from `delivery-ack.ts`)
- `createFakeProcess()`: Fake Docker process with EventEmitter + PassThrough streams
- `emitOutput(proc, output)` / `emitOutputMarker(proc, output)`: Push marker-wrapped JSON to stdout
- `createRun(type, jid, folder, payload, maxRetries?)`: Test run factory (from `run-ledger.ts`)
- `transitionRun(id, status, updates?)`: State machine transition (from `run-ledger.ts`)

## Adding New Tests

1. Mock system boundaries (config, logger, fs, child_process) -- not business logic
2. Use real SQLite via `_initTestDatabase()` for any DB-touching tests
3. Use real business logic (router, container-runner, delivery-ack, run-ledger)
4. Follow naming: `<module>.test.ts` for unit/integration, `e2e-<feature>.test.ts` for E2E
5. Place `vi.mock()` calls before imports of mocked modules
6. Use `vi.useFakeTimers()` / `vi.useRealTimers()` for timeout-dependent tests
7. Each test file should be self-contained with its own mocks and fixtures
