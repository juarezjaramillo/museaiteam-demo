import { useEffect, useState } from "react";
import { LIVE_PROVIDERS, SEAT_ROLES } from "@museaiteam/shared";
import { api, type GuardrailRow, type TeamRow } from "../api.js";

function GuardEditor({
  org,
  row,
  onSaved,
}: {
  org: string;
  row: GuardrailRow;
  onSaved: () => void;
}) {
  const [systems, setSystems] = useState(row.systems.join(", "));
  const [scope, setScope] = useState(row.write_scope.join(", "));
  const [cap, setCap] = useState(String(row.spend_cap_cents));
  const [escalate, setEscalate] = useState(row.escalate_on.join(", "));
  const [busy, setBusy] = useState(false);
  const split = (s: string) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  async function save() {
    setBusy(true);
    try {
      await api.putGuardrails(org, {
        worker_role: row.worker_role,
        systems: split(systems),
        write_scope: split(scope),
        spend_cap_cents: Number(cap) || 0,
        escalate_on: split(escalate),
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <span className={`role role-${row.worker_role}`}>{row.worker_role}</span>
        {!row.configured && <span className="dim"> · default</span>}
      </td>
      <td>
        <input value={systems} onChange={(e) => setSystems(e.target.value)} />
      </td>
      <td>
        <input value={scope} onChange={(e) => setScope(e.target.value)} />
      </td>
      <td>
        <input
          className="narrow"
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          title="0 = unlimited"
        />
      </td>
      <td>
        <button onClick={save} disabled={busy}>
          Save
        </button>
      </td>
    </tr>
  );
}

function IdeasEditor({ org }: { org: string }) {
  const [cap, setCap] = useState("250000");
  const [grace, setGrace] = useState("72");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api
      .getOrg(org)
      .then((g) => {
        setCap(String(g.ideas.cap));
        setGrace(String(g.ideas.graceHours));
      })
      .catch(() => {});
  }, [org]);

  async function save() {
    setMsg("");
    try {
      await api.putSettings(org, {
        idea_allowance_words: Number(cap) || 0,
        proposal_grace_hours: Math.min(168, Math.max(24, Number(grace) || 72)),
      });
      setMsg("Saved");
    } catch (e) {
      setMsg(String(e));
    }
  }

  return (
    <div>
      <p className="dim">
        What the team may spend on its own ideas each night, and how long
        an idea waits for you before starting on its own.
      </p>
      <div className="row">
        <label>
          Nightly idea words <input value={cap} onChange={(e) => setCap(e.target.value)} />
        </label>
        <label>
          Idea wait (hours, 24–168){" "}
          <input className="narrow" value={grace} onChange={(e) => setGrace(e.target.value)} />
        </label>
        <button onClick={save}>Save</button>
        {msg && <span className="dim">{msg}</span>}
      </div>
    </div>
  );
}

export function Setup({ org }: { org: string }) {
  const [guards, setGuards] = useState<GuardrailRow[]>([]);
  const [conns, setConns] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [token, setToken] = useState("");
  const [repo, setRepo] = useState("");
  const [note, setNote] = useState("");
  const [shop, setShop] = useState("");
  const [parent, setParent] = useState("");
  const [savedParent, setSavedParent] = useState("");
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [hireRole, setHireRole] = useState<string>("designer");
  const [products, setProducts] = useState<Array<{ id: string; title: string }>>([]);

  async function loadGuards() {
    setGuards(await api.getGuardrails(org));
  }

  async function loadConns() {
    setConns(await api.getConnections(org));
  }

  async function loadParent() {
    const { config } = await api.getProviderConfig(org, "notion");
    if (typeof config.parentPageId === "string") {
      setSavedParent(config.parentPageId);
    }
  }

  async function loadTeams() {
    setTeams((await api.getTeams(org)).teams);
  }

  useEffect(() => {
    loadGuards().catch((e) => setNote(String(e)));
    loadConns().catch((e) => setNote(String(e)));
    loadParent().catch(() => setSavedParent(""));
    loadTeams().catch((e) => setNote(String(e)));
    api
      .getProducts(org)
      .then((p) => setProducts(p.products))
      .catch(() => setProducts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  async function hire(teamId: string) {
    try {
      const seat = await api.hireSeat(org, teamId, hireRole);
      setNote(
        seat.overflow
          ? `Hired ${hireRole} — team was full, so we opened a second team.`
          : `Hired ${hireRole} — approve the role to let it join in.`,
      );
      await loadTeams();
    } catch (e) {
      setNote(String(e));
    }
  }

  async function approve(seatId: string) {
    try {
      await api.approveSeat(org, seatId);
      await loadTeams();
    } catch (e) {
      setNote(String(e));
    }
  }

  async function saveParent() {
    try {
      await api.putProviderConfig(org, "notion", { parentPageId: parent });
      setSavedParent(parent);
      setNote("Notion parent page saved.");
    } catch (e) {
      setNote(String(e));
    }
  }

  async function upload() {
    if (!file) return;
    const r = await api.ingestUpload(org, file);
    setNote(`Ingested ${file.name}: ${r.chunks} chunks, ${r.bytes} bytes.`);
  }

  async function ingestRepo() {
    const r = await api.ingestGithub(org, token, repo);
    setToken("");
    setNote(`Ingested ${repo}: ${r.files} docs, ${r.chunks} chunks.`);
  }

  return (
    <div>
      <div className="page-head">
        <h1>Setup</h1>
      </div>
      <p className="page-sub">Connections, memory, roles, limits.</p>
      <section>
      <h2>Connections</h2>
      <div className="card">
        {LIVE_PROVIDERS.map((p) => (
          <div className="conn-row" key={p}>
            <strong>{p}</strong>
            {conns[p] === "connected" ? (
              <span className="badge soft">connected</span>
            ) : conns[p] === "expired" ? (
              <span>
                <span className="badge warn">expired</span>{" "}
                <a href={api.connectUrl(org, p)}>
                  <button className="sm">Reconnect</button>
                </a>
              </span>
            ) : p === "shopify" ? (
              <span>
                <input
                  placeholder="your-store.myshopify.com"
                  value={shop}
                  onChange={(e) => setShop(e.target.value)}
                />{" "}
                {shop.trim() ? (
                  <a
                    href={api.connectUrl(
                      org,
                      p,
                      `&shop=${encodeURIComponent(shop.trim())}`,
                    )}
                  >
                      <button className="sm">Connect</button>
                  </a>
                ) : (
                  <button className="sm" disabled>Connect</button>
                )}
              </span>
            ) : (
              <a href={api.connectUrl(org, p)}>
                <button className="sm">Connect</button>
              </a>
            )}
          </div>
        ))}
      </div>
      <div className="row">
        <button className="sm" onClick={loadConns}>Refresh status</button>
      </div>
      <div className="row">
        <input
          placeholder="Notion parent page ID"
          title="Decision pages land here"
          value={parent}
          onChange={(e) => setParent(e.target.value)}
        />
        <button className="sm" onClick={saveParent} disabled={!parent.trim()}>
          Save
        </button>
        {savedParent && <span className="dim">saved: {savedParent}</span>}
      </div>
      {conns.shopify === "connected" && (
        <p className="dim">
          Showcase product for demos/reverts:{" "}
          {products.length === 0 ? (
            "pick via provider config — no products found."
          ) : (
            <select
              onChange={(e) => {
                if (e.target.value) {
                  api
                    .putProviderConfig(org, "shopify", { productId: e.target.value })
                    .then(() => setNote("Showcase product saved."))
                    .catch((err) => setNote(String(err)));
                }
              }}
              defaultValue=""
            >
              <option value="">Pick showcase product…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          )}
        </p>
      )}

      <details>
        <summary className="sum-h">Team memory</summary>
        <div className="row">
          <input
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button onClick={upload} disabled={!file}>
            Upload
          </button>
        </div>
        <div className="row">
          <input
            type="password"
            placeholder="GitHub access token (used once, never kept)"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <input
            placeholder="owner/repo"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
          <button onClick={ingestRepo} disabled={!token || !repo}>
            Add repo docs
          </button>
        </div>
      </details>
      {note && <p>{note}</p>}

      <h2>Teams</h2>
      <p className="dim">
        Hire roles, approve each once. Teams hold 7 — the 8th hire opens
        a second team.
      </p>
      {teams.map((t) => (
        <div key={t.id}>
          <strong>{t.name}</strong>{" "}
          {t.seats.map((s) => (
            <span key={s.id}>
              <span className={`role role-${s.role}`}>{s.role}</span>
              {s.approved ? (
                <span className="badge soft">active</span>
              ) : (
                <button className="sm" onClick={() => approve(s.id)}>Approve</button>
              )}{" "}
            </span>
          ))}
          <div className="row">
            <select
              value={hireRole}
              onChange={(e) => setHireRole(e.target.value)}
            >
              {SEAT_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button onClick={() => hire(t.id)}>Hire</button>
          </div>
        </div>
      ))}

      <h2>Limits</h2>
      <p className="dim">
        The only settings. What each hire may touch, and how much it may spend.
      </p>
      <table className="guards">
        <thead>
          <tr>
            <th>Worker</th>
            <th>Tools</th>
            <th>Allowed to change</th>
            <th>Max spend</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {guards.map((g) => (
            <GuardEditor
              key={g.worker_role}
              org={org}
              row={g}
              onSaved={loadGuards}
            />
          ))}
        </tbody>
      </table>
      <p className="dim">Spend is in cents. 0 means no limit.</p>

      <h2>Ideas</h2>
      <IdeasEditor org={org} />

      <h2>Help</h2>
      <p className="dim">
        Stuck? Write to{" "}
        <a href="mailto:support@fernwaylabs.com">support@fernwaylabs.com</a>{" "}
        — a human replies within a day. System health:{" "}
        <a
          href="https://museaiteam-api.juarezjaramillo.workers.dev/status"
          target="_blank"
          rel="noreferrer"
        >
          status
        </a>.
      </p>
      </section>
    </div>
  );
}
