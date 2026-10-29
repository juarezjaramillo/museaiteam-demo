import { useEffect, useState } from "react";
import { api } from "../api.js";

interface BillingInfo {
  subscribed: boolean;
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
  const monthly = 499 * info.seats;
  return (
    <section>
      <div className="page-head">
        <h1>Billing</h1>
      </div>
      <p className="page-sub">$499 per worker per month. Cancel anytime.</p>
      {note && <p className="error">{note}</p>}
      {info.subscribed ? (
        <p>
          <span className="badge">subscription active</span>
        </p>
      ) : (
        <p>
          {info.pricePerWorker}/worker/month · {info.seats} seats = $
          {monthly.toLocaleString("en-US")}/month.
        </p>
      )}
      <p className={info.meter.throttled ? "error" : "dim"}>
        Usage ({info.meter.month || "this month"}):{" "}
        {info.meter.totalTokens.toLocaleString("en-US")} of{" "}
        {info.meter.allowance.toLocaleString("en-US")} words (
        {info.meter.perWorker.toLocaleString("en-US")} per worker).
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
