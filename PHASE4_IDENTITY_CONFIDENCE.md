# Phase 4 — Confidence-Based Identity Matching

## Scope
This enhancement replaces the previous fuzzy/substring identity matching used by the shared identity helpers with deterministic confidence-based matching.

## Compatibility
- Azure DevOps API endpoints and API versions are unchanged.
- User Access identity-resolution flow is unchanged.
- API caching/batching is unchanged.
- Workspace chart isolation is unchanged.
- Existing exported function name `identityMatchesQuery()` remains available for compatibility.

## Matching policy
| Match | Confidence | Result |
|---|---:|---|
| Exact Azure DevOps ID / descriptor / originId | 100% | Accepted |
| Exact email / UPN / uniqueName / principalName | 100% | Accepted |
| Exact display name | 95% | Accepted |
| Exact email local-part (query without `@`) | 90% | Accepted |
| Exact complete name tokens (`Manoj Dangi` vs `manoj.dangi`) | 88% | Accepted |
| Partial substring / partial email / partial name | 0% | Rejected |

The default acceptance threshold is **88%**. This prevents inputs such as `manoj.d` or `Manoj` from silently matching a different identity while retaining normal exact email/name searches.

## Workspaces affected
The shared matcher is consumed by User Activity and Organization & Project Users. User Access already uses its own authoritative identity-field matching and was deliberately left unchanged to avoid regression.

## Verification
- JavaScript syntax checked with Node.js.
- Automated matcher cases verified for exact email, case-insensitive email, exact display name, dot-separated name, partial-name rejection, partial-email rejection, and wrong-user rejection.
