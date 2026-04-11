"use client"

import { useEffect } from "react"

/**
 * Client-side hook that periodically generates indications by calling the API
 * This bypasses the stale webpack bundle issue by using a fresh API endpoint
 */
export function useIndicationGenerator(enabled: boolean = true, intervalMs: number = 3000) {
  useEffect(() => {
    if (!enabled) return

    const generateIndications = async () => {
      try {
        // Use the cron-style indication generator which bypasses the broken IndicationProcessor
        await fetch("/api/cron/generate-indications", {
          method: "GET",
          cache: "no-store",
          headers: { "x-client-trigger": "indication-hook" }
        })
      } catch {
        // Silently ignore errors
      }
    }

    // Generate immediately, then periodically
    generateIndications()
    const interval = setInterval(generateIndications, intervalMs)

    return () => {
      clearInterval(interval)
    }
  }, [enabled, intervalMs])
}

/**
 * Component version that can be dropped into any page
 */
export function IndicationGeneratorProvider({ children }: { children?: React.ReactNode }) {
  useIndicationGenerator(true, 3000)
  return <>{children}</>
}
