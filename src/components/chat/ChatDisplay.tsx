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
  const [filterType, setFilterType] = useState<string>("all");
  const [filterPriority, setFilterPriority] = useState<string>("all");
  const [showFilters, setShowFilters] = useState(false);

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

  return (
    <div className="bg-slate-950/50 rounded-lg border border-white/10">
      {/* Compact Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-cyan-400" />
          <h2 className="text-sm font-semibold text-white">Chat</h2>
          <span className="text-xs text-slate-400">{totalMessages} msgs</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="p-1 rounded hover:bg-white/10 transition-colors"
          >
            <Filter className="w-3.5 h-3.5 text-slate-400" />
          </button>
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-32 pl-7 pr-2 py-1 text-xs bg-slate-900 border border-slate-700 rounded text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
            />
          </div>
        </div>
      </div>

      {/* Compact Filters */}
      {showFilters && (
        <div className="flex gap-1.5 px-3 py-1.5 border-b border-white/10 bg-white/5">
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="px-2 py-1 text-xs bg-slate-900 border border-slate-700 rounded text-white focus:outline-none"
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
            className="px-2 py-1 text-xs bg-slate-900 border border-slate-700 rounded text-white focus:outline-none"
          >
            <option value="all">All Priorities</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </div>
      )}

      {/* Compact Groups List */}
      <div className="max-h-[600px] overflow-y-auto">
        {filteredGroups.length === 0 ? (
          <div className="text-center py-6">
            <p className="text-xs text-slate-400">No matching conversations</p>
          </div>
        ) : (
          filteredGroups.map((group) => (
            <ChatGroupComponent key={group.id} group={group} />
          ))
        )}
      </div>
    </div>
  );
}
