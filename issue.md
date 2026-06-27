Assignee: yueranyuan

`LUCARNE_ACTIVITY` is read by the engine (src/engine.ts:175, documented in src/types.ts:162)
to set whether a session captures the semantic activity log by default, but it is not
documented in the README — unlike its siblings LUCARNE_HEADLESS / LUCARNE_RECORD. Document
it so users can discover it.

## Acceptance Criteria
- [ ] dev/01 v1 The README documents `LUCARNE_ACTIVITY` near the other `LUCARNE_*` env vars: that setting it to `1` makes sessions capture the semantic activity log by default (default: off).
  - status: pending
