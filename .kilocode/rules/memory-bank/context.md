# Context

## 2026-03-31
- Updated QuickStart engine setup to explicitly assign and enable connection state during quickstart.
- QuickStart now writes assignment/activation flags (`is_active_inserted`, `is_dashboard_inserted`, `is_enabled_dashboard`, `is_assigned`, `is_active`) before startup checks.
- Updated quickstart readiness/selection checks to rely on Main Connections assignment (`is_assigned`) for startup flow eligibility.
- Updated quickstart user-facing wording to refer to Main Connections (assignment-based) instead of Active panel terminology.
- Updated quickstart runtime variable naming to use "main" wording for main-connection enablement checks.
- Removed "quickstart_engine_not_started" passive branch so quickstart attempts engine startup directly when credentials/testing pass.
- Updated `nextSteps` messaging to reflect automatic assignment/enabling behavior.
- Fixed dashboard shell/header layout to remove duplicate sidebar trigger and normalize mobile trigger layering.
- Refactored exchange selector UX: removed refresh button, switched to automatic forced load on access, no "Exchange:" label line break, and added dedicated sidebar variant styling.
- Reduced outer wrapper padding on dashboard root to prevent double-wrapping/outer-spacing issues.
- Updated `npm test` to kill previous process on port `3001` and enforce a 90-second timeout.
