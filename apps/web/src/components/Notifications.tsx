import { useEffect, useState } from "react";
import { api, type NotificationRow } from "../api.js";
import { noticeLabel } from "@museaiteam/shared";

export function Notifications({
  org,
  onRun,
  refreshKey,
  onRead,
}: {
  org: string;
  onRun: (id: string) => void;
  refreshKey: number;
  onRead: () => void;
}) {
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);

  useEffect(() => {
    api
      .getNotifications(org, unreadOnly)
      .then((r) => setRows(r.notifications))
      .catch(() => setRows([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, unreadOnly, refreshKey]);

  function open(n: NotificationRow) {
    if (n.read === 0) {
      api.readNotification(org, n.id).then(onRead).catch(() => undefined);
    }
    const m = n.link.match(/^run:(.+)$/);
    if (m) onRun(m[1]);
  }

  const seen = new Set<string>();
  const fresh = rows.filter((n) => {
    if (!n.link || !seen.has(n.link)) {
      if (n.link) seen.add(n.link);
      return true;
    }
    return false;
  });

  return (
    <div>
      <div className="page-head">
        <h1>Alerts</h1>
        <label className="check">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => setUnreadOnly(e.target.checked)}
          />{" "}
          unread only
        </label>
      </div>
      <p className="page-sub">Results, approvals, check-ins, and usage warnings.</p>
      <ul className="list">
        {fresh.map((n) => (
          <li key={n.id} className={n.read ? "read" : "unread"}>
            <button className="link" onClick={() => open(n)}>
              {n.title}
            </button>{" "}
            <span className="dim">{noticeLabel(n.kind)}</span>
            <p className="dim">{n.body}</p>
          </li>
        ))}
      </ul>
      {fresh.length === 0 && (
        <div className="empty">
          <strong>All caught up</strong>
          New activity lands here.
        </div>
      )}
    </div>
  );
}
