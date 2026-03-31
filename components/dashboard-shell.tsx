"use client"

import type React from "react"
import { useMemo } from "react"
import { usePathname } from "next/navigation"
import { AuthProvider } from "@/lib/auth-context"
import { ExchangeProvider } from "@/lib/exchange-context"
import { ConnectionStateProvider } from "@/lib/connection-state"
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import { ExchangeSelectorTop } from "@/components/exchange-selector-top"
import { Separator } from "@/components/ui/separator"
import { Toaster } from "sonner"

const routeMeta: Array<{ prefix: string; title: string; description: string }> = [
  { prefix: "/settings", title: "Settings", description: "System configuration and exchange controls" },
  { prefix: "/statistics", title: "Statistics", description: "Performance analytics and outcomes" },
  { prefix: "/strategies", title: "Strategies", description: "Strategy orchestration and filters" },
  { prefix: "/analysis", title: "Position Analysis", description: "Evaluate positions and signals" },
  { prefix: "/monitoring", title: "Monitoring", description: "System health, logs, and diagnostics" },
  { prefix: "/logistics", title: "Logistics", description: "Pipeline, progression, and execution status" },
  { prefix: "/indications", title: "Indications", description: "Signal generation and confidence tracking" },
  { prefix: "/live-trading", title: "Live Trading", description: "Active positions and order management" },
  { prefix: "/presets", title: "Presets", description: "Preset templates and allocation controls" },
  { prefix: "/portfolios", title: "Portfolios", description: "Portfolio composition and trend snapshots" },
  { prefix: "/testing", title: "Testing", description: "Connection and engine validation tools" },
  { prefix: "/additional", title: "Additional", description: "Extended platform capabilities" },
]

function getHeaderMeta(pathname: string) {
  if (!pathname || pathname === "/") {
    return { title: "Overview", description: "Trading dashboard, runtime status, and quick actions" }
  }

  const matched = routeMeta.find(({ prefix }) => pathname.startsWith(prefix))
  if (matched) return matched

  const segment = pathname.split("/").filter(Boolean).at(0) ?? "overview"
  const normalized = segment.replace(/-/g, " ")
  const title = normalized.charAt(0).toUpperCase() + normalized.slice(1)
  return { title, description: "Operational overview" }
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { title, description } = useMemo(() => getHeaderMeta(pathname), [pathname])

  return (
    <AuthProvider>
      <ExchangeProvider>
        <ConnectionStateProvider>
          <SidebarProvider>
            <div className="flex min-h-screen overflow-hidden bg-muted/20">
              <AppSidebar />
              <main className="flex-1 min-w-0 overflow-hidden">
                <div className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/70">
                  <div className="flex flex-wrap items-start gap-3 px-4 py-3 md:px-6">
                    <SidebarTrigger className="mt-1 h-8 w-8 shrink-0" />
                    <Separator orientation="vertical" className="mt-1 hidden h-8 md:block" />
                    <div className="min-w-0 flex-1">
                      <h1 className="truncate text-lg font-semibold tracking-tight text-foreground md:text-xl">{title}</h1>
                      <p className="truncate text-xs text-muted-foreground md:text-sm">{description}</p>
                    </div>
                    <div className="min-w-[220px] flex-1 max-w-md">
                      <ExchangeSelectorTop />
                    </div>
                  </div>
                </div>

                <div className="h-[calc(100vh-89px)] overflow-auto">
                  <div className="mx-auto w-full max-w-[1600px] p-4 md:p-6">{children}</div>
                </div>
              </main>
            </div>
            <Toaster />
          </SidebarProvider>
        </ConnectionStateProvider>
      </ExchangeProvider>
    </AuthProvider>
  )
}
