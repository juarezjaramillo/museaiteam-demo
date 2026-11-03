import { useEffect, useState } from "react";
import { api } from "../api.js";
import { monthLabel, nextTier, usd } from "@museaiteam/shared";

interface BillingInfo {
  subscribed: boolean;
  subStatus: string;
  seats: number;
  meter: {
    month: string;
    totalTokens: number;
    seats: number;
    allowance: number;
    perWorker: number;
    throttled: boolean;
  };
  pricePerWorker: string;
  unitCents: number;
  checkoutReady: boolean;
}

export function Billing({ org }: { org: string }) {
  const [info, setInfo] = useState<BillingInfo | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getBilling(org)
      .then(setInfo)
      .catch((e) => setNote(String(e)));
  }, [org]);

  async function subscribe() {
    setBusy(true);
    try {
      const { url } = await api.createCheckout(org);
      location.href = url;
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!info) return <section>{note || "…"}</section>;
  const monthly = (info.unitCents * info.seats) / 100;
  const nx = nextTier(info.seats);
  return (
    <section>
      <div className="page-head">
        <h1>Billing</h1>
      </div>
      <p className="page-sub">Workers get cheaper as you add more — down to $299 each. Cancel anytime.</p>
      {note && <p className="error">{note}</p>}
      {info.subStatus === "past_due" && (
        <div className="banner warn">
          Your card failed — Stripe is retrying. Update it to avoid a pause.
        </div>
      )}
      {info.subscribed ? (
        <p>
          <span className="badge good">Active</span>
        </p>
      ) : (
        <p>
          <span className="badge warn">Trial</span>
        </p>
      )}
      <p>
        {info.seats} worker{info.seats === 1 ? "" : "s"} × {info.pricePerWorker} = $
        {monthly.toLocaleString("en-US")}/month.
      </p>
      <p className="dim">
        {nx
          ? `Add ${nx.at - info.seats} more to pay ${usd(nx.cents)} each.`
          : "You're at the best price."}
      </p>
      <p className={info.meter.throttled ? "error" : "dim"}>
        {monthLabel(info.meter.month) || "This month"}:{" "}
        {info.meter.totalTokens.toLocaleString("en-US")} of{" "}
        {info.meter.allowance.toLocaleString("en-US")} tokens (
        {info.meter.perWorker.toLocaleString("en-US")} each).
        {info.meter.throttled && " Slowed to 1 session a day until reset."}
      </p>
      {!info.subscribed &&
        (info.checkoutReady ? (
          <button className="primary" onClick={subscribe} disabled={busy}>
            {busy ? "…" : `Subscribe — $${monthly.toLocaleString("en-US")}/month`}
          </button>
        ) : (
          <p className="dim">Checkout unlocks once Stripe keys are set.</p>
        ))}
      <p>
        <a href={api.auditCsvUrl(org)} download>
          Download history (spreadsheet)
        </a>
      </p>
    </section>
  );
}
