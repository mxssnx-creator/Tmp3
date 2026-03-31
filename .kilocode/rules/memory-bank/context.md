# Context

## 2026-03-31
- Updated QuickStart engine setup to explicitly assign and enable connection state during quickstart.
- QuickStart now writes assignment/activation flags (`is_active_inserted`, `is_dashboard_inserted`, `is_enabled_dashboard`, `is_assigned`, `is_active`) before startup checks.
- Updated quickstart readiness/selection checks to rely on Main Connections assignment (`is_assigned`) for startup flow eligibility.
- Updated quickstart user-facing wording to refer to Main Connections (assignment-based) instead of Active panel terminology.
- Updated quickstart runtime variable naming to use "main" wording for main-connection enablement checks.
- Removed "quickstart_engine_not_started" passive branch so quickstart attempts engine startup directly when credentials/testing pass.
- Updated `nextSteps` messaging to reflect automatic assignment/enabling behavior.
