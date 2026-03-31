"use client"

import { AuthProvider } from "@/lib/auth-context"
import { ExchangeProvider } from "@/lib/exchange-context"
import { ConnectionStateProvider } from "@/lib/connection-state"
import { SidebarProvider } from "@/components/ui/sidebar"
import { Dashboard } from "@/components/dashboard/dashboard"
import { Toaster } from "sonner"

export default function Home() {
  return (
    <AuthProvider>
      <ExchangeProvider>
        <ConnectionStateProvider>
          <SidebarProvider>
            <Dashboard />
            <Toaster />
          </SidebarProvider>
        </ConnectionStateProvider>
      </ExchangeProvider>
    </AuthProvider>
  )
}
