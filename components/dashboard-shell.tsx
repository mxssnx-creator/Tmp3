"use client"

import type React from "react"
import { ConnectionStateProvider } from "@/lib/connection-state"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import { Toaster } from "sonner"

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <ConnectionStateProvider>
      <SidebarProvider>
        <div className="flex h-screen w-full overflow-hidden bg-muted/20">
          <AppSidebar />
          <main className="flex flex-col flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
            {children}
          </main>
        </div>
        <Toaster />
      </SidebarProvider>
    </ConnectionStateProvider>
  )
}
