/**
 * PCM helpers. Vent's audio is 16-bit signed little-endian mono at SAMPLE_RATE.
 */

export const SAMPLE_RATE = 24000;

/** Round and clamp a sample value to the int16 range. */
export function clamp16(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

/** RMS level of Int16LE PCM on the int16 scale (0 for an empty buffer). */
export function pcmRms(pcm: Buffer): number {
  const samples = pcm.length >> 1;
  if (samples === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2);
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples);
}

/**
 * Resample PCM 16-bit mono from one sample rate to another using linear interpolation.
 */
export function resample(
  input: Buffer,
  fromRate: number,
  toRate: number
): Buffer {
  if (fromRate === toRate) return input;

  const inputSamples = input.length / 2;
  const ratio = fromRate / toRate;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcIndex = i * ratio;
    const srcFloor = Math.floor(srcIndex);
    const srcCeil = Math.min(srcFloor + 1, inputSamples - 1);
    const frac = srcIndex - srcFloor;

    const a = input.readInt16LE(srcFloor * 2);
    const b = input.readInt16LE(srcCeil * 2);
    output.writeInt16LE(clamp16(a + (b - a) * frac), i * 2);
  }

  return output;
}

/**
 * Concatenate PCM Int16LE chunks into a single aligned buffer.
 * WebSocket frames are not guaranteed to be sample-aligned (RFC 6455 §5.4),
 * so the concatenated result may have an odd byte count. This function
 * truncates the trailing byte to maintain Int16LE alignment.
 */
export function concatPcm(chunks: Buffer[]): Buffer {
  const buf = Buffer.concat(chunks);
  return buf.length % 2 !== 0 ? buf.subarray(0, buf.length - 1) : buf;
}
