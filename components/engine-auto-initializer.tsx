"use client"

import { useEffect, useRef } from "react"

export function EngineAutoInitializer() {
  const initRef = useRef(false)

  useEffect(() => {
    // Only initialize once
    if (initRef.current) return
    initRef.current = true

    const startEngine = async () => {
      try {
        const autoStartRes = await fetch("/api/trade-engine/auto-start", {
          method: "POST",
          cache: "no-store",
        })

        if (autoStartRes.ok) {
          await autoStartRes.json().catch(() => {})
          await new Promise(resolve => setTimeout(resolve, 500))

          await fetch("/api/trade-engine/quick-start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "enable" }),
            cache: "no-store",
          }).catch(() => { /* non-critical */ })
        }
      } catch {
        // non-critical — engine may already be running
      }
    }

    // Delay initialization slightly to ensure all services are ready
    const timer = setTimeout(startEngine, 1000)

    return () => clearTimeout(timer)
  }, [])

  // This component renders nothing, it only performs initialization
  return null
}
