"use client";

import { useState } from "react";
import { Filter, Search, MessageSquare } from "lucide-react";
import ChatGroupComponent from "./ChatGroup";

interface ChatMessage {
  id: string;
  sender: string;
  timestamp: Date;
  summary: string;
  content: string;
  type: "info" | "warning" | "error" | "success";
  related?: string[];
}

interface ChatGroup {
  id: string;
  title: string;
  description: string;
  messages: ChatMessage[];
  type: "conversation" | "notification" | "alert" | "system";
  priority: "high" | "normal" | "low";
}

interface Props {
  groups: ChatGroup[];
}

export default function ChatDisplay({ groups }: Props) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<string>( "all");
  const [filterPriority, setFilterPriority] = useState<string>("all");

  const filteredGroups = groups.filter(group => {
    const matchesSearch = group.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         group.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         group.messages.some(msg =>
                           msg.sender.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           msg.summary.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           msg.content.toLowerCase().includes(searchQuery.toLowerCase())
                         );

    const matchesType = filterType === "all" || group.type === filterType;
    const matchesPriority = filterPriority === "all" || group.priority === filterPriority;

    return matchesSearch && matchesType && matchesPriority;
  });

  const totalMessages = groups.reduce((sum, group) => sum + group.messages.length, 0);
  const highPriorityCount = groups.filter(g => g.priority === "high").length;
  const recentActivity = groups.filter(g =>
    g.messages.some(m => (Date.now() - m.timestamp.getTime()) < 24 * 60 * 60 * 1000)
  ).length;

  return (
    <div className="bg-slate-950/50 rounded-3xl border border-white/10 p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <MessageSquare className="w-6 h-6 text-cyan-400" />
          <div>
            <h2 className="text-2xl font-semibold text-white">Unified Chat Display</h2>
            <p className="text-sm text-slate-300">Smart, grouped information management</p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <div className="text-center">
            <p className="text-2xl font-bold text-white">{totalMessages}</p>
            <p className="text-slate-400">Total Messages</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-red-400">{highPriorityCount}</p>
            <p className="text-slate-400">High Priority</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-cyan-400">{recentActivity}</p>
            <p className="text-slate-400">Active (24h)</p>
          </div>
        </div>
      </div>

      {/* Filters and Search */}
      <div className="flex flex-col sm:flex-row gap-4 mb-6 p-4 bg-white/5 rounded-2xl">
        <div className="flex-1 relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search conversations, messages..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:border-cyan-400"
          />
        </div>
        <div className="flex gap-2">
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white focus:outline-none focus:border-cyan-400"
          >
            <option value="all">All Types</option>
            <option value="conversation">Conversations</option>
            <option value="notification">Notifications</option>
            <option value="alert">Alerts</option>
            <option value="system">System</option>
          </select>
          <select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value)}
            className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white focus:outline-none focus:border-cyan-400"
          >
            <option value="all">All Priorities</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>

      {/* Groups */}
      <div className="space-y-4">
        {filteredGroups.length === 0 ? (
          <div className="text-center py-12">
            <MessageSquare className="w-12 h-12 text-slate-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-slate-300 mb-2">No matching conversations</h3>
            <p className="text-slate-400">Try adjusting your search or filters</p>
          </div>
        ) : (
          filteredGroups.map((group) => (
            <ChatGroupComponent key={group.id} group={group} />
          ))
        )}
      </div>

      {filteredGroups.length > 0 && (
        <div className="mt-6 text-center">
          <select
            onChange={(e) => {
              const action = e.target.value;
              if (action === "expand-all") {
                // In a real implementation, you'd manage global expand state
                console.log("Expanding all groups");
              }
              if (action === "collapse-all") {
                console.log("Collapsing all groups");
              }
              e.target.value = ""; // Reset select
            }}
            className="px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white focus:outline-none focus:border-cyan-400"
            defaultValue=""
          >
            <option value="">Bulk Actions</option>
            <option value="expand-all">Expand All</option>
            <option value="collapse-all">Collapse All</option>
            <option value="mark-read">Mark All Read</option>
          </select>
        </div>
      )}
    </div>
  );
}
