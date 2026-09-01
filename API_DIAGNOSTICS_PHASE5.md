# Phase 5 Enhancement #2 — Per-request / per-workspace diagnostics

This build adds a central diagnostics layer around the existing Azure DevOps API reliability client.

## What is captured

For each workspace fetch operation:
- workspace name
- operation number
- start/completion time and duration
- logical request count
- successful request count
- failed request count
- retry count
- pagination page count
- cancellation state
- pagination truncation state
- per-request operation label and HTTP status
- attempts and retries per request
- request duration
- final outcome
- failure message and retryability

## UI

After a fetch finishes, the workspace status bar exposes **Diagnostics**. It opens a side panel containing:
- summary counters
- every logical API request made during the operation
- attempts/retries and duration
- detailed failure messages when applicable

The diagnostic state is kept separately for each workspace, so moving between workspaces does not overwrite the last completed diagnostic snapshot for another workspace.

## Design notes

- The existing retry, timeout, cancellation, pagination and concurrency behavior is preserved.
- A logical API request is counted once even when it requires multiple retry attempts.
- Operation names are supplied by callers when available and otherwise derived from the Azure DevOps REST path.
- No PAT is persisted by this diagnostics layer.
