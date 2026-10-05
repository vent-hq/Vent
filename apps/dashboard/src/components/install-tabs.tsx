"use client";

import { useState } from "react";
import { Bot, Check, Copy } from "lucide-react";

const AGENT_PROMPT = "Use npx vent-hq@latest init to set up Vent, then run voice agent tests with npx vent-hq run";
const AGENT_DISPLAY = "Copy onboarding prompt for agent auto-setup";
const TERMINAL_COMMAND = "npx vent-hq@latest init";

type Tab = "agent" | "terminal";

export function InstallTabs() {
  const [tab, setTab] = useState<Tab>("terminal");
  const [copied, setCopied] = useState(false);

  const copyText = tab === "agent" ? AGENT_PROMPT : TERMINAL_COMMAND;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(copyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="w-full max-w-xl">
      {/* Tabs row */}
      <div className="flex items-end gap-0">
        {/* Terminal tab */}
        <button
          onClick={() => setTab("terminal")}
          className={`
            relative px-4 py-2 text-xs tracking-wide transition-colors cursor-pointer border border-b-0
            ${tab === "terminal"
              ? "text-foreground bg-background border-border"
              : "text-muted-foreground/50 hover:text-muted-foreground bg-transparent border-transparent"
            }
          `}
          style={{ fontFamily: "var(--font-heading)", marginRight: -1 }}
        >
          <span className="flex items-center gap-1.5">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" /><line x1="12" x2="20" y1="19" y2="19" />
            </svg>
            Terminal
          </span>
        </button>

        {/* Agent tab with rotating icons */}
        <button
          onClick={() => setTab("agent")}
          className={`
            relative px-4 py-2 text-xs tracking-wide transition-colors cursor-pointer border border-b-0
            ${tab === "agent"
              ? "text-foreground bg-background border-border"
              : "text-muted-foreground/50 hover:text-muted-foreground bg-transparent border-transparent"
            }
          `}
          style={{ fontFamily: "var(--font-heading)" }}
        >
          <span className="flex items-center gap-1.5">
            <Bot className="w-3.5 h-3.5" />
            AI Agent
          </span>
        </button>
      </div>

      {/* Command box */}
      <button
        onClick={handleCopy}
        className="group flex items-center gap-3 border border-border bg-transparent px-4 py-3 text-sm hover:border-foreground/20 transition-colors w-full text-left cursor-pointer"
        style={{ fontFamily: "var(--font-heading)", borderRadius: 0 }}
      >
        <span className="text-muted-foreground/50 select-none">&gt;</span>
        {/*
          Both labels share one grid cell so switching tabs never resizes (and re-centers) the box.
          They stay on one line and truncate, so on narrow screens the longer label can't wrap and
          make the box two lines tall.
        */}
        <span className="grid min-w-0 flex-1 text-foreground/80" style={{ fontWeight: 400 }}>
          <span className={`[grid-area:1/1] truncate ${tab === "terminal" ? "" : "invisible"}`}>{TERMINAL_COMMAND}</span>
          <span className={`[grid-area:1/1] truncate ${tab === "agent" ? "" : "invisible"}`}>{AGENT_DISPLAY}</span>
        </span>
        {copied ? (
          <Check className="h-4 w-4 text-emerald-500 shrink-0" />
        ) : (
          <Copy className="h-4 w-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors shrink-0" />
        )}
      </button>

    </div>
  );
}
