# Build & Security Notes

## Phase 1 security/correctness updates

- PATs are kept only in the password input / JavaScript memory for the active browser session.
- PATs are never written to `localStorage` or `sessionStorage`.
- The "Remember organization only" option stores only the Azure DevOps organization name in `localStorage`.
- Legacy `azdo_pat` and `azdo_session_pat` values are no longer read by the application. Users should clear old browser storage from previous builds if those keys were created by an older version.
- All dynamic HTML insertion is routed through shared sanitization helpers in `m1`. API-originated text is also escaped in modules that build badges/labels directly.
- Azure DevOps API version is centralized in `AZDO_API_VERSION` in `m1`.
- API errors now preserve HTTP status and, where available, Azure DevOps ActivityId/RequestId details.
- The Access export button is backed by `exportAccessToXLSX()`.
- Work Item WIQL fallback preserves the selected user filter instead of silently broadening the query to the whole project.
- Branch-policy fallback matching only treats a `defaultBranch` scope as applicable when the inspected branch is the repository's actual default branch, and it no longer treats an unscoped fallback policy as protecting every branch.

## Important security limitation

This is still a browser-only application. A PAT must be supplied to the browser to call Azure DevOps directly. Keeping the PAT out of browser storage reduces persistence/exposure risk, but it does not make a frontend PAT fundamentally secret from browser code or browser extensions.

For stronger enterprise security, a future phase should move Azure DevOps authentication behind a backend service or use an appropriate delegated OAuth/Entra ID flow.

### Phase 1.1 regression fix
- Safe HTML rendering is context-aware for table elements (`tbody`, `thead`, `tfoot`, `tr`, `td`, `th`) so sanitization does not strip or flatten valid table rows/cells.
- API-originated values remain protected by the shared HTML sanitization layer while preserving existing table rendering behavior.
