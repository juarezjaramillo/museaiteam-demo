import { useEffect, useState } from "react";
import { api, type HireRow } from "../api.js";
import { ThumbDown, ThumbUp } from "./icons.js";

export function Hires({ org }: { org: string }) {
  const [hires, setHires] = useState<HireRow[]>([]);

  useEffect(() => {
    api.getHires(org).then((h) => setHires(h.hires)).catch(() => setHires([]));
  }, [org]);

  return (
    <div>
      <div className="page-head">
        <h1>Hires</h1>
      </div>
      <p className="page-sub">Every hire's record: sessions, ships, ratings, spend.</p>
      <table className="tbl">
        <thead>
          <tr>
            <th>Role</th>
            <th>Sessions</th>
            <th>Suggestions</th>
            <th>Agreement</th>
            <th>Shipped</th>
            <th title="Thumbs up"><ThumbUp /></th>
            <th title="Thumbs down"><ThumbDown /></th>
            <th>Words</th>
          </tr>
        </thead>
        <tbody>
          {hires.map((h) => (
            <tr key={h.role}>
              <td><span className={`role role-${h.role}`}>{h.role}</span></td>
              <td>{h.runs}</td>
              <td>{h.proposals}</td>
              <td>{h.votes}</td>
              <td>{h.shipped}</td>
              <td>{h.up}</td>
              <td>{h.down}</td>
              <td>
                {h.tokens.toLocaleString()}
                {h.tokensEstimated && <span title="Split evenly across the team"> (guess)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {hires.length === 0 && (
        <div className="empty">
          <strong>No activity yet</strong>
          Hire records appear after the first session.
        </div>
      )}
    </div>
  );
}
