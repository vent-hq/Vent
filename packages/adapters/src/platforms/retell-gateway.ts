/**
 * Retell v3 web-call client: WebRTC to Retell's gateway, signaled over HTTPS.
 * https://docs.retellai.com/deploy/native-web-call
 *
 * connect(): create the web call → send an SDP offer that already contains all
 * of our ICE candidates (no trickle PATCHes) → apply Retell's answer → wait
 * until connected. writeFrame() sends caller audio; agent audio arrives through
 * hooks.audio as 24kHz mono PCM.
 */
const wrtc: typeof import("@roamhq/wrtc") = require("@roamhq/wrtc");
import { resample } from "@vent/shared";
import { CONNECT_TIMEOUT_MS } from "../shared/audio-channel.js";

const API = "https://api.retellai.com";
const SAMPLE_RATE = 48000;
/** wrtc's audio source takes exactly one 10ms frame per call. */
export const FRAME_SAMPLES = SAMPLE_RATE / 100;
const ICE_GATHERING_TIMEOUT_MS = 3_000;

// wrtc mirrors the browser WebRTC API; this project has no DOM typings, so
// describe only what we use.
interface Peer {
  connectionState: string;
  iceGatheringState: string;
  localDescription: { sdp: string } | null;
  onconnectionstatechange: (() => void) | null;
  onicegatheringstatechange: (() => void) | null;
  ontrack: ((event: { track: { stop(): void } }) => void) | null;
  addTrack(track: unknown): void;
  createDataChannel(label: string): DataChannel;
  createOffer(): Promise<{ type: string; sdp: string }>;
  setLocalDescription(offer: unknown): Promise<void>;
  setRemoteDescription(answer: unknown): Promise<void>;
  close(): void;
}
interface DataChannel {
  onclose: (() => void) | null;
  close(): void;
}
interface AudioData { samples: Int16Array; numberOfFrames: number; channelCount: number; sampleRate: number }

interface RetellGatewayHooks {
  audio(pcm24k: Buffer): void;
  disconnected(): void;
  error(error: Error): void;
}

export class RetellGateway {
  private pc?: Peer;
  private source?: InstanceType<typeof wrtc.nonstandard.RTCAudioSource>;
  private stoppables: { stop(): void }[] = [];
  private control?: DataChannel;
  private sessionUrl?: string;
  private accessToken = "";
  private requests = new AbortController();
  private closed = false;

  constructor(private hooks: RetellGatewayHooks) {}

  async connect(apiKey: string, agentId: string): Promise<string> {
    const createResponse = await fetch(`${API}/v3/create-web-call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agentId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!createResponse.ok) {
      throw new Error(`Retell create web call failed (${createResponse.status}): ${await createResponse.text()}`);
    }
    const call = await createResponse.json() as { call_id: string; access_token: string; transport: string; ice_servers: unknown[] };
    if (call.transport !== "gateway") throw new Error(`Unsupported Retell web call transport: ${call.transport}`);
    this.accessToken = call.access_token;

    const pc = new wrtc.RTCPeerConnection({
      iceServers: call.ice_servers.length ? call.ice_servers : [{ urls: "stun:stun.l.google.com:19302" }],
    }) as unknown as Peer;
    this.pc = pc;

    this.source = new wrtc.nonstandard.RTCAudioSource();
    const track = this.source.createTrack();
    this.stoppables.push(track);
    pc.addTrack(track);
    this.control = pc.createDataChannel("control");
    // Retell closes the channel right after sending {"type":"status","state":"ended"}
    // when the agent hangs up; it also closes when the connection drops.
    this.control.onclose = () => { if (!this.closed) this.hooks.disconnected(); };
    pc.ontrack = (event) => {
      const sink = new wrtc.nonstandard.RTCAudioSink(event.track);
      this.stoppables.push(sink, event.track);
      sink.ondata = (data: AudioData) => {
        if (!this.closed) this.hooks.audio(resample(Buffer.from(toMono(data).buffer), data.sampleRate, 24000));
      };
    };
    const connected = waitForConnection(pc, this.hooks);
    void connected.catch(() => {}); // awaited below; don't crash if it fails first

    await pc.setLocalDescription(await pc.createOffer());
    await iceGatheringComplete(pc);
    const base = `${API}/webrtc-proxy/${call.call_id}/v1/webrtc/sessions`;
    const session = await this.signal(base, "POST", { identity: "client", sdp: pc.localDescription!.sdp });
    this.sessionUrl = `${base}/${session.session_id}`;
    await pc.setRemoteDescription({ type: "answer", sdp: session.sdp });
    await connected;
    return call.call_id;
  }

  /** Send up to one 10ms frame of 48kHz mono PCM (shorter frames are padded with silence). */
  writeFrame(samples: Int16Array): void {
    const frame = new Int16Array(FRAME_SAMPLES);
    frame.set(samples.subarray(0, FRAME_SAMPLES));
    this.source?.onData({ samples: frame, sampleRate: SAMPLE_RATE, bitsPerSample: 16, channelCount: 1, numberOfFrames: FRAME_SAMPLES });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.requests.abort();
    for (const s of this.stoppables) s.stop();
    if (this.control) { this.control.onclose = null; this.control.close(); }
    if (this.pc) {
      this.pc.ontrack = this.pc.onconnectionstatechange = this.pc.onicegatheringstatechange = null;
      this.pc.close();
    }
    if (this.sessionUrl) {
      await fetch(this.sessionUrl, { method: "DELETE", headers: this.headers(), signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
  }

  private async signal(url: string, method: string, body: unknown): Promise<{ session_id: string; sdp: string }> {
    const response = await fetch(url, {
      method,
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([this.requests.signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) throw new Error(`Retell gateway signaling failed (${response.status}): ${await response.text()}`);
    return response.json() as Promise<{ session_id: string; sdp: string }>;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}`, "X-Retell-Client-JS-SDK-Version": "3.0.4" };
  }
}

/** Resolves once connected; afterwards reports a failed connection through hooks. */
function waitForConnection(pc: Peer, hooks: RetellGatewayHooks): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Retell gateway connection timed out")), CONNECT_TIMEOUT_MS);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        clearTimeout(timer);
        resolve();
      } else if (pc.connectionState === "failed") {
        clearTimeout(timer);
        const error = new Error("Retell gateway WebRTC connection failed");
        reject(error);
        hooks.error(error);
      }
    };
  });
}

/** Waits until all local ICE candidates are in the SDP, so the offer carries them. */
function iceGatheringComplete(pc: Peer): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const timer = setTimeout(resolve, ICE_GATHERING_TIMEOUT_MS); // send what we have
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") { clearTimeout(timer); resolve(); }
    };
  });
}

function toMono(data: AudioData): Int16Array {
  const { samples, channelCount, numberOfFrames } = data;
  if (channelCount === 1) return samples.slice(0, numberOfFrames);

  // Multi-channel samples are interleaved: [left0, right0, left1, right1, ...].
  // Each mono sample is the average of one frame's channels.
  const mono = new Int16Array(numberOfFrames);
  for (let frame = 0; frame < numberOfFrames; frame++) {
    const start = frame * channelCount;
    const channels = samples.subarray(start, start + channelCount);
    const sum = channels.reduce((total, sample) => total + sample, 0);
    mono[frame] = Math.round(sum / channelCount);
  }
  return mono;
}
