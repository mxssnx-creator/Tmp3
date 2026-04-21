"use client"

import { useEffect, useRef } from "react"

/**
 * EngineAutoInitializer — bootstraps the Global Trade Engine Coordinator
 * (starts workers / progression loops) on dashboard mount.
 *
 * IMPORTANT STABILITY RULE:
 *   This component MUST NOT mutate connection assignment flags.
 *   Previously it also POSTed to /api/trade-engine/quick-start with
 *   action: "enable", which unconditionally wrote is_active_inserted="1"
 *   and is_enabled_dashboard="1" onto whichever BingX/Bybit connection it
 *   found. That bypassed the user's explicit choice and was the primary
 *   reason a deleted/disabled connection kept reappearing after every page
 *   load. Quick-start enable is now strictly an explicit user action via
 *   the QuickStart button.
 */
export function EngineAutoInitializer() {
  const initRef = useRef(false)

  useEffect(() => {
    // Only initialize once per mount
    if (initRef.current) return
    initRef.current = true

    const startCoordinator = async () => {
      try {
        // Start the global coordinator only. This endpoint does NOT touch
        // per-connection assignment flags — it just ensures the background
        // worker loops are running so already-enabled engines progress.
        await fetch("/api/trade-engine/auto-start", {
          method: "POST",
          cache: "no-store",
        }).catch(() => { /* non-critical */ })
      } catch {
        // non-critical — coordinator may already be running
      }
    }

    // Delay slightly to let Next.js finish hydration / layouts mount.
    const timer = setTimeout(startCoordinator, 1000)

    return () => clearTimeout(timer)
  }, [])

  // This component renders nothing, it only performs initialization
  return null
}
