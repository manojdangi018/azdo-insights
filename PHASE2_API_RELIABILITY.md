# AZDO Insights — Phase 2 API Reliability

## Implemented

1. Central API retry with exponential backoff and jitter.
2. HTTP 429 handling with Retry-After / x-ms-retry-after-ms support.
3. HTTP 5xx handling with bounded automatic retries.
4. Per-request timeout (30 seconds by default).
5. Operation-level cancellation using AbortController and a visible Cancel button while a workspace scan is running.
6. Shared continuation-token pagination framework with a 200-page safety limit.
7. Pagination applied to project, repository, branch/ref, pull-request, service-connection, agent-pool/agent, graph-group/membership, team/member, user-activity, pipeline-definition/build, and user-entitlement list APIs.
8. Central request concurrency limit of 6 active Azure DevOps requests.
9. Partial-result reporting when one or more API calls fail or pagination reaches the safety limit.
10. Work-item detail retrieval now processes all WIQL IDs in Azure DevOps-supported batches of 200 instead of truncating to the first 200.

## Compatibility

- Existing workspace rendering and detail popups are preserved.
- PAT remains memory-only; it is not stored in localStorage or sessionStorage.
- Existing Excel exports remain available.
- The existing Phase 1 context-aware HTML sanitizer remains in place.

## Defaults

- API version: 7.1
- Max retries: 3 retries after the initial request
- Request timeout: 30 seconds
- Max concurrent requests: 6
- Max pagination pages per list operation: 200
- Work-item detail batch size: 200 IDs

## Cancellation behavior

Cancelling a workspace scan aborts queued and active API requests for that operation. Already retrieved data is retained and the operation reports that it was cancelled.
