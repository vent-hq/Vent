/** Vent helper for forwarding LiveKit Agents SDK observability. */

import { LiveKitBridge } from "./bridge.js";
import type { InstrumentLiveKitAgentOptions, VentLiveKitBridge } from "./types.js";

export type {
  InstrumentLiveKitAgentOptions,
  LiveKitDataPublishOptions,
  LiveKitEventEmitterLike,
  LiveKitJobContextLike,
  LiveKitLocalParticipantLike,
  LiveKitRoomLike,
  LiveKitSessionLike,
  VentCallCost,
  VentCallMetadata,
  VentCallTransfer,
  VentCallTransferSource,
  VentCallTransferStatus,
  VentLiveKitBridge,
  VentProviderWarning,
} from "./types.js";

/** Forward a LiveKit agent's observability events to Vent. */
export function instrumentLiveKitAgent({ ctx, session }: InstrumentLiveKitAgentOptions): VentLiveKitBridge {
  const bridge = new LiveKitBridge(ctx, session);
  bridge.start();
  return bridge;
}
