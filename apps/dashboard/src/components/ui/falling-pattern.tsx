'use client';

import { useEffect, useRef } from 'react';
import type React from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

type FallingPatternProps = React.ComponentProps<'div'> & {
	/** Primary color of the falling elements (default: 'hsl(var(--primary))') */
	color?: string;
	/** Background color (default: 'hsl(var(--background))') */
	backgroundColor?: string;
	/** Animation duration in seconds (default: 150) */
	duration?: number;
	/** Blur radius in CSS px, the standard deviation of a CSS blur() (default: 16, i.e. 1em) */
	blurIntensity?: number;
	/** Pattern density - affects spacing (default: 1) */
	density?: number;
};

const TILE_WIDTH = 300;

/** Canvas pixels per CSS pixel. The streaks are heavily blurred, so half resolution is indistinguishable. */
const RENDER_SCALE = 0.5;

/**
 * Twelve columns of falling streaks. Each column repeats every TILE_WIDTH × tileHeight px,
 * has a streak at (x, y), a second streak 3px to its right, and a dot at (dotX, dotY),
 * and falls `distance` px over one `duration` cycle.
 */
const COLUMNS = [
	{ tileHeight: 235, x: 0, y: 220, dotX: 151.5, dotY: 337.5, distance: 6580 },
	{ tileHeight: 252, x: 25, y: 24, dotX: 176.5, dotY: 150, distance: 13608 },
	{ tileHeight: 150, x: 50, y: 16, dotX: 201.5, dotY: 91, distance: 5400 },
	{ tileHeight: 253, x: 75, y: 224, dotX: 226.5, dotY: 230.5, distance: 16951 },
	{ tileHeight: 204, x: 100, y: 19, dotX: 251.5, dotY: 121, distance: 5100 },
	{ tileHeight: 134, x: 125, y: 120, dotX: 276.5, dotY: 187, distance: 8308 },
	{ tileHeight: 179, x: 150, y: 31, dotX: 301.5, dotY: 120.5, distance: 9845 },
	{ tileHeight: 299, x: 175, y: 235, dotX: 326.5, dotY: 384.5, distance: 13156 },
	{ tileHeight: 215, x: 200, y: 121, dotX: 351.5, dotY: 228.5, distance: 14620 },
	{ tileHeight: 281, x: 225, y: 224, dotX: 376.5, dotY: 364.5, distance: 18546 },
	{ tileHeight: 158, x: 250, y: 26, dotX: 401.5, dotY: 105, distance: 5056 },
	{ tileHeight: 210, x: 275, y: 75, dotX: 426.5, dotY: 180, distance: 6300 },
];

type Column = (typeof COLUMNS)[number];

const mod = (n: number, m: number) => ((n % m) + m) % m;

/** Resolves any CSS color (including var() references) to [r, g, b]. */
function resolveColor(color: string): [number, number, number] {
	const probe = document.createElement('span');
	probe.style.color = color;
	document.body.appendChild(probe);
	const [r = 0, g = 0, b = 0] = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
	probe.remove();
	return [r, g, b];
}

/** Box blur of a wrapping (tileable) field from `src` into `dst`, along rows when `horizontal`, else columns. */
function boxBlurWrapped(src: Float32Array, dst: Float32Array, width: number, height: number, radius: number, horizontal: boolean) {
	const [lines, length] = horizontal ? [height, width] : [width, height];
	const at = (line: number, i: number) => (horizontal ? line * width + i : i * width + line);
	const size = radius * 2 + 1;
	for (let line = 0; line < lines; line++) {
		let sum = 0;
		for (let i = -radius; i <= radius; i++) sum += src[at(line, mod(i, length))];
		for (let i = 0; i < length; i++) {
			dst[at(line, i)] = sum / size;
			sum += src[at(line, mod(i + radius + 1, length))] - src[at(line, mod(i - radius, length))];
		}
	}
}

/**
 * Renders one column's repeating tile — two streaks and a dot, as the original CSS
 * radial-gradients drew them — then applies a Gaussian blur (three box passes) that
 * wraps around the tile edges, so the blurred tile still repeats seamlessly.
 */
function renderColumnTile(column: Column, rgb: [number, number, number], blur: number) {
	const width = TILE_WIDTH;
	const height = column.tileHeight;
	const alpha = new Float32Array(width * height);

	// Each CSS gradient layer is clipped to its own tile box; offsets are relative to the first streak.
	const layers = [
		{ ox: 0, oy: 0, cx: 0, cy: height, rx: 4, ry: 100, solid: 0 },
		{ ox: 3, oy: 0, cx: TILE_WIDTH, cy: height, rx: 4, ry: 100, solid: 0 },
		{ ox: column.dotX - column.x, oy: column.dotY - column.y, cx: TILE_WIDTH / 2, cy: height / 2, rx: 2.25, ry: 2.25, solid: 1.5 / 2.25 },
	];

	for (const layer of layers) {
		const ox = mod(layer.ox, width);
		const oy = mod(layer.oy, height);
		for (const copyX of [ox - width, ox]) {
			for (const copyY of [oy - height, oy]) {
				const cx = copyX + layer.cx;
				const cy = copyY + layer.cy;
				const x0 = Math.max(0, Math.floor(cx - layer.rx), Math.floor(copyX));
				const x1 = Math.min(width - 1, Math.ceil(cx + layer.rx), Math.ceil(copyX + width) - 1);
				const y0 = Math.max(0, Math.floor(cy - layer.ry), Math.floor(copyY));
				const y1 = Math.min(height - 1, Math.ceil(cy + layer.ry), Math.ceil(copyY + height) - 1);
				for (let y = y0; y <= y1; y++) {
					for (let x = x0; x <= x1; x++) {
						const px = x + 0.5;
						const py = y + 0.5;
						if (px < copyX || px > copyX + width || py < copyY || py > copyY + height) continue;
						const d = Math.hypot((px - cx) / layer.rx, (py - cy) / layer.ry);
						if (d >= 1) continue;
						const a = d <= layer.solid ? 1 : 1 - (d - layer.solid) / (1 - layer.solid);
						const i = y * width + x;
						alpha[i] = 1 - (1 - alpha[i]) * (1 - a);
					}
				}
			}
		}
	}

	// Three box blurs approximate a Gaussian with standard deviation `blur`.
	const radius = Math.max(1, Math.round((Math.sqrt(4 * blur * blur + 1) - 1) / 2));
	const scratch = new Float32Array(alpha.length);
	for (let pass = 0; pass < 3; pass++) {
		boxBlurWrapped(alpha, scratch, width, height, radius, true);
		boxBlurWrapped(scratch, alpha, width, height, radius, false);
	}

	const tile = document.createElement('canvas');
	tile.width = width;
	tile.height = height;
	const image = new ImageData(width, height);
	for (let i = 0; i < alpha.length; i++) {
		image.data[i * 4] = rgb[0];
		image.data[i * 4 + 1] = rgb[1];
		image.data[i * 4 + 2] = rgb[2];
		image.data[i * 4 + 3] = Math.round(alpha[i] * 255);
	}
	tile.getContext('2d')!.putImageData(image, 0, 0);
	return tile;
}

export function FallingPattern({
	color = 'hsl(var(--primary))',
	backgroundColor = 'hsl(var(--background))',
	duration = 150,
	blurIntensity = 16,
	density = 1,
	className,
}: FallingPatternProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	// Drawn on a canvas rather than with CSS gradients + blur: the canvas has a fixed backing
	// resolution, so pinch-zoom and compositing just scale one bitmap instead of re-rasterizing
	// a dozen full-screen animated layers through a blur filter every frame.
	useEffect(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext('2d');
		if (!canvas || !ctx) return;

		const [r, g, b] = resolveColor(backgroundColor);
		const rgb = resolveColor(color);
		const columns = COLUMNS.map((column) => ({
			column,
			pattern: ctx.createPattern(renderColumnTile(column, rgb, blurIntensity), 'repeat')!,
			speed: column.distance / duration,
		}));

		const resize = () => {
			canvas.width = Math.max(1, Math.round(canvas.clientWidth * RENDER_SCALE));
			canvas.height = Math.max(1, Math.round(canvas.clientHeight * RENDER_SCALE));
		};
		const observer = new ResizeObserver(resize);
		observer.observe(canvas);
		resize();

		let frame = 0;
		const start = performance.now();
		const draw = (now: number) => {
			const elapsed = (now - start) / 1000;
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			ctx.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
			for (const { column, pattern, speed } of columns) {
				pattern.setTransform(new DOMMatrix([1, 0, 0, 1, column.x, column.y + speed * elapsed]));
				ctx.fillStyle = pattern;
				ctx.fillRect(0, 0, canvas.width / RENDER_SCALE, canvas.height / RENDER_SCALE);
			}
			frame = requestAnimationFrame(draw);
		};
		frame = requestAnimationFrame(draw);

		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
		};
	}, [color, backgroundColor, duration, blurIntensity]);

	return (
		<div className={cn('relative h-full w-full p-1', className)}>
			<motion.div
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				transition={{ duration: 0.2 }}
				className="size-full"
			>
				<canvas ref={canvasRef} className="relative block size-full z-0" />
			</motion.div>
			<div
				className="absolute inset-0 z-[1] dark:brightness-[6]"
				style={{
					backgroundImage: `radial-gradient(circle at 50% 50%, transparent 0, transparent 2px, ${backgroundColor} 2px)`,
					backgroundSize: `${8 * density}px ${8 * density}px`,
				}}
			/>
		</div>
	);
}
