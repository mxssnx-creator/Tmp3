"use client"

import { Button } from "@/components/ui/button"
import { BarChart3 } from "lucide-react"

interface Props {
  connectionId?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function QuickstartOverviewDialog(props: Props) {
  return (
    <Button variant="outline" size="icon" title="Quickstart Overview">
      <BarChart3 className="h-4 w-4" />
    </Button>
  )
}
