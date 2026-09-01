# User Access Identity Resolution V2

## Scope
This release fixes specific-user User Access resolution without changing the project-level membership source.

## Changes
- Added a canonical Azure DevOps identity model preserving `id`, `originId`, `descriptor`, `uniqueName`, `principalName`, and mail fields.
- Specific-user lookup now resolves the requested identity first through the Azure DevOps Identities API.
- Graph user lookup is used to enrich the resolved identity when available; failure of Graph user lookup does not discard the authoritative identity returned by Identities.
- Removed partial-name and email-local-part matching from specific-user membership filtering.
- Specific-user membership rows now match primarily by Azure DevOps identity ID, origin ID, or descriptor.
- Email/uniqueName/principalName are controlled fallbacks only when membership payloads omit identity identifiers.
- Exact display-name lookup is accepted only when the result is unique; arbitrary candidate selection is avoided.
- Preserved identity identifiers on team and group membership rows so they are available to the user-specific filter.
- Deduplication now prefers authoritative identity keys instead of display names.
- Successful user resolution reports the match method and confidence in the workspace status message.
- Updated the User Access script cache-buster in `index.html`.

## Expected behavior
For an input such as `manoj.dangi@cornerstone-bb.com`, the application resolves the Azure DevOps identity first and then finds that exact identity in the project team/group membership rows. If the user has no membership, the result is `0` memberships without incorrectly reporting an API error.

## API versions
- Graph: `7.1-preview.1`
- Stable Identities/Projects/Teams APIs: `7.1`
