import { Hono } from "hono";
import type { Env } from "../../types";
import { isAdmin } from "../shared";
import { measureBenchmark, assertSafeApiUrl } from "../../benchmark/engine";
import { getProviderEndpoint } from "../../providers/registry";
import { providerFor } from "../../providers/index";
import { zenClientHeaders } from "../../providers/opencode-zen";
import {
  validatePlaygroundInput,
  truncatePreview,
} from "../../utils/playground";
import { sanitizeErrorMessage } from "../../utils/security";
import { isProviderCooling } from "../../db/cooldown";

/** Server-side API key resolution by registry provider name.
 *  Keys never come from localStorage and are never echoed back.
 *  A caller-supplied session key (playground only, this request alone)
 *  takes precedence over env keys; it is never persisted or logged.
 *  opencode_zen uses OPENCODE_API_KEY (not OPENCODE_ZEN_API_KEY); agnes uses AGNES_API_KEY. */
function apiKeyFor(provider: string, env: Env): string | undefined {
  const e = env as unknown as Record<string, string | undefined>;
  switch (provider) {
    case "opencode_zen":
      return e.OPENCODE_API_KEY;
    case "openrouter":
      return e.OPENROUTER_API_KEY;
    case "groq":
      return e.GROQ_API_KEY;
    case "cerebras":
      return e.CEREBRAS_API_KEY;
    case "gemini":
      return e.GEMINI_API_KEY;
    case "nvidia":
      return e.NVIDIA_API_KEY;
    case "sambanova":
      return e.SAMBANOVA_API_KEY;
    case "mistral":
      return e.MISTRAL_API_KEY;
    case "agnes_ai":
      return e.AGNES_API_KEY;
    case "aionlabs":
      return e.AIONLABS_API_KEY;
    case "kilocode":
      return e.KILOCODE_API_KEY;
    case "glhf":
      return e.GLHF_API_KEY;
    case "nscale":
      return e.NSCALE_API_KEY;
    case "speka":
      return e.SPEKA_API_KEY;
    case "nexaapi":
      return e.NEXAAPI_API_KEY;
    case "orcarouter":
      return e.ORCAROUTER_API_KEY;
    case "ninerouter":
      return e.NINEROUTER_API_KEY;
    case "tokenrouter":
      return e.TOKENROUTER_API_KEY;
    case "ollama":
      return e.OLLAMA_API_KEY;
    default:
      return undefined;
  }
}

export function playgroundRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();

  r.post("/admin/playground/test", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    // Registry-first: apiUrl/baseUrl/extraHeaders/headers are never accepted.
    // apiKey + chatUrl are the session-only exceptions: optional overrides for
    // this ephemeral request (never stored; URL must pass assertSafeApiUrl).
    if (
      raw.apiUrl !== undefined ||
      raw.baseUrl !== undefined ||
      raw.extraHeaders !== undefined ||
      raw.headers !== undefined
    ) {
      return c.json({ error: "custom urls/keys not allowed (registry-only)" }, 400);
    }
    const v = validatePlaygroundInput(raw);
    if (!v.ok) return c.json({ error: v.error }, 400);

    const adapter = providerFor(v.value.provider, env);
    if (!adapter) return c.json({ error: "unknown provider" }, 400);
    const ep = getProviderEndpoint(v.value.provider);
    if (!ep) return c.json({ error: "unknown provider" }, 400);
    // Registry URL by default; a caller-supplied chatUrl override must pass
    // the same SSRF guard. A blocked custom URL is a 400 (caller error),
    // while a blocked registry URL is a 500 (server misconfiguration).
    const chatUrl = v.value.chatUrl ?? ep.chatUrl;
    const customUrlUsed = v.value.chatUrl != null;
    try {
      assertSafeApiUrl(chatUrl);
    } catch {
      return c.json(
        { error: customUrlUsed ? "custom chat URL blocked" : "provider endpoint blocked" },
        customUrlUsed ? 400 : 500,
      );
    }

    // Display-only freeness: does this target currently qualify for cron queue?
    let free_status: string = "UNKNOWN";
    let would_queue_in_cron = false;
    try {
      const row = await env.DB.prepare(
        `SELECT m.free_status, m.active, COALESCE(m.benchmark_enabled,1) as enabled
         FROM models m JOIN providers p ON p.id=m.provider_id
         WHERE p.name=? AND m.provider_model_id=? LIMIT 1`,
      )
        .bind(v.value.provider, v.value.provider_model_id)
        .first<{ free_status: string; active: number; enabled: number }>();
      if (row) {
        free_status = row.free_status;
        would_queue_in_cron =
          row.free_status === "FREE" && row.active === 1 && row.enabled === 1;
      }
    } catch {
      // DB unavailable pre-migration — leave UNKNOWN, still allow ephemeral run
    }

    // Don't burn shared quota while the provider is cooling from a 429:
    // cron and playground share the same key, so a manual run during
    // cooldown would re-trip a daily reset (e.g. Zen retry-after 62733s).
    try {
      const cd = await isProviderCooling(env.DB, v.value.provider);
      if (cd.cooling) {
        return c.json(
          {
            ok: false,
            error: "provider cooling",
            cooling: true,
            cooldown_until: cd.until ?? null,
            reason: cd.reason ?? null,
          },
          429,
        );
      }
    } catch {
      // Cooldown lookup never blocks an ephemeral run.
    }

    try {
      const result = await measureBenchmark({
        provider: v.value.provider,
        providerModelId: v.value.provider_model_id,
        apiUrl: chatUrl,
        apiKey: v.value.apiKey ?? apiKeyFor(v.value.provider, env),
        benchmark: v.value.benchmark,
        extraHeaders:
          v.value.provider === "opencode_zen" ? zenClientHeaders() : undefined,
        includePreview: true,
        includeDebug: true,
      });
      const full = result.preview ?? "";
      const preview = truncatePreview(full);
      return c.json({
        ok: true,
        provider: v.value.provider,
        model: v.value.provider_model_id,
        resolvedChatUrl: chatUrl,
        custom_url_used: customUrlUsed,
        free_status,
        would_queue_in_cron,
        result: { ...result, preview: undefined, debug: undefined },
        preview,
        preview_truncated: full.length > preview.length,
        debug: result.debug ?? null,
      });
    } catch (e) {
      return c.json({ error: sanitizeErrorMessage(e) }, 500);
    }
  });

  return r;
}
