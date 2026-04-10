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
        console.log("[v0] Starting auto-engine initialization...")

        // Trigger auto-start endpoint
        const autoStartRes = await fetch("/api/trade-engine/auto-start", {
          method: "POST",
          cache: "no-store",
        })

        if (autoStartRes.ok) {
          const data = await autoStartRes.json()
          console.log("[v0] Auto-start result:", data)

          // Wait a moment then trigger quick-start to ensure at least one connection runs
          await new Promise(resolve => setTimeout(resolve, 500))

          const quickStartRes = await fetch("/api/trade-engine/quick-start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "enable" }),
            cache: "no-store",
          })

          if (quickStartRes.ok) {
            const quickData = await quickStartRes.json()
            console.log("[v0] Quick-start result:", quickData)
          }
        }
      } catch (error) {
        console.error("[v0] Failed to auto-initialize engine:", error)
      }
    }

    // Delay initialization slightly to ensure all services are ready
    const timer = setTimeout(startEngine, 1000)

    return () => clearTimeout(timer)
  }, [])

  // This component renders nothing, it only performs initialization
  return null
}
