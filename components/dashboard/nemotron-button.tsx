"use client"

import { useState } from "react"
import { QuickstartOverviewDialog } from "./quickstart-overview-dialog"

interface NemotronButtonProps {
  connectionId?: string
}

export function NemotronButton({ connectionId = "bingx-x01" }: NemotronButtonProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex h-9 w-9 items-center justify-center rounded-md border border-gray-200 bg-gray-50 px-2.5 text-xs font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-800 hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:pointer-events-none disabled:opacity-50 transition-all"
        title="Nemotron 3 Super - Main/Log Overview"
      >
        <span className="flex items-center gap-1">
          <span className="text-indigo-600">N</span><span className="text-gray-600">e</span><span className="text-indigo-600">m</span><span className="text-gray-600">o</span><span className="text-indigo-600">n</span><span className="text-gray-600">t</span><span className="text-indigo-600">r</span><span className="text-gray-600">o</span><span className="text-indigo-600">n</span><span className="text-gray-600"> </span><span className="text-indigo-600">3</span><span className="text-gray-600"> </span><span className="text-indigo-600">S</span><span className="text-gray-600">u</span><span className="text-indigo-600">p</span><span className="text-gray-600">e</span><span className="text-indigo-600">r</span>
        </span>
      </button>
      
      <QuickstartOverviewDialog 
        connectionId={connectionId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  )
}