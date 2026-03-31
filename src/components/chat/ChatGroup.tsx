"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Users } from "lucide-react";
import ChatMessageComponent from "./ChatMessage";

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
  group: ChatGroup;
}

export default function ChatGroupComponent({ group }: Props) {
  const [expanded, setExpanded] = useState(false);

  const typeColors = {
    conversation: "border-cyan-400/20 bg-cyan-400/10 text-cyan-200",
    notification: "border-blue-400/20 bg-blue-400/10 text-blue-200",
    alert: "border-yellow-400/20 bg-yellow-400/10 text-yellow-200",
    system: "border-purple-400/20 bg-purple-400/10 text-purple-200",
  };

  const priorityColors = {
    high: "text-red-400 bg-red-400/20",
    normal: "text-yellow-400 bg-yellow-400/20",
    low: "text-green-400 bg-green-400/20",
  };

  const unreadCount = group.messages.filter(m => {
    // In a real app, this would check if message is unread
    return new Date() > new Date(m.timestamp);
  }).length;

  return (
    <div className={`rounded-2xl border ${typeColors[group.type]} transition-all duration-200`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-6 text-left hover:bg-white/5 rounded-2xl transition-colors"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Users className="w-5 h-5 text-slate-400" />
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold text-white">{group.title}</h3>
                <span className={`text-xs px-2 py-1 rounded-full ${priorityColors[group.priority]} uppercase`}>
                  {group.priority}
                </span>
                {unreadCount > 0 && (
                  <span className="text-xs px-2 py-1 bg-red-500/20 text-red-300 rounded-full">
                    {unreadCount} new
                  </span>
                )}
              </div>
              <p className="text-sm text-slate-300 mt-1">{group.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${typeColors[group.type]} px-3 py-1 rounded-full border ${typeColors[group.type].replace('bg-', 'border-').replace('/10', '/20')}`}>
              {group.messages.length} messages
            </span>
            {expanded ? <ChevronDown className="w-5 h-5 text-slate-400" /> : <ChevronRight className="w-5 h-5 text-slate-400" />}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-6 pb-6">
          <div className="space-y-3 border-t border-white/10 pt-4">
            {group.messages.map((message) => (
              <ChatMessageComponent key={message.id} message={message} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}