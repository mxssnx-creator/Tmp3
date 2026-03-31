"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
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

  const priorityColors = {
    high: "text-red-400",
    normal: "text-yellow-400",
    low: "text-green-400",
  };

  return (
    <div className="border-b border-white/5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 text-left hover:bg-white/5 transition-colors flex items-center justify-between"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-white truncate">{group.title}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${priorityColors[group.priority]} bg-white/5`}>
            {group.priority}
          </span>
          <span className="text-[10px] text-slate-500">{group.messages.length} msgs</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {expanded ? <ChevronDown className="w-3 h-3 text-slate-400" /> : <ChevronRight className="w-3 h-3 text-slate-400" />}
        </div>
      </button>

      {expanded && (
        <div className="px-2 pb-2">
          <div className="space-y-1">
            {group.messages.map((message) => (
              <ChatMessageComponent key={message.id} message={message} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
