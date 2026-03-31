"use client"

import { useEffect } from "react"
import { AlertCircle, RefreshCw, Home } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[v0] Global error:", error)

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
          global: true,
        },
      }),
    }).catch((err) => console.error("[v0] Failed to log global error:", err))
  }, [error])

  return (
    <html lang="en">
      <body>
        <div className="flex items-center justify-center min-h-screen p-6 bg-background">
          <Card className="max-w-2xl w-full border-destructive">
            <CardHeader>
              <div className="flex items-center gap-3">
                <AlertCircle className="h-8 w-8 text-destructive" />
                <div>
                  <CardTitle className="text-2xl">Application Error</CardTitle>
                  <CardDescription>A critical error occurred in the application</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-muted p-4 rounded-lg">
                <p className="font-mono text-sm text-destructive">{error.message}</p>
                {error.digest && (
                  <p className="font-mono text-xs text-muted-foreground mt-2">Error ID: {error.digest}</p>
                )}
              </div>

              {process.env.NODE_ENV === "development" && error.stack && (
                <details className="text-sm">
                  <summary className="cursor-pointer font-medium mb-2">Stack Trace</summary>
                  <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-xs">{error.stack}</pre>
                </details>
              )}

              <div className="flex gap-2">
                <Button onClick={reset} variant="default">
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Try Again
                </Button>
                <Button onClick={() => (window.location.href = "/")} variant="outline">
                  <Home className="h-4 w-4 mr-2" />
                  Go Home
                </Button>
              </div>

              <p className="text-sm text-muted-foreground">
                This error has been logged and will be reviewed by the development team.
              </p>
            </CardContent>
          </Card>
        </div>
      </body>
    </html>
  )
}
