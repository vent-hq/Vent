"use client";

import { useEffect, useRef } from "react";

/** Delay before the demo starts, so the hero copy lands first. */
const PLAY_DELAY_MS = 700;

export function DemoVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Low Power Mode on iOS blocks autoplay until the user interacts with the page,
    // so if the delayed play() is rejected, retry on the first touch, click, or scroll.
    const interactions = ["touchstart", "pointerdown", "scroll", "keydown"] as const;
    const retry = () => {
      video.play().catch(() => {});
      for (const type of interactions) window.removeEventListener(type, retry);
    };

    const timer = setTimeout(() => {
      // Browsers only allow playback without a click when the video is muted, so set it explicitly
      // (React doesn't always sync the `muted` attribute to the property) before calling play().
      video.muted = true;
      video.play().catch(() => {
        for (const type of interactions) window.addEventListener(type, retry, { once: true, passive: true });
      });
    }, PLAY_DELAY_MS);

    return () => {
      clearTimeout(timer);
      for (const type of interactions) window.removeEventListener(type, retry);
    };
  }, []);

  return (
    // H.264 with faststart, so playback begins before the full download; preload buffers it during the delay.
    // Phones get a 1080px / 30fps encode (9MB) instead of the 1920px / 60fps desktop one (23.6MB).
    <video
      ref={videoRef}
      className="block w-full aspect-[1920/1248] bg-zinc-950/50"
      poster="/demo/vent-demo-poster.jpg"
      width={1920}
      height={1248}
      muted
      loop
      playsInline
      preload="auto"
    >
      <source src="/demo/vent-demo-mobile.mp4" type="video/mp4" media="(max-width: 767px)" />
      <source src="/demo/vent-demo.mp4" type="video/mp4" />
    </video>
  );
}
