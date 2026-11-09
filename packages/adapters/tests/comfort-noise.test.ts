import assert from "node:assert/strict";
import { test } from "node:test";
import { BaseAudioChannel, type ComfortNoiseMode } from "../src/audio-channel.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Records every frame the base class hands to the transport. */
class FakeChannel extends BaseAudioChannel {
  frames: Int16Array[] = [];
  transportClears = 0;
  open = true;

  constructor(mode: ComfortNoiseMode, paced = true) {
    super();
    this.comfortNoise = mode;
    this.outputSampleRate = 16000;
    this.pacingIntervalMs = paced ? 10 : 0;
  }
  get connected() { return this.open; }
  async connect() {}
  async disconnect() { this.stopComfortNoise(); this.open = false; }
  protected async writeAudioFrame(samples: Int16Array) { this.frames.push(new Int16Array(samples)); }
  protected override clearTransportQueue() { this.transportClears++; }
}

const speech = Buffer.alloc(24000 * 2 * 0.1, 0x7f); // 100ms of loud 24kHz caller audio

test("noise mode sends faint 20ms noise frames at real-time pace", async () => {
  const ch = new FakeChannel("noise");
  ch.startComfortNoise();
  await sleep(200);
  await ch.disconnect();

  assert.ok(ch.frames.length >= 7 && ch.frames.length <= 12, `expected ~10 frames in 200ms, got ${ch.frames.length}`);
  for (const frame of ch.frames) {
    assert.equal(frame.length, 320); // 20ms at 16kHz
    assert.ok(frame.every((s) => Math.abs(s) <= 400));
  }
  assert.ok(ch.frames.some((f) => f.some((s) => s !== 0)), "noise must not be silent");
});

test("silence mode sends all-zero frames", async () => {
  const ch = new FakeChannel("silence");
  ch.startComfortNoise();
  await sleep(60);
  await ch.disconnect();

  assert.ok(ch.frames.length > 0);
  assert.ok(ch.frames.every((f) => f.every((s) => s === 0)));
});

test("none mode sends nothing", async () => {
  const ch = new FakeChannel("none");
  ch.startComfortNoise();
  await sleep(60);
  await ch.disconnect();

  assert.equal(ch.frames.length, 0);
});

test("caller speech stops the noise and drops buffered noise once", async () => {
  const ch = new FakeChannel("noise");
  ch.startComfortNoise();
  await sleep(50);
  ch.sendAudio(speech);
  ch.sendAudio(speech); // a second chunk of the same turn must not clear again
  const noiseBefore = ch.frames.filter((f) => f.every((s) => Math.abs(s) <= 400)).length;
  await sleep(100);
  const noiseAfter = ch.frames.filter((f) => f.every((s) => Math.abs(s) <= 400)).length;
  await ch.disconnect();

  assert.equal(ch.transportClears, 1);
  assert.ok(noiseAfter - noiseBefore <= 1, "no noise frames while the caller is speaking");
});

test("noise resumes after the caller's speech is flushed", async () => {
  const ch = new FakeChannel("noise");
  ch.sendAudio(speech);
  await ch.flushAudioBuffer();
  const sent = ch.frames.length;
  await sleep(60);
  await ch.disconnect();

  assert.ok(ch.frames.length > sent, "noise frames follow the flushed speech");
});

test("restarting quickly does not run two noise loops", async () => {
  const ch = new FakeChannel("noise");
  ch.startComfortNoise();
  ch.stopComfortNoise();
  ch.startComfortNoise();
  await sleep(200);
  await ch.disconnect();

  assert.ok(ch.frames.length <= 12, `expected ~10 frames in 200ms from one loop, got ${ch.frames.length}`);
});
