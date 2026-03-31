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

  const typeColors = {
    info: "border-blue-400/20 bg-blue-400/10 text-blue-200",
    warning: "border-yellow-400/20 bg-yellow-400/10 text-yellow-200",
    error: "border-red-400/20 bg-red-400/10 text-red-200",
    success: "border-green-400/20 bg-green-400/10 text-green-200",
  };

  return (
    <div className={`rounded-2xl border ${typeColors[message.type]} p-4 transition-all duration-200`}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-medium text-slate-300">{message.sender}</span>
            <span className="text-xs text-slate-400">{message.timestamp.toLocaleTimeString()}</span>
            <span className={`text-xs px-2 py-1 rounded-full ${typeColors[message.type]} uppercase`}>
              {message.type}
            </span>
          </div>
          <p className="text-sm text-white mb-2">{message.summary}</p>
          {expanded && (
            <div className="mt-3 pt-3 border-t border-white/10">
              <p className="text-sm text-slate-300 leading-relaxed">{message.content}</p>
              {message.related && message.related.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs text-slate-400 mb-2">Related items:</p>
                  <div className="flex flex-wrap gap-2">
                    {message.related.map((item, index) => (
                      <span key={index} className="text-xs px-2 py-1 bg-white/5 rounded text-slate-300">
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="ml-3 p-1 rounded-lg hover:bg-white/10 transition-colors"
        >
          {expanded ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
        </button>
      </div>
    </div>
  );
}