"use client"

import type React from "react"
import { DashboardShell } from "@/components/dashboard-shell"

export const dynamic = "force-dynamic"

export default function Layout({ children }: { children: React.ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>
}