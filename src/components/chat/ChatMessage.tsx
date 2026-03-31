"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

interface ChatMessage {
  id: string;
  sender: string;
  timestamp: Date;
  summary: string;
  content: string;
  type: "info" | "warning" | "error" | "success";
  related?: string[];
}

interface Props {
  message: ChatMessage;
}

export default function ChatMessageComponent({ message }: Props) {
  const [expanded, setExpanded] = useState(false);

  const typeDots = {
    info: "bg-blue-400",
    warning: "bg-yellow-400",
    error: "bg-red-400",
    success: "bg-green-400",
  };

  return (
    <div className="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-white/5 transition-colors cursor-pointer" onClick={() => setExpanded(!expanded)}>
      <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${typeDots[message.type]}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium text-slate-300 truncate">{message.sender}</span>
          <span className="text-[10px] text-slate-500">{message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <span className="ml-auto shrink-0">
            {expanded ? <ChevronDown className="w-3 h-3 text-slate-500" /> : <ChevronRight className="w-3 h-3 text-slate-500" />}
          </span>
        </div>
        <p className="text-[11px] text-slate-300 truncate">{message.summary}</p>
        {expanded && (
          <div className="mt-1.5 pt-1.5 border-t border-white/5">
            <p className="text-xs text-slate-400 leading-relaxed">{message.content}</p>
            {message.related && message.related.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {message.related.map((item, index) => (
                  <span key={index} className="text-[10px] px-1.5 py-0.5 bg-white/5 rounded text-slate-400">
                    {item}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
