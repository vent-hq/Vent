export interface RelayClientConfig {
  apiUrl: string;
  relayToken: string;
  agentPort: number;
  sessionId: string;
}

const CONNECT_TIMEOUT_MS = 30_000;

export interface RelayDisconnectedInfo {
  code: number;
  reason: string;
  wasClean: boolean;
}

type RelayEventHandler = (...args: unknown[]) => void;

/** Node's WebSocket emits an ErrorEvent (not in Node's type definitions) carrying `message`. */
function errorEventMessage(ev: Event): string | undefined {
  return (ev as Event & { message?: string }).message;
}

export class RelayClient {
  private controlWs: WebSocket | null = null;
  private localConnections = new Map<string, WebSocket>();
  private config: RelayClientConfig;
  private closed = false;
  private handlers = new Map<string, RelayEventHandler[]>();

  constructor(config: RelayClientConfig) {
    this.config = config;
  }

  on(event: string, handler: RelayEventHandler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  async connect(): Promise<void> {
    const wsBase = this.config.apiUrl.replace(/^http/, "ws");
    const controlUrl = `${wsBase}/relay/control?session_id=${this.config.sessionId}&token=${this.config.relayToken}`;

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(controlUrl);
      ws.binaryType = "arraybuffer";
      let settled = false;

      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(hardTimeout);
          fn();
        }
      };

      // Hard timeout — if WS never opens AND never errors (network black hole), reject
      const hardTimeout = setTimeout(() => {
        settle(() => {
          ws.close();
          reject(new Error(`Relay connection timed out after ${CONNECT_TIMEOUT_MS}ms — check network connectivity to ${this.config.apiUrl}`));
        });
      }, CONNECT_TIMEOUT_MS);

      ws.addEventListener("open", () => {
        this.controlWs = ws;
        this.setupControlHandlers(ws);
      });

      // Connected once the server confirms the session (handshake after auth).
      this.on("ready", () => settle(() => resolve()));

      // The server closes without the handshake when it rejects the session
      // (bad token, unknown or already active session).
      ws.addEventListener("close", (ev) => {
        settle(() => reject(new Error(`Relay rejected the connection (${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`)));
      });

      ws.addEventListener("error", (ev) => {
        if (!this.controlWs) {
          settle(() => reject(new Error(`Failed to connect to relay: ${errorEventMessage(ev) ?? "connection error"}`)));
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    this.closed = true;

    for (const [connId, local] of this.localConnections) {
      if (local.readyState !== WebSocket.CLOSED) local.close();
      this.localConnections.delete(connId);
    }

    if (this.controlWs) {
      this.controlWs.close();
      this.controlWs = null;
    }
  }

  private sendControlMessage(msg: Record<string, unknown>): void {
    if (this.controlWs?.readyState === WebSocket.OPEN) {
      this.controlWs.send(JSON.stringify(msg));
    }
  }

  private sendDataFrame(connId: string, payload: Uint8Array, frameType: number): void {
    if (!this.controlWs || this.controlWs.readyState !== WebSocket.OPEN) return;
    const header = new Uint8Array(37);
    header[0] = frameType;
    const connIdBytes = new TextEncoder().encode(connId);
    header.set(connIdBytes, 1);
    const frame = new Uint8Array(37 + payload.byteLength);
    frame.set(header);
    frame.set(payload, 37);
    this.controlWs.send(frame);
  }

  private setupControlHandlers(ws: WebSocket): void {
    ws.addEventListener("message", (event) => {
      // Binary message: data frame from server (runner data for a conn_id)
      if (event.data instanceof ArrayBuffer) {
        const data = new Uint8Array(event.data);
        if (data.length < 37) return;
        const frameType = data[0];
        if (frameType !== 0x01 && frameType !== 0x02) return;
        const connId = new TextDecoder().decode(data.subarray(1, 37));
        const payload = data.subarray(37);

        const local = this.localConnections.get(connId);
        if (local?.readyState === WebSocket.OPEN) {
          if (frameType === 0x02) {
            // Text frame: forward as string so local agent receives a text WS message
            local.send(new TextDecoder().decode(payload));
          } else {
            local.send(payload);
          }
        }
        return;
      }

      // Text message: JSON control
      try {
        const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
        const msg = JSON.parse(raw) as { type: string; conn_id?: string };

        if (msg.type === "config") {
          this.emit("ready");
        } else if (msg.type === "new_connection" && msg.conn_id) {
          this.handleNewConnection(msg.conn_id);
        } else if (msg.type === "close" && msg.conn_id) {
          const local = this.localConnections.get(msg.conn_id);
          if (local && local.readyState !== WebSocket.CLOSED) local.close();
          this.localConnections.delete(msg.conn_id);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.addEventListener("close", (ev) => {
      this.controlWs = null;
      if (!this.closed) {
        this.emit("disconnected", {
          code: ev.code,
          reason: ev.reason,
          wasClean: ev.wasClean,
        } satisfies RelayDisconnectedInfo);
      }
    });

    ws.addEventListener("error", (ev) => {
      this.emit("error", new Error(errorEventMessage(ev) ?? "WebSocket error"));
    });
  }

  private handleNewConnection(connId: string): void {
    const localWs = new WebSocket(`ws://localhost:${this.config.agentPort}`);
    localWs.binaryType = "arraybuffer";

    localWs.addEventListener("open", () => {
      // Tell server we're ready to receive data for this conn_id
      this.sendControlMessage({ type: "open_ack", conn_id: connId });
      this.localConnections.set(connId, localWs);
    });

    // Forward local agent messages to server, preserving text/binary distinction
    localWs.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.sendDataFrame(connId, new Uint8Array(event.data), 0x01);
      } else {
        this.sendDataFrame(connId, new TextEncoder().encode(event.data as string), 0x02);
      }
    });

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (localWs.readyState !== WebSocket.CLOSED) localWs.close();
      this.localConnections.delete(connId);
      // Notify server that this connection is done
      this.sendControlMessage({ type: "close", conn_id: connId });
    };

    localWs.addEventListener("close", cleanup);
    localWs.addEventListener("error", cleanup);
  }
}
