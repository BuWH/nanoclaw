# Post-Output OOM Fix (March 29, 2026)

## Problem

Containers were OOMing (exit 137) **after successfully delivering results**, during the idle timeout period. Even with session resume working correctly (orphan JSONL cleanup fix from March 28), the 8GB memory limit was being exceeded.

### Crash Example (March 28 00:10 CST)

```
Timestamp: 2026-03-28T16:10:35.419Z
Group: main
Duration: 270584ms (~4.5 minutes)
Exit Code: 137 (OOM kill)
Session ID: fec2a8d9-38cf-4a8d-bf3f-07ffb0420c78 (RESUMED, not new)
```

**Key observation**: Result was delivered successfully, then container was killed during idle wait.

### Root Cause Analysis

1. **8GB limit is tight for complex queries** involving:
   - Subagent spawning (`system/task_started`) - each subagent is an additional Node.js process
   - Multiple MCP servers (nanoclaw, tavily, notion, things) running simultaneously
   - Large context from X search results and web scraping
   - Multiple tool call chains in a single query

2. **Post-output idle period** - The container stays alive for 120 seconds after delivering the result. During this idle time, memory isn't released and GC pressure builds until OOM.

## Solution

**Reduce IDLE_TIMEOUT**

**File**: `src/config.ts`

```
IDLE_TIMEOUT: 120000 → 60000 (2min → 1min)
```

**Why**: Containers exit faster after delivering results, reducing exposure to post-output OOM. The 2-minute wait was allowing memory pressure to build during idle.

## Expected Impact

1. **Faster container recycling** - 1min idle timeout reduces post-output memory exposure
2. **Reduced OOM risk** - Containers spend less time idle with allocated memory

## Testing

Use HTTP test channel with complex queries like:
```
curl -X POST http://localhost:3100/message \
  -d '{"text":"介绍一下 karpathy 的 autoresearch 项目。X 上搜集一些最佳实践","jid":"http:test-main"}'
```

Verify:
- Container exits with code 0 (not 137)
- Result is delivered
- Session ID is preserved between runs (resume, not new)

## Related

- `docs/2026-03-28-oom-crash-investigation.md` - Original OOM investigation (orphan JSONL cleanup)
- Commit `09f363c` - Removed unnecessary OOM workarounds (12g limit, NODE_OPTIONS), keeping only root cause fix
