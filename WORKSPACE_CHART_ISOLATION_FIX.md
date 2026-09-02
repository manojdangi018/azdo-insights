# Workspace Chart Isolation Fix

## What was fixed
- Chart/KPI display state is now keyed by Organization + Project + Workspace category.
- Switching between workspaces no longer restores a chart from another project/workspace context.
- Switching projects clears the previous project's in-memory telemetry/display state before the new project is loaded.
- The Azure DevOps connection/authentication flow is unchanged.
- API versions, User Access identity resolution, caching/batching, and existing workspace-specific business logic were not changed in this fix.
- Browser cache busting was added to the main application module.

## Expected behavior
Each workspace has its own chart state:
- Repositories & Branches
- Pipelines & Builds
- Service Connections & Agents
- Work Items
- User Activity
- User Access & Permissions
- Organization & Project Users
- Advanced Analytics

For the same workspace, Project A and Project B are also isolated.

## Service Connections & Agents chart
- Agent Pool Inventory uses a vertical bar chart.
- Pool names are on the X-axis.
- Agent Count is on the Y-axis.
- This is implemented without changing chart behavior in other workspaces.
