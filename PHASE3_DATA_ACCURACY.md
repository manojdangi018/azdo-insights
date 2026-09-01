# Phase 3 — Data Accuracy

Implemented on the Phase 2 API-reliability baseline.

- User activity commits resolve branch names from Azure DevOps push/ref-update metadata instead of assuming the repository default branch.
- Pipeline identities use `type:id` keys so YAML and classic pipelines with the same display name are not merged.
- Pipeline trigger classification uses Azure DevOps reason/trigger metadata with explicit categories and preserves the raw reason.
- Work-item KPIs use Azure DevOps work-item-type state categories, while charts retain the actual state names returned by Azure DevOps.
- Repository stale-branch threshold is configurable from 30/60/90/180/365 days.
- User matching is normalized across display name, email, UPN, account name and tokenized variants.
- Branch policy evaluation filters deleted/disabled policies, evaluates repository/ref scopes more explicitly, tracks blocking policies and required-reviewer metadata, and avoids assuming unscoped fallback policies protect every branch.
