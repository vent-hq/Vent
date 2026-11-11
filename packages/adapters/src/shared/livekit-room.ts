/**
 * Shared LiveKit room transport, used by the LiveKit adapter and by
 * ElevenLabs (which runs its WebRTC calls on LiveKit). Joins the room as
 * "vent-tester", publishes the caller's audio as a 48kHz microphone track, and
 * reads the agent's audio track.
 */

import {
  Room,
  RoomEvent,
  AudioSource,
  AudioStream,
  AudioFrame,
  LocalAudioTrack,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type RtcConfiguration,
} from "@livekit/rtc-node";
import { BaseAudioChannel, CONNECT_TIMEOUT_MS } from "./audio-channel.js";

/** LiveKit's native audio rate. */
const LIVEKIT_SAMPLE_RATE = 48000;

export const CALLER_IDENTITY = "vent-tester";

export abstract class LiveKitRoomChannel extends BaseAudioChannel {
  protected override outputSampleRate = LIVEKIT_SAMPLE_RATE;
  protected room: Room | null = null;
  /** True from joining the room until it disconnects. */
  protected collecting = false;
  private audioSource: AudioSource | null = null;
  private localTrack: LocalAudioTrack | null = null;

  get connected(): boolean {
    return this.room !== null && this.collecting;
  }

  /** Whether caller audio can be published right now. */
  protected get publishing(): boolean {
    return this.audioSource !== null && this.collecting;
  }

  protected async joinRoom(url: string, token: string, rtcConfig?: RtcConfiguration): Promise<Room> {
    const room = new Room();
    this.room = room;
    await room.connect(url, token, { autoSubscribe: true, dynacast: true, rtcConfig });
    this.collecting = true;
    return room;
  }

  protected async publishCallerTrack(): Promise<void> {
    this.audioSource = new AudioSource(LIVEKIT_SAMPLE_RATE, 1);
    this.localTrack = LocalAudioTrack.createAudioTrack(CALLER_IDENTITY, this.audioSource);
    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;
    await this.room!.localParticipant!.publishTrack(this.localTrack, publishOptions);
  }

  /** Resolves with the agent once it has an audio track, or null after CONNECT_TIMEOUT_MS. */
  protected waitForAgentTrack(isAgent: (participant: RemoteParticipant) => boolean): Promise<RemoteParticipant | null> {
    const room = this.room!;
    return new Promise((resolve) => {
      for (const participant of room.remoteParticipants.values()) {
        if (!isAgent(participant)) continue;
        for (const pub of participant.trackPublications.values()) {
          if (pub.track && pub.kind === TrackKind.KIND_AUDIO) {
            resolve(participant);
            return;
          }
        }
      }

      const onTrackSubscribed = (_track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (!isAgent(participant) || pub.kind !== TrackKind.KIND_AUDIO) return;
        clearTimeout(timer);
        room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
        resolve(participant);
      };
      const timer = setTimeout(() => {
        room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
        resolve(null);
      }, CONNECT_TIMEOUT_MS);
      room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    });
  }

  /**
   * Read an agent audio track until the room disconnects or the track ends.
   * Frames that `keepFrame` rejects are dropped.
   */
  protected async readAgentTrack(track: RemoteTrack, keepFrame: (samples: Int16Array) => boolean = () => true): Promise<void> {
    const reader = new AudioStream(track, LIVEKIT_SAMPLE_RATE, 1).getReader();
    try {
      while (this.collecting) {
        const { value: frame, done } = await reader.read();
        if (done || !frame) break;
        if (!keepFrame(frame.data)) continue;
        this.receiveAgentAudio(
          Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
          LIVEKIT_SAMPLE_RATE,
        );
      }
    } catch (err) {
      // Stream closed
      if (err instanceof Error) this._stats.errorEvents.push(err.message);
    }
  }

  override sendAudio(pcm: Buffer): void {
    if (!this.publishing) return;
    super.sendAudio(pcm);
  }

  /** Write a single 20ms audio frame to LiveKit's AudioSource. */
  protected async writeAudioFrame(samples: Int16Array, sampleRate: number): Promise<void> {
    if (!this.audioSource || !this.collecting) return;
    const copied = new Int16Array(samples);
    await this.audioSource.captureFrame(new AudioFrame(copied, sampleRate, 1, copied.length));
  }

  protected override clearTransportQueue(): void {
    this.audioSource?.clearQueue();
  }

  /** Stop sending, unpublish the caller track and leave the room. */
  protected async leaveRoom(): Promise<void> {
    this.collecting = false;
    this.stopComfortNoise();
    if (this.audioSource) {
      await this.audioSource.close();
      this.audioSource = null;
    }
    if (this.localTrack) {
      await this.localTrack.close();
      this.localTrack = null;
    }
    if (this.room) {
      await this.room.disconnect();
      this.room = null;
    }
    // NOTE: Do NOT call dispose() here — it destroys the global FFI runtime
    // and kills all other concurrent LiveKit sessions in this process.
  }
}
