import type { FeedEvent } from "@museaiteam/shared";

/**
 * One object per goal run. Browsers hold a hibernatable WebSocket; the
 * Worker and Workflow POST events here for fan-out. Day 4 wires the
 * dashboard feed to this.
 */
export class RunFeed {
  constructor(
    private state: DurableObjectState,
    private env: unknown,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/publish") {
      const event = (await req.json()) as FeedEvent;
      for (const ws of this.state.getWebSockets()) {
        ws.send(JSON.stringify(event));
      }
      return Response.json({ delivered: this.state.getWebSockets().length });
    }
    if (req.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("RunFeed: use WebSocket upgrade or POST /publish", {
      status: 426,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    ws.send(typeof message === "string" ? message : "[binary]");
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) {
    ws.close(code, wasClean ? reason : "dropped");
  }
}
