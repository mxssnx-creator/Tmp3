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
- Removed duplicate route-group pages under `app/(main)` to avoid Next.js traced-file copy failures for `page_client-reference-manifest.js` during standalone/deployment builds.
- Fixed React runtime crash (`Minified React error #321`) by removing invalid hook calls inside `useEffect` in live-trading/strategies/indications pages and subscribing via hooks at top level.
- Hardened SSE hook behavior to safely skip empty connection IDs and correctly recreate client subscriptions per connection change.
- Adjusted shell/header spacing with light paddings and non-overflowing trigger placement to keep menu-button/title alignment stable across pages.
- Updated top-layer style to align with reference layout pattern (header-level `SidebarTrigger` + separator), removing shell-overlay trigger so header/title/menu alignment is consistent across pages using `PageHeader`.
- Fixed appearance switching effectiveness by mounting `StyleInitializer` globally and adding concrete CSS theme/style variant rules in `app/globals.css` so theme/style toggles visibly affect UI.
- Removed the top Global Trade Coordinator info box from the main dashboard as requested.
- Improved monitoring/services/modules status reliability by normalizing boolean-like API payload values (`"true"/"false"`, `"online"/"offline"`, `1/0`) before rendering status badges.
- Re-enabled trade-engine synchronization in `trade-engine-auto-start` monitor by invoking coordinator `refreshEngines()` whenever global state is running (recovers missed toggles/restarts).
- Expanded `/api/trade-engine/diagnostic` with runtime/global-state/data-coverage details (market data, prehistoric, engine-state keys, coordinator active engines) for deeper engine troubleshooting.
- Fixed `/api/trade-engine/functional-overview` to use assigned+enabled connection filtering and robustly parse strategy-set counts from both `strategies:*` and `strategy_set:*` key formats.
- Enforced hierarchy outputs for strategy/pseudo summaries in detailed logs (`base` much higher than `main`, `real` below `main`) and exposed raw counts for debugging.
- Updated strategy set defaults and thresholds so Base produces substantially more candidates than Main, while Real remains the strictest/lowest volume tier.

- Added backward-compatible `PUT` handler alias for `/api/settings/connections/{id}/toggle-dashboard` so legacy clients no longer fail with 405 when enabling/disabling processing.
- Corrected complete-workflow API documentation to list `POST /api/settings/connections/{id}/toggle-dashboard` as the canonical toggle endpoint.
- Added high-performance sync-range coordination in `DataSyncManager` with merged coverage intervals and true missing-range detection, enabling partial backfills instead of full reloads.
- Updated symbol data loading to fetch/store only missing market-data ranges, append range metadata, and keep incremental sync logs for faster repeated runs.
- Integrated preset historical loading with batched symbol coordination, `DataSyncManager` range checks, per-range sync logging, and progression events for large-scale backfill visibility.

## 2026-04-23
- Added Add Database recipe at `.kilocode/recipes/add-database.md` for data persistence guidance.
- Updated memory bank structure to organize optional feature guides.
- Feature documentation now follows recipes pattern with update checklists.
- Added connection state management references to quickstart documentation.
- Updated memory bank context tracking for feature implementation status.

## Update Procedures

### After Implementing New Features
1. Update this context file with implementation date and description
2. Add feature reference in AGENTS.md table
3. Update relevant rules in `.kilocode/rules/` directory
4. Mark checklist items as complete in recipe files
5. Update quickstart readiness checks if needed

### Memory Bank File Locations
- Context file: `.kilocode/rules/memory-bank/context.md`
- Feature guides: `.kilocode/recipes/`
- Feature references: `AGENTS.md`
- Rules documentation: `.kilocode/rules/<category>/`
