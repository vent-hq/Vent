"use client";

import { useEffect, useRef, useState } from "react";
import { Confetti, type ConfettiRef } from "@/components/ui/confetti";
import { FallingPattern } from "@/components/ui/falling-pattern";

interface Props {
  code: string | null;
  isAuthenticated: boolean;
  signInUrl: string | null;
}

export function DeviceAuthContent({ code, isAuthenticated, signInUrl }: Props) {
  const confettiRef = useRef<ConfettiRef>(null);
  const [status, setStatus] = useState<
    "idle" | "approving" | "success" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (!code) return;
    if (!isAuthenticated) return;
    if (status !== "idle") return;

    // Auto-approve immediately when authenticated
    setStatus("approving");

    fetch("/backend/device/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ user_code: code }),
    })
      .then(async (res) => {
        if (res.ok) {
          setStatus("success");
        } else {
          const data = await res.json().catch(() => ({}));
          setStatus("error");
          setErrorMessage(
            data.error || "Failed to authorize. The code may have expired.",
          );
        }
      })
      .catch(() => {
        setStatus("error");
        setErrorMessage("Network error. Try again.");
      });
  }, [code, isAuthenticated, status]);

  // No code provided
  if (!code) {
    return (
      <div className="text-center max-w-md px-6">
        <h1 className="text-xl font-semibold tracking-tight text-white">
          Missing device code
        </h1>
        <p className="text-zinc-400 mt-2 text-sm">
          Run <code className="font-mono text-zinc-300">npx vent-hq login</code>{" "}
          from your terminal.
        </p>
      </div>
    );
  }

  // Not authenticated — show sign in
  if (!isAuthenticated && signInUrl) {
    return (
      <div className="text-center max-w-md px-6">
        <p className="text-zinc-500 text-xs font-mono tracking-wider uppercase mb-6">
          Vent CLI
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-white mb-2">
          Sign in to authorize
        </h1>
        <p className="text-zinc-400 text-sm mb-1">
          Your device code
        </p>
        <p className="text-2xl font-mono font-bold text-white tracking-widest mb-8">
          {code}
        </p>
        <a
          href={signInUrl}
          className="inline-flex items-center justify-center rounded-md bg-white text-zinc-950 px-6 py-2.5 text-sm font-medium hover:bg-zinc-200 transition-colors"
        >
          Sign in
        </a>
      </div>
    );
  }

  // Approving
  if (status === "approving" || status === "idle") {
    return (
      <div className="text-center max-w-md px-6">
        <p className="text-zinc-500 text-xs font-mono tracking-wider uppercase mb-6">
          Vent CLI
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-white">
          Authorizing...
        </h1>
        <p className="text-zinc-400 mt-2 text-sm">
          Setting up your CLI access.
        </p>
      </div>
    );
  }

  // Success
  if (status === "success") {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background">
        <FallingPattern className="absolute inset-0 w-full h-full" />
        <Confetti
          ref={confettiRef}
          className="absolute left-0 top-0 z-10 size-full pointer-events-none"
          options={{
            particleCount: 100,
            spread: 120,
            origin: { y: 0.45 },
            colors: ["#a786ff", "#fd8bbc", "#eca184", "#f8deb1"],
          }}
        />
        <div className="relative z-20 text-center max-w-md px-6">
          <p className="text-muted-foreground/60 text-xs font-mono tracking-wider uppercase mb-8">
            Vent CLI
          </p>
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-500/10 border border-green-500/20 mb-6">
            <svg
              className="w-8 h-8 text-green-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            You&apos;re all set
          </h1>
          <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
            Your CLI is authenticated. Head back to your terminal&mdash;your agent is finishing setup.
          </p>

          {/* Agent flow steps */}
          <div className="mt-8 text-left mx-auto max-w-xs space-y-3">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full bg-green-500/10 border border-green-500/20 flex items-center justify-center">
                <svg className="w-3 h-3 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">Authenticated</p>
                <p className="text-xs text-muted-foreground/60">Access token saved to ~/.vent/credentials</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full bg-foreground/5 border border-foreground/10 flex items-center justify-center">
                <div className="w-1.5 h-1.5 rounded-full bg-foreground/30 animate-pulse" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">Installing skill files</p>
                <p className="text-xs text-muted-foreground/60">So your coding agent knows how to run tests</p>
              </div>
            </div>
          </div>

          <p className="text-muted-foreground/40 mt-8 text-xs">
            You can close this tab.
          </p>
        </div>
      </div>
    );
  }

  // Error
  return (
    <div className="text-center max-w-md px-6">
      <p className="text-zinc-500 text-xs font-mono tracking-wider uppercase mb-6">
        Vent CLI
      </p>
      <h1 className="text-xl font-semibold tracking-tight text-red-400">
        Authorization failed
      </h1>
      <p className="text-zinc-400 mt-2 text-sm">{errorMessage}</p>
      <p className="text-zinc-500 mt-4 text-sm">
        Run <code className="font-mono text-zinc-400">npx vent-hq login</code>{" "}
        again.
      </p>
    </div>
  );
}
