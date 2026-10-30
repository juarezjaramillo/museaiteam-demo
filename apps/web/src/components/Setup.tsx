import { useEffect, useState, type ReactNode } from "react";
import { LIVE_PROVIDERS, SEAT_ROLES } from "@museaiteam/shared";
import { api, type GuardrailRow, type McpCatalogEntry, type McpServer, type TeamRow } from "../api.js";
import { GoButton } from "./GoButton.js";

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

function Step({
  n,
  title,
  sub,
  done,
  children,
}: {
  n: number;
  title: string;
  sub: string;
  done: boolean;
  children: ReactNode;
}) {
  return (
    <section className="step">
      <div className="step-head">
        <span className="step-num">{n}</span>
        <div className="grow">
          <h2>{title}</h2>
          <p className="dim">{sub}</p>
        </div>
        {done ? (
          <span className="badge soft">done</span>
        ) : (
          <span className="badge warn">needs you</span>
        )}
      </div>
      <div className="card">{children}</div>
    </section>
  );
}

function ToolsStep({
  org,
  conns,
  retiring,
  servers,
  catalog,
  notify,
  reload,
}: {
  org: string;
  conns: Record<string, string>;
  retiring: Record<string, string>;
  servers: McpServer[];
  catalog: McpCatalogEntry[];
  notify: (m: string) => void;
  reload: () => void;
}) {
  const [shop, setShop] = useState("");
  const [parent, setParent] = useState("");
  const [savedParent, setSavedParent] = useState("");
  const [products, setProducts] = useState<Array<{ id: string; title: string }>>([]);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api
      .getProviderConfig(org, "notion")
      .then(({ config }) => {
        if (typeof config.parentPageId === "string") setSavedParent(config.parentPageId);
      })
      .catch(() => setSavedParent(""));
    api
      .getProducts(org)
      .then((p) => setProducts(p.products))
      .catch(() => setProducts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, conns.shopify]);

  async function saveParent() {
    try {
      await api.putProviderConfig(org, "notion", { parentPageId: parent });
      setSavedParent(parent);
      notify("Notion parent page saved.");
    } catch (e) {
      notify(String(e));
    }
  }

  async function add(body: Record<string, unknown>) {
    setMsg("");
    try {
      const r = await api.addMcp(org, body);
      setMsg(
        r.server.status === "trusted"
          ? `Added ${r.server.name} — ${r.tools.length} tools ready.`
          : `Added ${r.server.name} — it asks for trust on first use.`,
      );
      setUrl("");
      setSecret("");
      reload();
    } catch (e) {
      setMsg(String(e));
    }
  }

  async function saveSecret(id: string) {
    setMsg("");
    try {
      await api.putMcpSecret(org, id, secret);
      setMsg("Key saved.");
      setSecret("");
      reload();
    } catch (e) {
      setMsg(String(e));
    }
  }

  async function saveCap(id: string, dollars: string) {
    setMsg("");
    try {
      await api.putMcpCap(org, id, Math.round(Number(dollars) * 100) || 0);
      setMsg("Cap saved.");
      reload();
    } catch (e) {
      setMsg(String(e));
    }
  }

  async function trust(id: string, status: "trusted" | "rejected") {
    setMsg("");
    try {
      await api.trustMcp(org, id, status);
      reload();
    } catch (e) {
      setMsg(String(e));
    }
  }

  async function remove(id: string) {
    setMsg("");
    try {
      await api.deleteMcp(org, id);
      reload();
    } catch (e) {
      setMsg(String(e));
    }
  }

  return (
    <div>
      <p className="dim">
        Everything the team can use — built-in links and extra tool
        servers. Sensitive steps always ask you first.
      </p>
      {LIVE_PROVIDERS.map((p) => (
        <div className="conn-row" key={p}>
          <strong>{p}</strong>{" "}
          {conns[p] === "connected" ? (
            <span>
              <span className="badge soft">connected</span>{" "}
              {retiring[p] && (
                <span className="dim">
                  shared — move the {retiring[p]} hire to its own login (Hires page)
                </span>
              )}
            </span>
          ) : conns[p] === "expired" ? (
            <span>
              <span className="badge warn">expired</span>{" "}
              <GoButton href={api.connectUrl(org, p)} className="sm">Reconnect</GoButton>
            </span>
          ) : p === "shopify" ? (
            <span>
              <input
                placeholder="your-store.myshopify.com"
                value={shop}
                onChange={(e) => setShop(e.target.value)}
              />{" "}
              {shop.trim() ? (
                <GoButton
                  href={api.connectUrl(
                    org,
                    p,
                    `&shop=${encodeURIComponent(shop.trim())}`,
                  )}
                  className="sm"
                >
                  Connect
                </GoButton>
              ) : (
                <button className="sm" disabled>Connect</button>
              )}
            </span>
          ) : (
            <GoButton href={api.connectUrl(org, p)} className="sm">Connect</GoButton>
          )}
        </div>
      ))}
      {servers.map((s) => (
        <div className="conn-row" key={s.id}>
          <div>
            <strong>{s.name}</strong>{" "}
            <span className="dim">{s.url}</span>{" "}
            {s.status === "trusted" ? (
              <span className="badge soft">trusted</span>
            ) : s.status === "rejected" ? (
              <span className="badge warn">blocked</span>
            ) : (
              <span className="badge warn">asks on first use</span>
            )}{" "}
            {s.auth !== "none" && !s.hasSecret && (
              <span className="badge warn">
                {s.auth === "oauth" ? "needs sign-in" : "needs key"}
              </span>
            )}
          </div>
          <div className="row">
            {s.auth === "oauth" && !s.hasSecret && (
              <GoButton href={api.mcpConnectUrl(org, s.id)} className="sm">Connect</GoButton>
            )}
            {(s.auth === "header" || s.auth === "query") && !s.hasSecret && (
              <span>
                <input
                  type="password"
                  placeholder="API key"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />{" "}
                <button className="sm" onClick={() => saveSecret(s.id)} disabled={!secret}>
                  Save key
                </button>
                <div className="dim">
                  {catalog.find((c) => c.url === s.url)?.keyHelp || "Paste the service's API key."}
                </div>
              </span>
            )}
            <label>
              Max paid trials ${" "}
              <input
                className="narrow"
                defaultValue={(s.spendCapCents / 100).toFixed(0)}
                key={s.id + s.spendCapCents}
                onBlur={(e) => saveCap(s.id, e.target.value)}
                title="0 = paid plans always ask"
              />
            </label>
            {s.status === "pending" && (
              <span>
                <button className="sm" onClick={() => trust(s.id, "trusted")}>Trust</button>{" "}
                <button className="sm" onClick={() => trust(s.id, "rejected")}>Block</button>
              </span>
            )}
            {s.status === "rejected" && (
              <button className="sm" onClick={() => trust(s.id, "trusted")}>Trust</button>
            )}
            <button className="link" onClick={() => remove(s.id)}>Remove</button>
          </div>
        </div>
      ))}
      <details>
        <summary className="sum-h">Add more tools</summary>
        {catalog
          .filter((c) => !servers.some((s) => s.url === c.url))
          .map((c) => (
            <div className="conn-row" key={c.id}>
              <div>
                <strong>{c.name}</strong> <span className="dim">{c.blurb}</span>
              </div>
              <button className="sm" onClick={() => add({ catalogId: c.id })}>
                Add
              </button>
            </div>
          ))}
        <div className="row">
          <input
            placeholder="https://…/mcp"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            title="Remote servers only — paste the server's web address"
          />
          <button className="sm" onClick={() => add({ url })} disabled={!url.trim()}>
            Add
          </button>
        </div>
        <p className="dim">Remote servers only: paste the server's web address, not a command to run.</p>
      </details>
      <details>
        <summary className="sum-h">Fine-tuning</summary>
        <div className="row">
          <button className="sm" onClick={reload}>Refresh status</button>
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
                      .then(() => notify("Showcase product saved."))
                      .catch((err) => notify(String(err)));
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
      </details>
      {msg && <p>{msg}</p>}
    </div>
  );
}

function TeamStep({
  org,
  teams,
  notify,
  reload,
}: {
  org: string;
  teams: TeamRow[];
  notify: (m: string) => void;
  reload: () => void;
}) {
  const [hireRole, setHireRole] = useState<string>("designer");

  async function hire(teamId: string) {
    try {
      const seat = await api.hireSeat(org, teamId, hireRole);
      notify(
        seat.overflow
          ? `Hired ${hireRole} — team was full, so we opened a second team.`
          : `Hired ${hireRole} — approve the role to let it join in.`,
      );
      reload();
    } catch (e) {
      notify(String(e));
    }
  }

  async function approve(seatId: string) {
    try {
      await api.approveSeat(org, seatId);
      reload();
    } catch (e) {
      notify(String(e));
    }
  }

  return (
    <div>
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
    </div>
  );
}

function LimitCard({
  org,
  row,
  onSaved,
}: {
  org: string;
  row: GuardrailRow;
  onSaved: () => void;
}) {
  const [spend, setSpend] = useState((row.spend_cap_cents / 100).toFixed(0));
  const [busy, setBusy] = useState(false);

  async function saveSpend() {
    setBusy(true);
    try {
      await api.putGuardrails(org, {
        worker_role: row.worker_role,
        systems: row.systems,
        write_scope: row.write_scope,
        spend_cap_cents: Math.round(Number(spend) * 100) || 0,
        escalate_on: row.escalate_on,
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="conn-row">
      <div>
        <span className={`role role-${row.worker_role}`}>{row.worker_role}</span>{" "}
        {!row.configured ? (
          <span className="dim">safe defaults</span>
        ) : (
          <span className="dim">
            touches {row.systems.join(", ") || "nothing"} · changes{" "}
            {row.write_scope.join(", ") || "nothing"}
          </span>
        )}
      </div>
      <div className="row">
        <label>
          Max spend ${" "}
          <input
            className="narrow"
            value={spend}
            onChange={(e) => setSpend(e.target.value)}
            title="0 = no limit"
          />
        </label>
        <button className="sm" onClick={saveSpend} disabled={busy}>
          Save
        </button>
      </div>
    </div>
  );
}

function LimitsStep({
  org,
  guards,
  reload,
}: {
  org: string;
  guards: GuardrailRow[];
  reload: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);

  return (
    <div>
      <p className="dim">
        What each hire may touch, and how much it may spend. Defaults
        are safe — change only what you care about.
      </p>
      {guards.map((g) => (
        <LimitCard key={g.worker_role} org={org} row={g} onSaved={reload} />
      ))}
      <div className="row">
        <button className="link" onClick={() => setAdvanced(!advanced)}>
          {advanced ? "Hide advanced" : "Advanced: exact tools and scopes"}
        </button>
      </div>
      {advanced && (
        <div>
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
                  onSaved={reload}
                />
              ))}
            </tbody>
          </table>
          <p className="dim">Spend is in cents. 0 means no limit.</p>
        </div>
      )}
    </div>
  );
}

function MemoryBlock({ org, notify }: { org: string; notify: (m: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [token, setToken] = useState("");
  const [repo, setRepo] = useState("");

  async function upload() {
    if (!file) return;
    const r = await api.ingestUpload(org, file);
    notify(`Ingested ${file.name}: ${r.chunks} chunks, ${r.bytes} bytes.`);
  }

  async function ingestRepo() {
    const r = await api.ingestGithub(org, token, repo);
    setToken("");
    notify(`Ingested ${repo}: ${r.files} docs, ${r.chunks} chunks.`);
  }

  return (
    <div>
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
    </div>
  );
}

export function Setup({ org }: { org: string }) {
  const [guards, setGuards] = useState<GuardrailRow[]>([]);
  const [conns, setConns] = useState<Record<string, string>>({});
  const [retiring, setRetiring] = useState<Record<string, string>>({});
  const [servers, setServers] = useState<McpServer[]>([]);
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [note, setNote] = useState("");

  async function loadGuards() {
    setGuards(await api.getGuardrails(org));
  }

  async function loadConns() {
    const r = await api.getConnections(org);
    setConns(r.status);
    setRetiring(r.retiring);
  }

  async function loadMcp() {
    const r = await api.getMcp(org);
    setServers(r.servers);
    setCatalog(r.catalog);
  }

  async function loadTeams() {
    setTeams((await api.getTeams(org)).teams);
  }

  function reloadAll() {
    loadConns().catch((e) => setNote(String(e)));
    loadMcp().catch((e) => setNote(String(e)));
  }

  useEffect(() => {
    loadGuards().catch((e) => setNote(String(e)));
    loadConns().catch((e) => setNote(String(e)));
    loadMcp().catch((e) => setNote(String(e)));
    loadTeams().catch((e) => setNote(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  const toolsOn =
    Object.values(conns).filter((s) => s === "connected").length +
    servers.filter(
      (s) => s.status === "trusted" && (s.auth === "none" || s.hasSecret),
    ).length;
  const toolsNeed =
    Object.values(conns).filter((s) => s === "expired").length +
    servers.filter(
      (s) =>
        s.status === "pending" ||
        (s.auth !== "none" && !s.hasSecret && s.status !== "rejected"),
    ).length;
  const seats = teams.flatMap((t) => t.seats);
  const activeSeats = seats.filter((s) => s.approved).length;
  const waitingSeats = seats.length - activeSeats;
  const customGuards = guards.filter((g) => g.configured).length;

  return (
    <div>
      <div className="page-head">
        <h1>Setup</h1>
      </div>
      <p className="page-sub">Three steps to a working team.</p>
      {note && <p>{note}</p>}

      <Step
        n={1}
        title="Tools"
        sub={
          toolsOn === 0 && toolsNeed === 0
            ? "Connect the first one."
            : `${toolsOn} on${toolsNeed > 0 ? `, ${toolsNeed} need${toolsNeed === 1 ? "s" : ""} you` : ""}`
        }
        done={toolsOn > 0}
      >
        <ToolsStep
          org={org}
          conns={conns}
          retiring={retiring}
          servers={servers}
          catalog={catalog}
          notify={setNote}
          reload={reloadAll}
        />
      </Step>

      <Step
        n={2}
        title="Team"
        sub={
          seats.length === 0
            ? "Hire the first role."
            : `${activeSeats} active${waitingSeats > 0 ? `, ${waitingSeats} waiting approval` : ""}`
        }
        done={activeSeats > 0}
      >
        <TeamStep org={org} teams={teams} notify={setNote} reload={loadTeams} />
      </Step>

      <Step
        n={3}
        title="Limits"
        sub={
          customGuards === 0
            ? "Safe defaults — change only what you care about."
            : `${customGuards} customized.`
        }
        done
      >
        <LimitsStep org={org} guards={guards} reload={loadGuards} />
      </Step>

      <details>
        <summary className="sum-h">More: ideas, memory, help</summary>
        <h2>Ideas</h2>
        <IdeasEditor org={org} />
        <h2>Team memory</h2>
        <MemoryBlock org={org} notify={setNote} />
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
      </details>
    </div>
  );
}
