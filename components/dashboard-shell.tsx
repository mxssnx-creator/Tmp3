"use client"

import type React from "react"
import { AuthProvider } from "@/lib/auth-context"
import { ExchangeProvider } from "@/lib/exchange-context"
import { ConnectionStateProvider } from "@/lib/connection-state"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import { Toaster } from "sonner"

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ExchangeProvider>
        <ConnectionStateProvider>
          <SidebarProvider>
            <div className="flex min-h-screen overflow-hidden bg-muted/20">
              <AppSidebar />
              <main className="flex-1 min-w-0 overflow-auto">
                {children}
              </main>
            </div>
            <Toaster />
          </SidebarProvider>
        </ConnectionStateProvider>
      </ExchangeProvider>
    </AuthProvider>
  )
}
