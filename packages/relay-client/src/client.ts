export interface RelayClientConfig {
  apiUrl: string;
  relayToken: string;
  agentPort: number;
  healthEndpoint: string;
  sessionId: string;
}

interface LocalConnection {
  local: WebSocket;
  connId: string;
}

export interface RelayDisconnectedInfo {
  code: number;
  reason: string;
  wasClean: boolean;
}

type RelayEventHandler = (...args: unknown[]) => void;

export class RelayClient {
  private controlWs: WebSocket | null = null;
  private localConnections = new Map<string, LocalConnection>();
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

  async connect(timeoutMs = 30_000): Promise<void> {
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
          reject(new Error(`Relay connection timed out after ${timeoutMs}ms — check network connectivity to ${this.config.apiUrl}`));
        });
      }, timeoutMs);

      ws.addEventListener("open", () => {
        this.controlWs = ws;
        this.setupControlHandlers(ws);
        this.emit("connected");
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
          settle(() => reject(new Error(`Failed to connect to relay: ${(ev as ErrorEvent).message ?? "connection error"}`)));
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    this.closed = true;

    for (const [connId, conn] of this.localConnections) {
      if (conn.local.readyState !== WebSocket.CLOSED) conn.local.close();
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

        const conn = this.localConnections.get(connId);
        if (conn?.local.readyState === WebSocket.OPEN) {
          if (frameType === 0x02) {
            // Text frame: forward as string so local agent receives a text WS message
            conn.local.send(new TextDecoder().decode(payload));
          } else {
            conn.local.send(payload);
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
          const conn = this.localConnections.get(msg.conn_id);
          if (conn?.local.readyState !== WebSocket.CLOSED) conn?.local.close();
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
      this.emit("error", new Error((ev as ErrorEvent).message ?? "WebSocket error"));
    });
  }

  private handleNewConnection(connId: string): void {
    const agentUrl = `ws://localhost:${this.config.agentPort}`;
    this.emit("log", `[relay] new_connection ${connId} → connecting to ${agentUrl}`);

    try {
      const localWs = new WebSocket(agentUrl);
      localWs.binaryType = "arraybuffer";

      localWs.addEventListener("open", () => {
        this.emit("log", `[relay] local WS open for ${connId}`);
        // Tell server we're ready to receive data for this conn_id
        this.sendControlMessage({ type: "open_ack", conn_id: connId });
        this.localConnections.set(connId, { local: localWs, connId });
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
      const cleanup = (reason?: string) => {
        if (cleaned) return;
        cleaned = true;
        this.emit("log", `[relay] local WS cleanup for ${connId}: ${reason ?? "unknown"}`);
        if (localWs.readyState !== WebSocket.CLOSED) localWs.close();
        this.localConnections.delete(connId);
        // Notify server that this connection is done
        this.sendControlMessage({ type: "close", conn_id: connId });
      };

      localWs.addEventListener("close", () => cleanup("close"));
      localWs.addEventListener("error", (ev) => {
        const msg = (ev as ErrorEvent).message ?? "unknown error";
        this.emit("log", `[relay] local WS error for ${connId}: ${msg}`);
        cleanup(`error: ${msg}`);
      });
    } catch (err) {
      this.emit("log", `[relay] Failed to connect local agent for ${connId}: ${err}`);
    }
  }
}
