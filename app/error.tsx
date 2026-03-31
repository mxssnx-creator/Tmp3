"use client"

import { useEffect } from "react"
import { AlertCircle, RefreshCw, Home } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[v0] Page error:", error)

    // Log to monitoring API
    fetch("/api/monitoring/site", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        level: "error",
        category: "nextjs",
        message: error.message,
        stack: error.stack,
        metadata: {
          digest: error.digest,
          page: window.location.pathname,
        },
      }),
    }).catch((err) => console.error("[v0] Failed to log page error:", err))
  }, [error])

  // Minimal fallback for faster debugging
  return (
    <div style={{ 
      minHeight: "100vh", 
      display: "flex", 
      alignItems: "center", 
      justifyContent: "center",
      padding: "20px",
      fontFamily: "system-ui, sans-serif"
    }}>
      <div style={{ maxWidth: "600px", width: "100%" }}>
        <h1 style={{ color: "#dc2626", marginBottom: "10px" }}>
          <AlertCircle style={{ display: "inline", marginRight: "8px" }} />
          Page Error
        </h1>
        <p style={{ color: "#6b7280", marginBottom: "20px" }}>
          {error.message}
        </p>
        {error.digest && (
          <p style={{ fontSize: "12px", color: "#9ca3af", marginBottom: "20px" }}>
            Error ID: {error.digest}
          </p>
        )}
        <div style={{ display: "flex", gap: "10px" }}>
          <Button onClick={reset}>
            <RefreshCw style={{ marginRight: "8px", height: "16px" }} />
            Try Again
          </Button>
          <Button onClick={() => (window.location.href = "/")} variant="outline">
            <Home style={{ marginRight: "8px", height: "16px" }} />
            Go Home
          </Button>
        </div>
        {process.env.NODE_ENV === "development" && error.stack && (
          <details style={{ marginTop: "20px" }}>
            <summary style={{ cursor: "pointer", marginBottom: "10px" }}>Stack Trace</summary>
            <pre style={{ 
              background: "#1f2937", 
              color: "#e5e7eb", 
              padding: "12px", 
              borderRadius: "6px",
              overflow: "auto",
              fontSize: "12px"
            }}>
              {error.stack}
            </pre>
          </details>
        )}
      </div>
    </div>
  )
}
