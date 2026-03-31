"use client"

import type React from "react"
import { AuthProvider } from "@/lib/auth-context"
import { ExchangeProvider } from "@/lib/exchange-context"
import { ConnectionStateProvider } from "@/lib/connection-state"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import { Toaster } from "sonner"

export const dynamic = "force-dynamic"

export default function Layout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <AuthProvider>
      <ExchangeProvider>
        <ConnectionStateProvider>
          <SidebarProvider>
            <div className="flex h-screen overflow-hidden bg-background">
              <AppSidebar />
              <main className="flex-1 overflow-auto p-6">
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
