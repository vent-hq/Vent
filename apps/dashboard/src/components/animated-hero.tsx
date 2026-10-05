"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";

type AnimatedHeroProps = {
  headline: ReactNode;
  description: ReactNode;
  cta: ReactNode;
  providers: ReactNode;
  demo: ReactNode;
};

export function AnimatedHero({ headline, description, cta, providers, demo }: AnimatedHeroProps) {
  return (
    <>
      {/* Centered intro: headline, description, install command */}
      <div className="flex flex-col items-center pt-20 lg:pt-24">
        {/* Headline — fades in first together with the CTA; underline triggers via CSS delay */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        >
          {headline}
        </motion.div>

        {/* Description — follows once the headline and CTA have landed */}
        <motion.div
          className="mt-6"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: "easeOut", delay: 0.5 }}
        >
          {description}
        </motion.div>

        {/* CTA (command + agent carousel) — same timing as the headline */}
        <motion.div
          className="mt-10 flex justify-center"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        >
          {cta}
        </motion.div>
      </div>

      {/* Demo (not animated) */}
      <div className="mt-16 lg:mt-20 mx-auto w-full max-w-[1200px]">
        {demo}
      </div>

      {/* Provider carousel */}
      <motion.div
        className="mt-16 lg:mt-20 pb-24 mx-auto w-full max-w-3xl"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: "easeOut", delay: 0.8 }}
      >
        {providers}
      </motion.div>
    </>
  );
}
