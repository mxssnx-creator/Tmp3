"use client"
export const dynamic = "force-dynamic"


import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Download, MessageSquare, User, Bot, Calendar, FileText } from "lucide-react"
import type { ChatHistoryStats } from "@/lib/additional/chat-history"

export default function ChatHistoryPage() {
  const [stats, setStats] = useState<ChatHistoryStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchStats()
  }, [])

  const fetchStats = async () => {
    try {
      const response = await fetch("/api/additional/chat-history/stats")
      if (response.ok) {
        const data = await response.json()
        setStats(data)
      }
    } catch (error) {
      console.error("[v0] Failed to fetch stats:", error)
    } finally {
      setLoading(false)
    }
  }

  const handleDownload = async (format: "combined" | "input" | "output") => {
    try {
      const response = await fetch(`/api/additional/chat-history?format=${format}`)
      if (response.ok) {
        const blob = await response.blob()
        const url = window.URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = `chat-${format}-${new Date().toISOString().split("T")[0]}.txt`
        document.body.appendChild(a)
        a.click()
        window.URL.revokeObjectURL(url)
        document.body.removeChild(a)
      }
    } catch (error) {
      console.error("[v0] Download failed:", error)
    }
  }

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <div className="flex items-center justify-between space-y-2">
        <h2 className="text-3xl font-bold tracking-tight">Chat History</h2>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Messages</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{loading ? "..." : stats?.totalMessages || 0}</div>
            <p className="text-xs text-muted-foreground">Last 30 days</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">User Inputs</CardTitle>
            <User className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{loading ? "..." : stats?.userMessages || 0}</div>
            <p className="text-xs text-muted-foreground">Your messages</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Assistant Outputs</CardTitle>
            <Bot className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{loading ? "..." : stats?.assistantMessages || 0}</div>
            <p className="text-xs text-muted-foreground">AI responses</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Export Conversation History</CardTitle>
          <CardDescription>Download chat messages in different formats</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="combined" className="w-full">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="combined">Combined</TabsTrigger>
              <TabsTrigger value="input">Inputs Only</TabsTrigger>
              <TabsTrigger value="output">Outputs Only</TabsTrigger>
            </TabsList>

            <TabsContent value="combined" className="space-y-4">
              <div className="rounded-lg border p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-muted-foreground" />
                  <h3 className="font-semibold">Complete Conversation</h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  Download the complete conversation with both user inputs and assistant outputs in chronological order.
                </p>
                <Button onClick={() => handleDownload("combined")} className="w-full mt-2">
                  <Download className="h-4 w-4 mr-2" />
                  Download Combined History
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="input" className="space-y-4">
              <div className="rounded-lg border p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <User className="h-5 w-5 text-muted-foreground" />
                  <h3 className="font-semibold">User Input Messages</h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  Download only the messages you sent - useful for reviewing your requests and commands.
                </p>
                <Button onClick={() => handleDownload("input")} className="w-full mt-2">
                  <Download className="h-4 w-4 mr-2" />
                  Download Input Messages
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="output" className="space-y-4">
              <div className="rounded-lg border p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <Bot className="h-5 w-5 text-muted-foreground" />
                  <h3 className="font-semibold">Assistant Output Messages</h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  Download only the assistant&apos;s responses - useful for reviewing solutions and documentation.
                </p>
                <Button onClick={() => handleDownload("output")} className="w-full mt-2">
                  <Download className="h-4 w-4 mr-2" />
                  Download Output Messages
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {stats && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="h-5 w-5" />
              Date Range
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">First Message:</span>
                <span className="font-mono">{new Date(stats.dateRange.start).toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Latest Message:</span>
                <span className="font-mono">{new Date(stats.dateRange.end).toLocaleString()}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
