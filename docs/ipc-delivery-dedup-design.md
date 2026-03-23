# IPC Delivery Dedup + Error Observability

## Date: 2026-03-23

## Problem: Duplicate Message Delivery

When a container agent sends a reply via IPC `send_message` MCP tool then
crashes (exit code 137/OOM), the system did not know output was already sent.
It rolled back the cursor and retried, causing the user to receive two
responses for the same message.

### Root Cause

Two independent output paths exist in the same Node.js process:

1. **Streaming stdout path**: Container emits `OUTPUT_START_MARKER` on stdout
   -> parsed in `container-runner.ts` -> `onOutput` callback in
   `processGroupMessages` -> sets `outputSentToUser = true`

2. **IPC file path**: Container writes JSON to
   `data/ipc/{group}/messages/*.json` -> `startIpcWatcher` in `ipc.ts` polls
   every 1000ms -> sends message -> **did NOT signal back** to
   `processGroupMessages`

When a container crashed (exit != 0), `processGroupMessages` checked
`outputSentToUser` which was `false` (only set by stdout path), rolled back
the cursor, and scheduled a retry -- re-sending the same prompt to a new
container.

### Why EventEmitter Alone Fails

Initial plan was to use a Node.js EventEmitter as a signal bridge. Codex
review identified critical flaws:

- **Timing**: IPC watcher polls every 1s; container close resolves
  immediately. The emitter fires too late.
- **Coarse correlation**: Group-scoped events allow cross-contamination
  between message lane and task lane in the same group.
- **Not durable**: In-memory only, doesn't survive host crash.

### Solution: Per-Run Correlation + Grace Window

1. `runId` (UUID from `run_ledger`) written to `reply_context.json`
2. Container includes `runId` in IPC message files
3. IPC watcher records delivery ack keyed by `runId` after successful send
4. After container error, `processGroupMessages` waits
   `IPC_POLL_INTERVAL + 200ms` for delivery ack before rollback decision
5. Per-run matching prevents cross-contamination between lanes/groups

### Key Files

- `src/delivery-ack.ts` -- In-memory `Map<runId, timestamp>` for fast ack lookups
- `src/ipc.ts:150-153` -- Records ack after successful message send
- `src/index.ts:539-568` -- Grace window + `wasDelivered()` check
- `container/agent-runner/src/ipc-mcp-stdio.ts` -- Reads and propagates `runId`

---

## Problem: Runtime Error Opacity

Container errors (like `browser-use` AttributeError, OOM kills) were buried in
individual log files under `groups/{group}/logs/`. No quick way to query recent
failures.

### Solution: Enriched run_ledger

New columns on `run_ledger` table:

| Column | Type | Purpose |
|--------|------|---------|
| `stderr_excerpt` | TEXT | Last ~200 chars of stderr from container |
| `exit_code` | INTEGER | Container exit code (137=OOM, 1=error) |
| `duration_ms` | INTEGER | How long the container ran |
| `log_file` | TEXT | Path to full container log file |
| `ipc_delivered` | INTEGER | Whether IPC delivery was confirmed |

### Query Examples

Recent errors across all groups:
```sql
SELECT id, group_folder, status, exit_code, ipc_delivered,
       substr(error, -200), updated_at
FROM run_ledger
WHERE error IS NOT NULL OR exit_code IS NOT NULL
ORDER BY updated_at DESC LIMIT 10;
```

Errors for a specific group:
```sql
SELECT * FROM run_ledger
WHERE (error IS NOT NULL OR exit_code IS NOT NULL)
  AND group_folder = 'main'
ORDER BY updated_at DESC LIMIT 10;
```

Note: The query covers both `failed` AND `acked`-with-error runs (containers
that sent output but then crashed).

### Programmatic Access

```typescript
import { getRecentErrors, getErrorsByGroup } from './run-ledger.js';

// All recent errors
const errors = getRecentErrors(20);

// Per-group errors
const mainErrors = getErrorsByGroup('main', 10);
```

---

## Architecture Diagram

```
Container                    Host Process
---------                    ------------
  |                            |
  | write IPC file             |
  | {type:'message',           |
  |  runId:'abc-123',          |
  |  text:'response'}          |
  |                            |
  | exit(137) OOM              |
  |                            |
  |          container.on('close')
  |          runAgent resolves {status:'error'}
  |          |
  |          | outputSentToUser? -> NO
  |          | await grace window (1200ms)
  |          |
  |          |   IPC watcher polls (1000ms cycle)
  |          |   reads IPC file
  |          |   sends message to user
  |          |   recordDeliveryAck('abc-123')
  |          |
  |          | wasDelivered('abc-123')? -> YES
  |          | skip rollback, mark 'acked'
  |          v
```

---

## PR Reference

- PR #26: https://github.com/BuWH/nanoclaw/pull/26
- Branch: `fix/ipc-delivery-ack-dedup`
