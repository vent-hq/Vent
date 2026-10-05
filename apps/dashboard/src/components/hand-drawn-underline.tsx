"use client";

export function HandDrawnUnderline() {
  return (
    <svg
      viewBox="0 0 200 10"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      // Space Grotesk's "g" descends 0.2em below the baseline, and the box bottom sits 0.1625em below it
      // (measured). The stroke's top is 3.4px into this SVG, so this puts it 7.5px (2.5 strokes)
      // above the bottom of the descender: box bottom + (0.2 − 0.1625)em − 7.5px − 3.4px.
      className="absolute -z-10 top-[calc(100%+0.0375em-10.9px)] -left-[2%] w-[104%] h-[10px]"
      preserveAspectRatio="none"
    >
      <path
        d="M 2 6 C 30 4, 50 7, 80 5.5 C 110 4, 140 7, 198 5"
        stroke="url(#underlineGrad)"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
        className="draw-underline"
      />
      <defs>
        <linearGradient id="underlineGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#FACC15" />
          <stop offset="50%" stopColor="#F59E0B" />
          <stop offset="100%" stopColor="#EAB308" />
        </linearGradient>
      </defs>
    </svg>
  );
}
