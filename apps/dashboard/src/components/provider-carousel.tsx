"use client";

import Image from "next/image";
import { Marquee } from "@/components/ui/marquee";

type Provider = {
  name: string;
  icon: string;
};

const providers: Provider[] = [
  { name: "Vapi", icon: "/providers/vapi.png" },
  { name: "Retell", icon: "/providers/retell.png" },
  { name: "ElevenLabs", icon: "/providers/elevenlabs.png" },
  { name: "Bland", icon: "/providers/bland.png" },
  { name: "LiveKit", icon: "/providers/livekit.png" },
  { name: "WebSocket", icon: "/providers/websocket.svg" },
  { name: "WebRTC", icon: "/providers/webrtc.svg" },
];

export function ProviderCarousel() {
  return (
    <div className="space-y-4 text-center text-foreground/80" style={{ fontFamily: "var(--font-heading)", fontWeight: 400 }}>
      <p className="text-[11px] uppercase tracking-widest">
        Works with
      </p>

      <div className="relative">
        {/* Left fade */}
        <div className="absolute left-0 top-0 bottom-0 w-20 bg-gradient-to-r from-background to-transparent z-10 pointer-events-none" />
        {/* Right fade */}
        <div className="absolute right-0 top-0 bottom-0 w-20 bg-gradient-to-l from-background to-transparent z-10 pointer-events-none" />

        <Marquee speed={25} pauseOnHover repeat={4} gap="3rem">
          {providers.map((provider) => (
            <div
              key={provider.name}
              className="flex items-center gap-3 shrink-0"
            >
              <Image
                src={provider.icon}
                alt={provider.name}
                width={24}
                height={24}
                className="rounded-sm"
              />
              <span className="text-[15px] tracking-tight whitespace-nowrap">
                {provider.name}
              </span>
            </div>
          ))}
        </Marquee>
      </div>

      <p className="text-[11px] uppercase tracking-widest">
        + custom endpoint or localhost
      </p>
    </div>
  );
}
