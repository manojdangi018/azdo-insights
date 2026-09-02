# Phase 5 Final Audit — API Versions and User Access

## API version policy

- Core/Build/Git/WIT/Teams/Service Endpoint APIs: `7.1` through `AZDO_STABLE_API_VERSION`.
- Azure DevOps Graph APIs: `7.1-preview.1` through `AZDO_GRAPH_API_VERSION`.
- Identities API: `7.1`.
- User Access Graph calls (users, groups, memberships, descriptors, membership states): `7.1-preview.1`.

## User Access behavior

### Project mode
Blank User field returns:
- Active Scope = selected project
- Total Teams = all project teams
- Total Groups = project-scoped Graph security groups
- Total Members = unique users across returned groups and teams
- Status = Active
- Bar chart = members per group/team
- Rows = Group/Team Name, Type/Scope, User Display Name, User Principal/Email

Nested security groups are expanded up to five levels and users are de-duplicated.

### Specific-user mode
A supplied email/display name is resolved through the stable Identities API, then:
- Graph membership `direction=Up` is used for project security-group membership.
- Project team membership is checked against each project team.
- Active/inactive state is read from Graph Membership States.
- KPI cards show Teams, Groups, Total Memberships, and Status.
- Chart shows the user's membership in each group/team.
- Rows contain only that user's project memberships.

Azure DevOps does not expose a reliable membership-added date in the Graph membership/state APIs used here, so the application does not fabricate an "active since" date.

## Preserved functionality

- Phase 1 security/XSS protections
- Detail popup/event binding
- Phase 2 retry, 429/5xx handling, timeout, cancellation, pagination, concurrency limiting
- Phase 3 branch/commit accuracy, pipeline identity, trigger classification, dynamic work-item states, stale threshold, identity matching, policy evaluation
- Pipeline duplicate prevention
- Pipeline 5/20/50/100 run selector
- Agent popup Build # and Status
- Advanced Analytics at the bottom of navigation
- Access XLSX export
