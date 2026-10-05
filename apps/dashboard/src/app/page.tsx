import Image from "next/image";
import Link from "next/link";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { InstallTabs } from "@/components/install-tabs";
import { HandDrawnUnderline } from "@/components/hand-drawn-underline";
import { FallingPattern } from "@/components/ui/falling-pattern";
import { AgentCarousel } from "@/components/agent-carousel";
import { ProviderCarousel } from "@/components/provider-carousel";
import { AnimatedHero } from "@/components/animated-hero";
import { DemoVideo } from "@/components/demo-video";
import { Star } from "lucide-react";

const GITHUB_REPO = "vent-hq/Vent";
const LAUNCH_POST_URL = "https://x.com/stephangazarov/status/2050137498735747473";

async function getGitHubStars(): Promise<number | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data: { stargazers_count: number } = await res.json();
    return data.stargazers_count;
  } catch {
    return null;
  }
}

export default async function LandingPage() {
  const stars = await getGitHubStars();
  let user: { email: string } | null = null;

  try {
    const auth = await withAuth();
    user = auth.user;
  } catch {
    // Auth not configured — render landing page without auth links
  }

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground relative overflow-hidden">
      {/* Falling pattern background */}
      {/*
        Phones: part of the page (absolute) rather than fixed, because iOS 26 Safari doesn't paint
        position: fixed content behind its floating bottom toolbar and shows a bare strip there.
      */}
      <FallingPattern className="absolute inset-0 md:fixed md:w-screen md:h-screen" />

      {/* Header */}
      <header className="relative z-10 px-6 lg:px-12 xl:px-16">
        <div className="flex items-center justify-between h-14">
            <Image src="/logo.png" alt="Vent" width={32} height={32} className="rounded-lg" priority />
            <div className="flex items-center gap-4">
              <a
                href={`https://github.com/${GITHUB_REPO}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-sm border border-foreground bg-transparent text-foreground px-4 py-1.5 rounded-lg font-semibold hover:bg-foreground/5 transition-colors"
                style={{ fontFamily: "var(--font-heading)" }}
              >
                Star Us
                <Star className="h-3.5 w-3.5" />
                {stars !== null && (
                  <span className="tabular-nums">
                    {new Intl.NumberFormat("en", { notation: "compact" }).format(stars)}
                  </span>
                )}
              </a>
              {user && (
                <Link
                  href="/settings/keys"
                  className="text-sm border border-foreground bg-transparent text-foreground px-4 py-1.5 rounded-none font-bold hover:bg-foreground/5 transition-colors"
                  style={{ fontFamily: "var(--font-heading)" }}
                >
                  Access Tokens
                </Link>
              )}
            </div>
          </div>
      </header>

      {/* Hero */}
      <main className="relative z-10 flex-1 flex flex-col">
        <div className="w-full flex-1 flex flex-col px-6 lg:px-12 xl:px-16">
          <AnimatedHero
            headline={
              <h1 className="text-4xl sm:text-5xl lg:text-[3.5rem] tracking-tight leading-[1.35] text-center" style={{ fontFamily: "var(--font-heading)", fontWeight: 300 }}>
                Ship reliable{" "}
                <span className="relative isolate inline-block">
                  voice agents
                  <HandDrawnUnderline />
                </span>
                <br className="hidden sm:block" />
                {" "}without leaving your editor
              </h1>
            }
            description={
              <p className="text-base text-foreground/80 max-w-xl mx-auto text-center text-balance leading-relaxed" style={{ fontFamily: "var(--font-heading)", fontWeight: 400 }}>
                Vent gives your coding agent commands to connect to
                <br className="hidden sm:block" />
                {" "}your local or hosted voice agent, call it, evaluate the call, and
                <br className="hidden sm:block" />
                {" "}return measured results the coding agent can iterate on.
              </p>
            }
            cta={
              <div className="flex w-fit flex-col gap-4">
                <InstallTabs />
                <AgentCarousel />
              </div>
            }
            providers={<ProviderCarousel />}
            demo={
              <a
                href={LAUNCH_POST_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View the Vent launch post on X"
                className="group relative block rounded-2xl overflow-hidden ring-1 ring-black/5 shadow-[0_4px_24px_rgba(0,0,0,0.08)]"
              >
                <DemoVideo />
                {/* Solid (not blurred) background: a backdrop blur over the playing video would re-render every frame */}
                <span
                  className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-lg bg-black/75 px-2.5 py-1.5 text-xs text-white opacity-80 transition-opacity group-hover:opacity-100"
                  style={{ fontFamily: "var(--font-heading)", fontWeight: 400 }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                  View on X
                </span>
              </a>
            }
          />
        </div>
      </main>
    </div>
  );
}
