import { Container } from "@cloudflare/containers";
import type { Env } from "./bindings.js";

/**
 * One HireBox durable object per seat (`getByName(seatId)`): the seat id
 * IS the box id, so no mapping can drift. Internal `__do/*` paths are
 * handled here and never reach the container; everything else proxies
 * to the driver, waking the box first.
 */
export class HireBox extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";

  private get seatId(): string {
    return this.ctx.id.name ?? "unknown";
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/__do/destroy" && req.method === "POST") {
      await this.destroy();
      return Response.json({ ok: true });
    }
    return super.fetch(req);
  }

  override async onStart(): Promise<void> {
    await this.ctx.storage.put("startedAt", Date.now());
  }

  override async onStop(): Promise<void> {
    const startedAt = ((await this.ctx.storage.get<number>("startedAt")) ?? Date.now()) as number;
    const now = Date.now();
    const seconds = Math.max(1, Math.round((now - startedAt) / 1000));
    try {
      await this.env.DB.prepare(
        "UPDATE box_runs SET stopped_at = ?, seconds = ? WHERE seat_id = ? AND stopped_at = 0",
      )
        .bind(now, seconds, this.seatId)
        .run();
      await this.env.DB.prepare("UPDATE box_state SET status = 'sleeping', last_tick = ? WHERE seat_id = ?")
        .bind(now, this.seatId)
        .run();
    } catch {
      // Metering retries via the reconciler; a failed write here must
      // never break the stop itself.
    }
  }
}
