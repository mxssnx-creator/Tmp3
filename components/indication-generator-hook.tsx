"use client"

import { useEffect } from "react"

/**
 * Client-side hook that periodically generates indications by calling the API
 * This bypasses the stale webpack bundle issue by using a fresh API endpoint
 */
export function useIndicationGenerator(enabled: boolean = true, intervalMs: number = 3000) {
  useEffect(() => {
    if (!enabled) return
    
    console.log("[v0] IndicationGeneratorHook: Starting indication generation loop")
    
    const generateIndications = async () => {
      try {
        // Use the cron-style indication generator which bypasses the broken IndicationProcessor
        const response = await fetch("/api/cron/generate-indications", {
          method: "GET",
          cache: "no-store",
          headers: { "x-client-trigger": "indication-hook" }
        })
        if (response.ok) {
          const data = await response.json()
          if (data.generated > 0) {
            console.log(`[v0] IndicationGeneratorHook: Generated ${data.generated} indications`)
          }
        }
      } catch (e) {
        // Silently ignore errors
      }
    }
    
    // Generate immediately
    generateIndications()
    
    // Then generate periodically
    const interval = setInterval(generateIndications, intervalMs)
    
    return () => {
      console.log("[v0] IndicationGeneratorHook: Stopping indication generation loop")
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
