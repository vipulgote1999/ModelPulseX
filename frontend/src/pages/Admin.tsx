import { useEffect, useState, useMemo } from "react";

type AdminModel = {
  id: number;
  provider_id: number;
  provider_model_id: string;
  display_name: string;
  name: string;
  free_status: string;
  active: number;
  is_free: number;
  benchmark_enabled?: number | null;
  provider_name: string;
  last_seen: string;
  first_seen: string;
  context_length: number | null;
};

const STORAGE_KEY = "modelpulsex_admin_token";

function authHeader(): Record<string, string> {
  const t = localStorage.getItem(STORAGE_KEY);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export default function Admin() {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem(STORAGE_KEY),
  );
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);

  const [models, setModels] = useState<AdminModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [provider, setProvider] = useState("");
  const [enabledFilter, setEnabledFilter] = useState<
    "all" | "enabled" | "disabled"
  >("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const fetchModels = async (tok = token) => {
    if (!tok) return;
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (provider) params.set("provider", provider);
      if (q) params.set("q", q);
      if (enabledFilter === "enabled") params.set("enabled", "1");
      if (enabledFilter === "disabled") params.set("enabled", "0");
      const headers: Record<string, string> = { ...authHeader() };
      const res = await fetch(`/api/admin/models?${params.toString()}`, {
        headers,
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const j = (await res.json()) as { models: AdminModel[] };
      setModels(j.models);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) fetchModels(token);
  }, [token]);

  // auto-refetch on filter change when authed
  useEffect(() => {
    if (token) {
      const t = setTimeout(() => fetchModels(), 350);
      return () => clearTimeout(t);
    }
  }, [q, provider, enabledFilter]);

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginErr(null);
    setLoginLoading(true);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: user, password: pass }),
      });
      const j = (await res.json()) as {
        ok?: boolean;
        token?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(j.error ?? `${res.status}`);
      const tok = j.token ?? "";
      localStorage.setItem(STORAGE_KEY, tok);
      setToken(tok);
      setToast("Logged in");
      setTimeout(() => setToast(null), 2500);
    } catch (e2) {
      setLoginErr(String(e2));
    } finally {
      setLoginLoading(false);
    }
  };

  const logout = () => {
    localStorage.removeItem(STORAGE_KEY);
    setToken(null);
    setModels([]);
    setSelected(new Set());
  };

  const toggleOne = async (id: number, current: number | null | undefined) => {
    const next = current ? 0 : 1;
    try {
      const res = await fetch(`/api/admin/models/${id}/toggle`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeader(),
        } as Record<string, string>,
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error(await res.text());
      setModels((prev) =>
        prev.map((m) => (m.id === id ? { ...m, benchmark_enabled: next } : m)),
      );
      setToast(`${next ? "Enabled" : "Disabled"} #${id}`);
      setTimeout(() => setToast(null), 1800);
    } catch (e) {
      setToast(String(e));
      setTimeout(() => setToast(null), 2500);
    }
  };

  const bulk = async (enabled: number) => {
    if (selected.size === 0) {
      setToast("Select at least one model");
      setTimeout(() => setToast(null), 2000);
      return;
    }
    setBulkBusy(true);
    try {
      const res = await fetch("/api/admin/models/bulk", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeader(),
        } as Record<string, string>,
        body: JSON.stringify({ ids: Array.from(selected), enabled }),
      });
      if (!res.ok) throw new Error(await res.text());
      setModels((prev) =>
        prev.map((m) =>
          selected.has(m.id) ? { ...m, benchmark_enabled: enabled } : m,
        ),
      );
      setSelected(new Set());
      setToast(`${enabled ? "Enabled" : "Disabled"} ${selected.size} models`);
      setTimeout(() => setToast(null), 2200);
    } catch (e) {
      setToast(String(e));
      setTimeout(() => setToast(null), 2500);
    } finally {
      setBulkBusy(false);
    }
  };

  const toggleProvider = async (prov: string, enabled: number) => {
    setBulkBusy(true);
    try {
      const res = await fetch("/api/admin/models/bulk", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeader(),
        } as Record<string, string>,
        body: JSON.stringify({ provider: prov, enabled }),
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchModels();
      setToast(`${enabled ? "Enabled" : "Disabled"} provider ${prov}`);
      setTimeout(() => setToast(null), 2200);
    } catch (e) {
      setToast(String(e));
      setTimeout(() => setToast(null), 2500);
    } finally {
      setBulkBusy(false);
    }
  };

  const providers = useMemo(() => {
    const s = new Set(models.map((m) => m.provider_name));
    return Array.from(s).sort();
  }, [models]);

  const filtered = useMemo(() => {
    let r = models;
    if (enabledFilter !== "all") {
      const want = enabledFilter === "enabled" ? 1 : 0;
      r = r.filter((m) => (m.benchmark_enabled ?? 1) === want);
    }
    return r;
  }, [models, enabledFilter]);

  const stats = useMemo(() => {
    const total = models.length;
    const enabled = models.filter(
      (m) => (m.benchmark_enabled ?? 1) === 1,
    ).length;
    const disabled = total - enabled;
    const free = models.filter((m) => m.free_status === "FREE").length;
    return { total, enabled, disabled, free };
  }, [models]);

  if (!token) {
    return (
      <div className="max-w-[520px] mx-auto px-4 py-10">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-xl backdrop-blur">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 grid place-items-center font-bold text-white">
              ◆
            </div>
            <div>
              <div className="font-semibold leading-none">
                Admin — ModelPulseX
              </div>
              <div className="text-xs text-zinc-500">
                Login with ADMIN_ID / ADMIN_PASSWORD (wrangler secret). Token is
                ADMIN_TOKEN.
              </div>
            </div>
          </div>
          <form onSubmit={login} className="space-y-4">
            <div>
              <label className="text-xs font-medium text-zinc-400 tracking-widest uppercase">
                Admin ID
              </label>
              <input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder="admin"
                className="mt-1 w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-violet-600"
                autoComplete="username"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-zinc-400 tracking-widest uppercase">
                Password
              </label>
              <input
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                placeholder="••••••••"
                type="password"
                className="mt-1 w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-violet-600"
                autoComplete="current-password"
              />
            </div>
            {loginErr && (
              <div className="rounded-md bg-amber-950/40 border border-amber-800 px-3 py-2 text-sm text-amber-200">
                {loginErr}
              </div>
            )}
            <button
              type="submit"
              disabled={loginLoading}
              className="w-full rounded-md bg-white text-zinc-900 font-semibold py-2.5 text-sm hover:bg-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loginLoading ? "Signing in…" : "Sign in"}
            </button>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              Set via{" "}
              <code className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-300">
                wrangler secret put ADMIN_ID
              </code>{" "}
              <code className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-300">
                ADMIN_PASSWORD
              </code>{" "}
              <code className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-300">
                ADMIN_TOKEN
              </code>
              . For local dev, defaults to id <b>admin</b> and password =
              ADMIN_TOKEN.
            </p>
          </form>
        </div>
        <div className="mt-4 text-center text-xs text-zinc-500">
          <a href="/" className="underline hover:text-zinc-300">
            ← Back to dashboard
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[1480px] mx-auto px-4 sm:px-6 py-6 space-y-4">
      {/* top bar */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 flex flex-wrap gap-3 items-center">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 grid place-items-center font-bold text-white">
            ◆
          </div>
          <div>
            <div className="font-semibold tracking-tight">
              Admin — Benchmark Control
            </div>
            <div className="text-xs text-zinc-500">
              Keep ALL models stored. Toggle{" "}
              <span className="text-emerald-400">benchmark_enabled</span> per
              provider/model. Disabled models skip the */5 cron queue but stay
              visible for future re-enable.
            </div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <a
            href="/"
            className="rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Dashboard
          </a>
          <button
            onClick={logout}
            className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700"
          >
            Logout
          </button>
        </div>
      </div>

      {/* stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
          <div className="text-[11px] tracking-widest uppercase text-zinc-500 font-medium">
            Total models
          </div>
          <div className="text-2xl font-semibold mt-1">{stats.total}</div>
          <div className="text-xs text-zinc-500">
            stored (active + previously_free)
          </div>
        </div>
        <div className="rounded-xl border border-emerald-900/50 bg-emerald-950/20 p-4">
          <div className="text-[11px] tracking-widest uppercase text-emerald-400 font-medium">
            Enabled
          </div>
          <div className="text-2xl font-semibold mt-1 text-emerald-300">
            {stats.enabled}
          </div>
          <div className="text-xs text-zinc-500">will be benchmarked</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
          <div className="text-[11px] tracking-widest uppercase text-zinc-500 font-medium">
            Disabled
          </div>
          <div className="text-2xl font-semibold mt-1">{stats.disabled}</div>
          <div className="text-xs text-zinc-500">kept but not benchmarked</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
          <div className="text-[11px] tracking-widest uppercase text-zinc-500 font-medium">
            Free status FREE
          </div>
          <div className="text-2xl font-semibold mt-1">{stats.free}</div>
          <div className="text-xs text-zinc-500">
            verified FREE (pricing/suffix)
          </div>
        </div>
      </div>

      {/* filters */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-3 flex flex-wrap gap-2 items-center">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search model id or display name…"
          className="min-w-[220px] flex-1 max-w-[420px] rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-violet-600"
        />
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100"
        >
          <option value="">All providers</option>
          {Array.from(new Set(models.map((m) => m.provider_name)))
            .sort()
            .map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
        </select>
        <select
          value={enabledFilter}
          onChange={(e) => setEnabledFilter(e.target.value as never)}
          className="rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100"
        >
          <option value="all">All (enabled + disabled)</option>
          <option value="enabled">Enabled only</option>
          <option value="disabled">Disabled only</option>
        </select>
        <button
          onClick={() => fetchModels()}
          className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm hover:bg-zinc-800"
        >
          Refresh
        </button>
        <span className="ml-auto text-xs text-zinc-500">
          {loading ? "Loading…" : `${filtered.length} shown`}
        </span>
      </div>

      {/* bulk */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-3 flex flex-wrap gap-2 items-center text-sm">
        <span className="text-zinc-400">{selected.size} selected</span>
        <button
          disabled={bulkBusy || selected.size === 0}
          onClick={() => bulk(1)}
          className="rounded-md bg-emerald-600 px-3 py-1.5 font-medium text-white disabled:opacity-40 hover:bg-emerald-500"
        >
          Enable selected
        </button>
        <button
          disabled={bulkBusy || selected.size === 0}
          onClick={() => bulk(0)}
          className="rounded-md bg-zinc-800 px-3 py-1.5 font-medium text-zinc-100 disabled:opacity-40 hover:bg-zinc-700"
        >
          Disable selected
        </button>
        <button
          onClick={() => setSelected(new Set(filtered.map((m) => m.id)))}
          className="rounded-md border border-zinc-700 px-3 py-1.5 hover:bg-zinc-800"
        >
          Select all shown
        </button>
        <button
          onClick={() => setSelected(new Set())}
          className="rounded-md border border-zinc-800 px-3 py-1.5 hover:bg-zinc-800"
        >
          Clear
        </button>
        <span className="mx-2 h-4 w-px bg-zinc-800 hidden sm:inline-block" />
        <span className="text-xs text-zinc-500">Per-provider:</span>
        {providers.slice(0, 8).map((p) => (
          <span key={p} className="inline-flex gap-1">
            <button
              disabled={bulkBusy}
              onClick={() => toggleProvider(p, 1)}
              className="rounded px-2 py-1 text-xs bg-zinc-900 border border-zinc-800 hover:bg-zinc-800"
            >
              Enable {p}
            </button>
            <button
              disabled={bulkBusy}
              onClick={() => toggleProvider(p, 0)}
              className="rounded px-2 py-1 text-xs bg-zinc-900 border border-zinc-800 hover:bg-zinc-800"
            >
              Disable {p}
            </button>
          </span>
        ))}
      </div>

      {err && (
        <div className="rounded-lg border border-amber-800 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          {err}
        </div>
      )}

      {/* table */}
      <div className="rounded-xl border border-zinc-800 overflow-hidden bg-zinc-900/20">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-950/60 border-b border-zinc-800 text-[11px] tracking-widest uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2.5 text-left">
                  <input
                    type="checkbox"
                    checked={
                      selected.size === filtered.length && filtered.length > 0
                    }
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? new Set(filtered.map((m) => m.id))
                          : new Set(),
                      )
                    }
                  />
                </th>
                <th className="px-3 py-2.5 text-left">Provider</th>
                <th className="px-3 py-2.5 text-left">Model</th>
                <th className="px-3 py-2.5 text-left">Display name</th>
                <th className="px-3 py-2.5 text-left">Free</th>
                <th className="px-3 py-2.5 text-left">Active</th>
                <th className="px-3 py-2.5 text-left">Benchmark</th>
                <th className="px-3 py-2.5 text-left">Last seen</th>
                <th className="px-3 py-2.5 text-right">Toggle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {filtered.map((m) => {
                const enabled = (m.benchmark_enabled ?? 1) === 1;
                const isFree = m.free_status === "FREE";
                return (
                  <tr
                    key={m.id}
                    className={`hover:bg-zinc-900/40 ${!enabled ? "opacity-60" : ""}`}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(m.id)}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const n = new Set(prev);
                            if (e.target.checked) n.add(m.id);
                            else n.delete(m.id);
                            return n;
                          })
                        }
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-zinc-300">
                      {m.provider_name}
                    </td>
                    <td
                      className="px-3 py-2 font-mono text-xs text-zinc-400 max-w-[28ch] truncate"
                      title={m.provider_model_id}
                    >
                      {m.provider_model_id}
                    </td>
                    <td
                      className="px-3 py-2 text-zinc-200 max-w-[24ch] truncate"
                      title={m.display_name}
                    >
                      {m.display_name}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded px-2 py-0.5 text-[11px] font-medium border ${isFree ? "bg-emerald-950/30 border-emerald-800 text-emerald-300" : m.free_status === "PAID" ? "bg-zinc-800 border-zinc-700 text-zinc-400" : "bg-amber-950/20 border-amber-800 text-amber-300"}`}
                      >
                        {m.free_status}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded px-2 py-0.5 text-[11px] ${m.active ? "bg-zinc-800 text-zinc-300" : "bg-zinc-900 text-zinc-500"}`}
                      >
                        {m.active ? "active" : "inactive"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium border ${enabled ? "bg-emerald-600 text-white border-emerald-600" : "bg-zinc-800 text-zinc-400 border-zinc-700"}`}
                      >
                        {enabled ? "● enabled" : "○ disabled"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-500">
                      {m.last_seen
                        ? new Date(m.last_seen).toLocaleString()
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() =>
                          toggleOne(m.id, m.benchmark_enabled ?? 1)
                        }
                        className={`inline-flex rounded-md px-3 py-1.5 text-xs font-medium border ${enabled ? "bg-zinc-800 border-zinc-700 text-zinc-200 hover:bg-zinc-700" : "bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-500"}`}
                      >
                        {enabled ? "Disable" : "Enable"}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-10 text-center text-sm text-zinc-500"
                  >
                    {loading ? "Loading models…" : "No models match filters."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-3 text-xs text-zinc-500 leading-relaxed">
        <b className="text-zinc-300">Strategy:</b> Discovery keeps{" "}
        <b className="text-zinc-200">all</b> models (free + paid) — disabled
        ones are <b>not deleted</b>. Only{" "}
        <b className="text-emerald-400">enabled + active + FREE</b> are queued
        by the */5 cron. If a disabled provider goes free again, enable it here
        and next discovery will start benchmarking.{" "}
        <span className="text-zinc-400">
          Speka / NexaAPI / NineRouter default disabled ( $1 credit, not $0) —
          Groq whisper audio disabled — Groq paid variants disabled — others
          enabled.
        </span>
      </div>

      {toast && (
        <div className="fixed bottom-4 right-4 rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-2.5 text-sm text-zinc-100 shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
