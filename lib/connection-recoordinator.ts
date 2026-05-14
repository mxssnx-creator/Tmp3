/**
 * lib/connection-recoordinator.ts
 *
 * Single source of truth for "the operator just saved connection
 * settings — propagate the change to the engine RIGHT NOW so the next
 * cycle reflects it, no 3 s watcher wait, no page reload."
 *
 * The full propagation has THREE steps and ALL of them must run in the
 * settings API handlers. Before this helper existed the three step were
 * duplicated (and partially missing) across four handlers in two route
 * files, which is exactly why a save-while-stopped (or a save-that-
 * should-stop) silently failed to take effect.
 *
 * Step 1 — `notifySettingsChanged`
 *   Writes a `pending-changes:{id}` envelope to Redis with the diff and
 *   a coarse change-type ("restart" / "reload" / "cosmetic"). Already
 *   running engines pick this up on their 3 s watcher tick. This is the
 *   correctness layer — it MUST run for every change.
 *
 * Step 2 — `applyPendingChangesNow`
 *   Latency optimization: synchronously asks the in-process engine
 *   manager (if any) to consume the pending envelope NOW instead of
 *   waiting for its next watcher tick. No-op if the engine isn't
 *   running in this process.
 *
 * Step 3 — recoordinate (start / stop)
 *   The piece operators kept missing. The engine watcher only runs
 *   for ALREADY-RUNNING engines, so a save while the engine is stopped
 *   (or a save that toggles `is_enabled` off) needed a separate path:
 *     • If the updated connection should now run → `startMissingEngines`.
 *     • If the updated connection should no longer run but IS running
 *       → `stopEngine`.
 *   Both calls are idempotent and safe to invoke even when no action
 *   is needed.
 *
 * Pass the connection BEFORE and AFTER the update so we can detect the
 * field diff correctly. The "after" snapshot is what gets persisted; the
 * "before" snapshot is what was loaded from Redis at the top of the
 * handler.
 */

import { notifySettingsChanged, detectChangedFields } from "@/lib/settings-coordinator"

interface RecoordinateOptions {
  /**
   * When the caller already knows the changed-fields list (e.g. PATCH
   * /settings only receives a partial payload, so `detectChangedFields`
   * may miss settings nested under `connection_settings`), they can
   * pass an explicit override. The diff is still recomputed for the
   * notify envelope, but this list takes precedence when deciding
   * whether to short-circuit.
   */
  changedFieldsOverride?: string[]
  /**
   * Tag for log lines so it's clear which handler initiated the
   * recoordination. e.g. "PATCH /settings", "PUT /connections/[id]".
   */
  logTag: string
}

/**
 * Run the full propagation chain. Designed to never throw — every step
 * is wrapped, so a failure in (say) coordinator import won't cause the
 * settings save itself to return 500. Failures are logged with the
 * provided `logTag` so they surface in the dev console.
 */
export async function recoordinateAfterSettingsChange(
  id: string,
  before: Record<string, any>,
  after: Record<string, any>,
  opts: RecoordinateOptions,
): Promise<void> {
  const detected = detectChangedFields(before, after)
  const changedFields =
    opts.changedFieldsOverride && opts.changedFieldsOverride.length > 0
      ? opts.changedFieldsOverride
      : detected

  if (changedFields.length === 0) {
    return
  }

  // Step 1 — durable notify (Redis envelope read by all running engines).
  try {
    await notifySettingsChanged(id, changedFields, before, after)
  } catch (notifyErr) {
    console.warn(
      `[v0] [${opts.logTag}] notifySettingsChanged failed for ${id}:`,
      notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
    )
    // Continue — the recoordinate step below can still start/stop the
    // engine even if the notify envelope didn't land.
  }

  // Steps 2 & 3 — coordinator-level actions. Bundled in one try block
  // because they all need the same `coordinator` reference, and a
  // failure to load the coordinator module fails both equivalently.
  try {
    const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
    const coordinator = getGlobalTradeEngineCoordinator()

    // Step 2 — in-process fast-path (no-op when engine isn't running here).
    await coordinator.applyPendingChangesNow(id)

    // Step 3 — recoordinate. Decide "should this connection be running
    // right now" using the SAME predicate the boot-time reconciliation
    // sweep uses, so behavior is consistent between (a) page-load
    // sweep, (b) settings save, and (c) toggle endpoints.
    const { isConnectionMainProcessing, hasConnectionCredentials, isTruthyFlag } = await import(
      "@/lib/connection-state-utils"
    )
    const shouldRun =
      isConnectionMainProcessing(after) &&
      (hasConnectionCredentials(after, 5, true) ||
        isTruthyFlag((after as any).is_predefined) ||
        isTruthyFlag((after as any).is_testnet) ||
        isTruthyFlag((after as any).demo_mode))

    const isRunning = coordinator.isEngineRunning(id)

    if (shouldRun && !isRunning) {
      // Should run, doesn't — START.
      // `startMissingEngines` is idempotent: a running engine is left
      // alone, a stopped-but-should-be-running engine is started with
      // the freshly-saved settings/config snapshot.
      console.log(
        `[v0] [${opts.logTag}] Recoordinate: starting engine for ${id} (was stopped, now should run)`,
      )
      await coordinator.startMissingEngines([after])
    } else if (!shouldRun && isRunning) {
      // Should NOT run, but is — STOP. This handles `is_enabled: false`
      // toggles, dashboard-disable, credential clear, etc.
      console.log(
        `[v0] [${opts.logTag}] Recoordinate: stopping engine for ${id} (was running, no longer should)`,
      )
      await coordinator.stopEngine(id)
    } else if (shouldRun && isRunning) {
      // Should run and is — the hot-reload path inside
      // `applyPendingChangesNow` already handled the change. Nothing
      // to do here. Logged at debug verbosity only.
      // console.log(`[v0] [${opts.logTag}] Engine ${id} hot-reloaded in place`)
    }
    // else: !shouldRun && !isRunning — nothing to do.
  } catch (coordErr) {
    console.warn(
      `[v0] [${opts.logTag}] coordinator recoordination failed for ${id}:`,
      coordErr instanceof Error ? coordErr.message : String(coordErr),
    )
  }
}
