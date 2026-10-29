import { useState } from "react";
import type { Baseline as BaselineData } from "@museaiteam/shared";
import { api } from "../api.js";

export function Baseline({
  runId,
  teamTokens,
}: {
  runId: string;
  teamTokens: number;
}) {
  const [data, setData] = useState<(BaselineData & { fresh: boolean }) | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    setBusy(true);
    setError("");
    try {
      setData(await api.runBaseline(runId));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>One try vs the team</h2>
      <p className="dim">
        Same model, one shot, no team. Saved per session.
      </p>
      <div className="row">
        <button onClick={run} disabled={busy}>
          {data ? "Show comparison" : "Compare"}
        </button>
        {data && (
          <span className="meter">
            one try {data.tokens.toLocaleString()} words vs team{" "}
            {teamTokens.toLocaleString()}
            {!data.fresh && " · saved"}
          </span>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {data && (
        <div className="card baseline">
          <div className="card-head">
            <span className="badge">comparison</span>
          </div>
          <strong>{data.title}</strong>
          <details open>
            <summary>The single try</summary>
            <pre>{data.body}</pre>
          </details>
        </div>
      )}
    </section>
  );
}
