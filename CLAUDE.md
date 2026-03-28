# NanoClaw Development Guide

## Architecture

NanoClaw is a multi-channel AI agent orchestrator. Host process (Node.js/TypeScript) manages messaging channels (Telegram, WhatsApp) and spawns Docker containers for each agent task. Containers run the Claude Agent SDK with MCP tools, communicating results via IPC files.

```
Host Process (src/index.ts)
  |-- Channel adapters (Telegram, WhatsApp, HTTP Test)
  |-- GroupQueue (concurrency management)
  |-- IPC Watcher (file-based communication)
  |-- Container Runner (Docker spawn)
  |-- Credential Proxy (API key injection)
  |
  v
Docker Container (container/agent-runner/src/index.ts)
  |-- Claude Agent SDK (query loop)
  |-- MCP Server (ipc-mcp-stdio.ts)
  |-- browser-agent (Python/Chromium, optional)
```

Key files:
- `src/index.ts` -- Host entry point, message loop, container orchestration
- `src/container-runner.ts` -- Docker spawn, stdin/stdout protocol, timeout handling
- `src/group-queue.ts` -- Priority queue, concurrency limits, idle management
- `src/ipc.ts` -- File-based IPC watcher, dispatches to handlers
- `src/session-rotation.ts` -- Session lifecycle, JSONL cleanup, rotation
- `src/channels/http-test.ts` -- HTTP test channel for automated E2E verification
- `container/agent-runner/src/index.ts` -- In-container agent loop
- `container/agent-runner/src/ipc-mcp-stdio.ts` -- Container-side MCP tools

## Critical: Container Memory

Container OOM (exit 137) is the most common failure mode. Read `docs/2026-03-28-oom-crash-investigation.md` for the full investigation.

Key rules:
- **Session continuity is paramount**. A `resume` session uses 2-4GB less peak memory than a `new` session. If the session is lost (crash without save), the container enters a vicious cycle of new-session -> OOM -> new-session.
- **Orphan JSONL cleanup** runs before each spawn (`cleanupOrphanSessionFiles`). Never skip this.
- **Memory limit** is 8GB default (`CONTAINER_MEMORY_LIMIT`). Sufficient when sessions are properly resumed.
- **Host-side IPC** is the pattern for tools that need host resources. See `src/x-ipc.ts`, `src/chrome-ipc.ts`.

## Verification: HTTP Test Channel (Mandatory)

An HTTP test channel runs on `localhost:3100` alongside Telegram. It is the **primary way to verify changes** before asking the user to test via Telegram.

### When to Use

**ALWAYS use the HTTP test channel to verify** any change that affects:
- Container startup, memory, or session handling
- MCP tool behavior (send_message, x_scrape_tweet, browse_web, etc.)
- Message routing, formatting, or delivery
- IPC handlers (browser_, x_, chrome_, codex_)
- Agent behavior (CLAUDE.md changes, skill changes)
- Anything that could cause a container crash

**Only ask the user to verify via Telegram** when:
- Testing Telegram-specific features (buttons, formatting, /commands)
- Testing multi-channel routing between Telegram and another channel
- The HTTP test channel itself is broken

### API Reference

```bash
# Health check
curl http://localhost:3100/health

# Send a message (triggers full pipeline: DB -> queue -> container -> SDK -> reply)
curl -X POST http://localhost:3100/message \
  -H 'Content-Type: application/json' \
  -d '{"text": "What is 2+2?", "jid": "http:test-main"}'

# Wait for reply (long-poll, blocks until reply arrives or timeout)
curl "http://localhost:3100/wait?timeout=120&since=0"

# Get all collected replies
curl http://localhost:3100/replies

# Clear reply buffer
curl -X POST http://localhost:3100/clear
```

### Feedback Loop Protocol

After making code changes, follow this loop:

```
1. bun test                          # Unit tests pass?
2. npx tsc --noEmit                  # Type check pass?
3. npm run build                     # Host build
4. bash container/build.sh           # Container image (if agent-runner changed)
5. launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # Restart service
6. sleep 8                           # Wait for startup
7. curl http://localhost:3100/health  # Channel alive?
8. curl -X POST http://localhost:3100/clear  # Clear old replies
9. curl -X POST http://localhost:3100/message \
     -d '{"text":"<test prompt>","jid":"http:test-main"}'
10. curl "http://localhost:3100/wait?timeout=120&since=0"
    # Check: reply arrived? No exit 137 in logs?
11. Check logs:
    tail -20 logs/nanoclaw.log       # Host-side errors?
    ls -lt groups/http_test-main/logs/ | head -3  # Container exit code?
```

If step 10 returns an empty array or the container log shows exit 137, the change has a problem. Fix it and re-run the loop. Do NOT ask the user to test via Telegram until the HTTP channel loop passes.

### Configuration

- **Port**: Set `HTTP_TEST_PORT=3100` in `.env`
- **Group JID**: `http:test-main` (registered in DB as `http_test-main` folder)
- **Group folder**: `groups/http_test-main/` (has its own CLAUDE.md, logs, conversations)
- **Trigger**: None required (`requires_trigger = 0`), all messages processed
- **Source**: `src/channels/http-test.ts`

### Logs

Container logs for the HTTP test group are at:
```
groups/http_test-main/logs/container-*.log
```

Each log contains: exit code, duration, container args, mounts, stderr (agent-runner output), stdout (SDK output markers). Check these after every test run to verify no OOM (exit 137).

## Testing

### Run Tests
```bash
bun test                    # All tests
bun test -- --watch         # Watch mode
bun test -- src/e2e-real-container.test.ts  # Real Docker E2E
npx tsc --noEmit            # Type check only
```

### Test Architecture
- **Unit tests** (`*.test.ts`): Mock-based, fast, no Docker needed
- **E2E tests** (`e2e.test.ts`): Full pipeline with fake channels and mocked containers
- **Real container tests** (`e2e-real-container.test.ts`): Spawns actual Docker containers, auto-skips if Docker unavailable
- **HTTP test channel**: Full end-to-end through the live service (message -> container -> SDK -> reply)

### What to Test After Changes

| Change area | Unit tests | HTTP channel verification |
|-------------|-----------|--------------------------|
| Container runner / spawn args | `container-runner.test.ts` | Send message, check container log for correct args |
| Session rotation / cleanup | `session-rotation.test.ts` | Send message, verify session reused (not "new") |
| IPC handlers | `x-ipc.test.ts`, `ipc-auth.test.ts` | Send message that triggers MCP tool |
| Agent behavior / CLAUDE.md | N/A | Send message, verify reply content |
| Message routing | `routing.test.ts` | Send message, verify reply arrives |
| Memory / OOM fixes | `session-rotation.test.ts` | Send message, check exit code != 137 |

## Development Workflow

### Build & Deploy
```bash
npm run build               # Compile TypeScript (host)
bash container/build.sh     # Rebuild Docker image (picks up agent-runner changes)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # Restart service
```

### Key Directories
```
src/              Host-side TypeScript source
container/        Docker image (Dockerfile, agent-runner, browser-agent, skills)
groups/           Per-group workspace (CLAUDE.md, conversations, logs)
data/             Runtime data (sessions, IPC, browser-state, DB)
store/            SQLite database (messages.db)
docs/             Architecture docs, investigation reports
```

### IPC Pattern (for new host-side tools)

When adding a tool that needs resources outside the container (Chromium, native APIs, host filesystem):

1. Add MCP tool in `container/agent-runner/src/ipc-mcp-stdio.ts` (container calls this)
2. Create `src/<name>-ipc.ts` handler (host runs the actual work)
3. Register dispatch in `src/ipc.ts` (match on type prefix)
4. Container writes to `/workspace/ipc/tasks/`, host writes result to `/workspace/ipc/<group>/<name>_results/`

Follow `src/browser-ipc.ts` or `src/chrome-ipc.ts` as templates.

## Debugging

```bash
# Service logs (pino JSON format)
tail -f logs/nanoclaw.log | npx pino-pretty

# Container crash logs (main group)
ls -lt groups/main/logs/ | head -5
cat groups/main/logs/<file>.log

# Container logs (HTTP test group)
ls -lt groups/http_test-main/logs/ | head -5

# Check session state
sqlite3 store/messages.db "SELECT * FROM sessions;"
sqlite3 store/messages.db "SELECT * FROM router_state;"

# Check session transcript size
du -sh data/sessions/main/.claude/projects/

# Check for orphan JSONL files
ls -lh data/sessions/main/.claude/projects/-workspace-group/*.jsonl

# Docker memory
docker stats --no-stream
docker info | grep "Total Memory"

# HTTP test channel
curl http://localhost:3100/health
curl http://localhost:3100/replies
```
