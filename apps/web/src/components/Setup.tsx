import { useEffect, useState, type ReactNode } from "react";
import {
  CREATIVE_SCOPE,
  CREATIVE_SYSTEM,
  LIVE_PROVIDERS,
  PROVIDER_IDS,
  SEAT_ROLES,
  WRITE_SCOPES,
  isKnownProvider,
  providerLabel,
  roleLabel,
  scopeLabel,
} from "@museaiteam/shared";
import { api, type GuardrailRow, type McpCatalogEntry, type McpServer, type MemberRow, type TeamRow } from "../api.js";
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
  const [systems, setSystems] = useState<string[]>(row.systems);
  const [scope, setScope] = useState<string[]>(row.write_scope);
  const [busy, setBusy] = useState(false);
  const knownScopeIds = new Set(
    PROVIDER_IDS.flatMap((p) => WRITE_SCOPES[p].map((s) => s.id)),
  );
  // Values typed before the pickers existed ride along untouched —
  // shown as removable tags, never silently dropped by a save.
  // The studio has real pickers below, so it never shows as custom.
  const customSystems = systems.filter((s) => s !== CREATIVE_SYSTEM && !isKnownProvider(s));
  const customScopes = scope.filter((s) => s !== CREATIVE_SCOPE && !knownScopeIds.has(s));

  function toggle(list: string[], v: string): string[] {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  }

  function toggleSystem(p: string) {
    const next = toggle(systems, p);
    // A change without its system is always denied, so unchecking a
    // system drops its changes too — the dead combo can't be saved.
    setSystems(next);
    if (!next.includes(p)) {
      if (p === CREATIVE_SYSTEM) {
        setScope((prev) => prev.filter((s) => s !== CREATIVE_SCOPE));
      } else if (isKnownProvider(p)) {
        const ids = new Set(WRITE_SCOPES[p].map((s) => s.id));
        setScope((prev) => prev.filter((s) => !ids.has(s)));
      }
    }
  }

  function toggleScope(system: string, id: string) {
    setScope((prev) => toggle(prev, id));
    // A change implies its system — checking one checks the other.
    if (!scope.includes(id) && !systems.includes(system)) {
      setSystems((prev) => [...prev, system]);
    }
  }

  async function save() {
    setBusy(true);
    try {
      await api.putGuardrails(org, {
        worker_role: row.worker_role,
        systems,
        write_scope: scope,
        // Spend caps are not enforced yet: pass the stored value
        // through untouched instead of offering a dead control.
        spend_cap_cents: row.spend_cap_cents,
        escalate_on: row.escalate_on,
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <span className={`role role-${row.worker_role}`}>{roleLabel(row.worker_role)}</span>
        {!row.configured && <span className="dim"> · default</span>}
      </td>
      <td>
        {PROVIDER_IDS.map((p) => (
          <label className="ask-tool" key={p}>
            <input
              type="checkbox"
              checked={systems.includes(p)}
              onChange={() => toggleSystem(p)}
            />
            <span>{providerLabel(p)}</span>
          </label>
        ))}
        <label className="ask-tool" key={CREATIVE_SYSTEM}>
          <input
            type="checkbox"
            checked={systems.includes(CREATIVE_SYSTEM)}
            onChange={() => toggleSystem(CREATIVE_SYSTEM)}
          />
          <span>{providerLabel(CREATIVE_SYSTEM)}</span>
        </label>
        {customSystems.map((s) => (
          <span className="dim" key={s}>
            Also: {s}{" "}
            <button className="link sm" onClick={() => setSystems(systems.filter((x) => x !== s))}>
              remove
            </button>
          </span>
        ))}
      </td>
      <td>
        {PROVIDER_IDS.filter((p) => systems.includes(p)).map((p) => (
          <div key={p}>
            <span className="dim">{providerLabel(p)}</span>
            {WRITE_SCOPES[p].map((s) => (
              <label className="ask-tool" key={s.id}>
                <input
                  type="checkbox"
                  checked={scope.includes(s.id)}
                  onChange={() => toggleScope(p, s.id)}
                />
                <span>{s.label}</span>
              </label>
            ))}
          </div>
        ))}
        {systems.includes(CREATIVE_SYSTEM) && (
          <div key={CREATIVE_SYSTEM}>
            <span className="dim">{providerLabel(CREATIVE_SYSTEM)}</span>
            <label className="ask-tool" key={CREATIVE_SCOPE}>
              <input
                type="checkbox"
                checked={scope.includes(CREATIVE_SCOPE)}
                onChange={() => toggleScope(CREATIVE_SYSTEM, CREATIVE_SCOPE)}
              />
              <span>{scopeLabel(CREATIVE_SCOPE)}</span>
            </label>
          </div>
        )}
        {customScopes.map((s) => (
          <span className="dim" key={s}>
            Also: {s}{" "}
            <button className="link sm" onClick={() => setScope(scope.filter((x) => x !== s))}>
              remove
            </button>
          </span>
        ))}
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
          Nightly idea words{" "}
          <input
            type="number"
            min={0}
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
        </label>
        <label>
          Idea wait (hours){" "}
          <input
            type="number"
            className="narrow"
            min={24}
            max={168}
            value={grace}
            onChange={(e) => setGrace(e.target.value)}
          />
        </label>
        <button onClick={save}>Save</button>
        {msg && <span className="dim">{msg}</span>}
      </div>
    </div>
  );
}

const PROFILE_FIELDS: Array<{ key: string; label: string; area?: boolean }> = [
  { key: "icp", label: "Ideal customer", area: true },
  { key: "offering", label: "Offering", area: true },
  { key: "customer_count", label: "Customers" },
  { key: "employee_count", label: "Employees" },
  { key: "help_center", label: "Help center", area: true },
  { key: "pricing", label: "Pricing", area: true },
  { key: "tone", label: "Tone of voice", area: true },
  { key: "competitors", label: "Competitors", area: true },
  { key: "complaint_themes", label: "Complaint themes", area: true },
  { key: "tools", label: "Tools", area: true },
];

function CompanyProfile({ org }: { org: string }) {
  const [profile, setProfile] = useState<Record<string, string>>({});
  const [website, setWebsite] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api
      .getProfile(org)
      .then(({ profile }) => setProfile(profile))
      .catch(() => {});
    api
      .getOrg(org)
      .then((g) => setWebsite(g.websiteUrl ?? ""))
      .catch(() => {});
  }, [org]);

  async function save() {
    setMsg("");
    try {
      const patch: Record<string, string> = {};
      for (const f of PROFILE_FIELDS) patch[f.key] = profile[f.key] ?? "";
      const { profile: saved } = await api.putProfile(org, patch);
      setProfile(saved);
      await api.putSettings(org, { website_url: website });
      setMsg("Saved");
    } catch (e) {
      setMsg(String(e));
    }
  }

  return (
    <div>
      <p className="dim">
        Gathered from your connected tools and refreshed weekly. Edit
        anything — your words win and are never overwritten.
      </p>
      <div className="row">
        <label>
          Website{" "}
          <input
            placeholder="https://…"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </label>
      </div>
      {PROFILE_FIELDS.map((f) => (
        <div className="row" key={f.key}>
          <label>
            {f.label}{" "}
            {f.area ? (
              <textarea
                rows={2}
                value={profile[f.key] ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, [f.key]: e.target.value }))}
              />
            ) : (
              <input
                className="narrow"
                value={profile[f.key] ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, [f.key]: e.target.value }))}
              />
            )}
          </label>
        </div>
      ))}
      <div className="row">
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

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function ServerKeyForm({
  org,
  server,
  keyHelp,
  reload,
  notify,
}: {
  org: string;
  server: McpServer;
  keyHelp: string;
  reload: () => void;
  notify: (m: string) => void;
}) {
  const [secret, setSecret] = useState("");
  async function save() {
    try {
      await api.putMcpSecret(org, server.id, secret);
      setSecret("");
      notify("Key saved.");
      reload();
    } catch (e) {
      notify(String(e));
    }
  }
  return (
    <span>
      <input
        type="password"
        placeholder="API key"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
      />{" "}
      <button className="sm" onClick={save} disabled={!secret}>
        Save key
      </button>
      <div className="dim">{keyHelp}</div>
    </span>
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
  const [digestCh, setDigestCh] = useState("");
  const [savedDigestCh, setSavedDigestCh] = useState("");
  const [storePw, setStorePw] = useState("");
  const [storePwSaved, setStorePwSaved] = useState(false);
  const [replacingPw, setReplacingPw] = useState(false);
  const [products, setProducts] = useState<Array<{ id: string; title: string }>>([]);
  const [url, setUrl] = useState("");
  const [q, setQ] = useState("");
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
    api
      .getProviderConfig(org, "shopify")
      .then(({ config }) => setStorePwSaved(config.storePasswordSaved === true))
      .catch(() => setStorePwSaved(false));
    api
      .getProviderConfig(org, "slack")
      .then(({ config }) => {
        if (typeof config.digest_channel === "string") setSavedDigestCh(config.digest_channel);
      })
      .catch(() => setSavedDigestCh(""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, conns.shopify, conns.slack]);

  async function saveParent() {
    try {
      await api.putProviderConfig(org, "notion", { parentPageId: parent });
      setSavedParent(parent);
      notify("Notion parent page saved.");
    } catch (e) {
      notify(String(e));
    }
  }

  async function saveDigestCh() {
    try {
      await api.putProviderConfig(org, "slack", { digest_channel: digestCh });
      setSavedDigestCh(digestCh);
      notify("Digest channel saved.");
    } catch (e) {
      notify(String(e));
    }
  }

  async function saveStorePw() {
    try {
      await api.putProviderConfig(org, "shopify", { storePassword: storePw });
      setStorePw("");
      setStorePwSaved(true);
      setReplacingPw(false);
      notify("Store password saved.");
    } catch (e) {
      notify(String(e));
    }
  }

  async function clearStorePw() {
    try {
      await api.putProviderConfig(org, "shopify", { storePassword: "" });
      setStorePw("");
      setStorePwSaved(false);
      setReplacingPw(false);
      notify("Store password removed.");
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

  async function disconnect(p: string) {
    setMsg("");
    try {
      await api.disconnectProvider(org, p);
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
          <strong>{providerLabel(p)}</strong>{" "}
          {conns[p] === "connected" ? (
            <span>
              <span className="badge soft">connected</span>{" "}
              <button className="sm" onClick={() => disconnect(p)}>
                Disconnect
              </button>{" "}
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
            <span className="dim">{hostOf(s.url)}</span>{" "}
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
              <ServerKeyForm
                org={org}
                server={s}
                keyHelp={catalog.find((c) => c.url === s.url)?.keyHelp || "Paste the service's API key."}
                reload={reload}
                notify={notify}
              />
            )}
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
        <div className="row">
          <input
            placeholder="Search tools…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {catalog
          .filter((c) => !servers.some((s) => s.url === c.url))
          .filter((c) => {
            const needle = q.trim().toLowerCase();
            return (
              !needle ||
              c.name.toLowerCase().includes(needle) ||
              c.blurb.toLowerCase().includes(needle)
            );
          })
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
        {conns.slack === "connected" && (
          <div className="row">
            <input
              placeholder="#weekly-digest"
              title="Weekly digest posts here"
              value={digestCh}
              onChange={(e) => setDigestCh(e.target.value)}
            />
            <button className="sm" onClick={saveDigestCh} disabled={!digestCh.trim()}>
              Save
            </button>
            {savedDigestCh && <span className="dim">saved: {savedDigestCh}</span>}
          </div>
        )}
        {conns.shopify === "connected" && (
          <>
            <div className="row">
              {storePwSaved && !replacingPw ? (
                <>
                  <span className="dim">Store password: Saved</span>
                  <button className="sm" onClick={() => setReplacingPw(true)}>
                    Replace
                  </button>
                  <button className="sm" onClick={clearStorePw}>
                    Remove
                  </button>
                </>
              ) : (
                <>
                  <input
                    type="password"
                    aria-label="Store password (development stores only)"
                    placeholder="Store password (development stores only)"
                    value={storePw}
                    onChange={(e) => setStorePw(e.target.value)}
                  />
                  <button className="sm" onClick={saveStorePw} disabled={!storePw.trim()}>
                    Save
                  </button>
                  {replacingPw && (
                    <button
                      className="sm"
                      onClick={() => {
                        setReplacingPw(false);
                        setStorePw("");
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </>
              )}
            </div>
            <p className="dim">
              The team uses it to check your store like a customer. Find it in Shopify: Online
              Store → Preferences → Password protection.
            </p>
          </>
        )}
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
  members,
  notify,
  reload,
}: {
  org: string;
  teams: TeamRow[];
  members: MemberRow[];
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
          <select
            aria-label={`Who ${t.name} serves`}
            value={t.ownerUserId ?? ""}
            onChange={(e) =>
              api
                .setTeamOwner(org, t.id, e.target.value === "" ? null : e.target.value)
                .then(reload)
                .catch((err) => notify(String(err)))
            }
          >
            <option value="">Founder's bench</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.email ?? "Member"}
              </option>
            ))}
          </select>{" "}
          {t.seats.map((s) => (
            <span key={s.id}>
              <span className={`role role-${s.role}`}>{roleLabel(s.role)}</span>
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
                  {roleLabel(r)}
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
  row,
}: {
  org: string;
  row: GuardrailRow;
  onSaved: () => void;
}) {
  return (
    <div className="conn-row">
      <div>
        <span className={`role role-${row.worker_role}`}>{roleLabel(row.worker_role)}</span>{" "}
        {!row.configured ? (
          <span className="dim">safe defaults</span>
        ) : (
          <span className="dim">
            touches {row.systems.map(providerLabel).join(", ") || "nothing"} ·
            changes {row.write_scope.map(scopeLabel).join(", ") || "nothing"}
          </span>
        )}
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
        What each hire may touch. Defaults
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
  const [members, setMembers] = useState<MemberRow[]>([]);
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
    setMembers((await api.getMembers(org)).members);
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
        <TeamStep org={org} teams={teams} members={members} notify={setNote} reload={loadTeams} />
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
        <h2>Company profile</h2>
        <CompanyProfile org={org} />
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
