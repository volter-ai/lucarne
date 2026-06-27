Assignee: yueranyuan

`LUCARNE_ACTIVITY` is read by the engine (src/engine.ts:175, documented in src/types.ts:162)
to set whether a session captures the semantic activity log by default, but it is not
documented in the README — unlike its siblings LUCARNE_HEADLESS / LUCARNE_RECORD. Document
it so users can discover it.

## Acceptance Criteria
- [x] dev/01 v1 The README documents `LUCARNE_ACTIVITY` near the other `LUCARNE_*` env vars: that setting it to `1` makes sessions capture the semantic activity log by default (default: off).
  - status: passed
  - evidence ev1: commit=d6b338f67adadc3218f69c31fd3ed39dfd921452 acv=1
  - proof: "the commit adds a README paragraph (after the LUCARNE_RECORD recording note) stating the activity log is off by default and that `LUCARNE_ACTIVITY=1` makes sessions capture the semantic activity log by default" -> ev1
