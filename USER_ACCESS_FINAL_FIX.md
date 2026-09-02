# Final User Access Fix

## Specific-user lookup
Specific-user mode no longer uses Graph:
`Memberships/{userDescriptor}?direction=Up`

as its primary project-access lookup.

It now:
1. Enumerates the verified project-level groups and teams.
2. Resolves their project-scoped members.
3. Filters those records by the requested email/display name/descriptor.
4. Returns only the selected user's project memberships.

This prevents AAD-backed Graph descriptor 404s from incorrectly producing
zero project access when the user is actually a member of a project group/team.

## API versions
- Azure DevOps stable APIs: 7.1
- Azure DevOps Graph APIs: 7.1-preview.1

Graph endpoints in User Access use `ACCESS_GRAPH_API_VERSION`.
No Graph descriptor/user-membership call in the specific-user path uses stable 7.1.

## Browser cache
index.html cache-busts the User Access module with:
`?v=20260901-user-access-final`
