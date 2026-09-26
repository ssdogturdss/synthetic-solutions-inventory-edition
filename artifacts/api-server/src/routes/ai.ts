import { Router, type IRouter } from "express";
import {
  db, aiConfigTable, inventorySessionsTable, inventorySessionItemsTable,
  productsTable, storesTable, receivingRecordsTable,
} from "@workspace/db";
import { eq, desc, and, inArray, gte, isNull, lt } from "drizzle-orm";
import { requireAuth, requireAdmin, getUser, canAccessStore, resolveStoreScope } from "../lib/auth";
import { encrypt, decrypt } from "../lib/crypto";
import { logAudit } from "../lib/audit";
import {
  calculateReorderForecast,
  type ReorderForecast,
  type ReorderForecastEvidence,
} from "../lib/reorder-forecast";

const router: IRouter = Router();

// ── Shared system prompt for chat and admin configuration ────────────────────
const CHAT_SYSTEM_PROMPT = `You are the AI assistant for Red Carpet Car Wash — a multi-location car wash chain. You specialize in chemical inventory management.

You have access to the chain's live inventory database, including:
- Current stock levels at each store (full/partial containers, estimated gallons)
- Usage trends and historical consumption data
- Stock alerts (items below minimum reorder levels)
- Recent receiving and delivery records
- Product catalog with min/max targets, vendor info, and costs

Tone and style:
- Concise and direct — store managers and executives are busy
- Data-driven — always cite specific numbers, product names, and store names when available
- Proactive — flag issues the user didn't ask about if they're urgent (e.g. critical stock alerts)
- Actionable — every observation should include a clear next step or recommendation
- Use **bold** for key numbers, product names, and alerts; use bullet lists for multiple items
- Keep replies under 300 words unless the user explicitly requests a detailed breakdown

Accuracy rules:
- NEVER fabricate, estimate, or invent numbers not in the data
- If data is unavailable, say so clearly and suggest what action would get the data
- If a question is outside the inventory domain, briefly answer and offer to return to inventory topics`;

function resolvedSystemPrompt(systemPrompt: string | null | undefined): string {
  return systemPrompt?.trim() ? systemPrompt : CHAT_SYSTEM_PROMPT;
}

router.get("/ai/config", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const [config] = await db.select().from(aiConfigTable).limit(1);

  if (!config) {
    res.json({
      id: 0,
      provider: "openai",
      systemPrompt: CHAT_SYSTEM_PROMPT,
      hasApiKey: false,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  res.json({
    id: config.id,
    provider: config.provider,
    systemPrompt: resolvedSystemPrompt(config.systemPrompt),
    hasApiKey: !!config.apiKeyEncrypted,
    updatedAt: config.updatedAt,
  });
});

router.put("/ai/config", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { provider, systemPrompt, apiKey } = req.body as {
    provider?: string;
    systemPrompt?: string;
    apiKey?: string;
  };

  const [existing] = await db.select().from(aiConfigTable).limit(1);

  const updates: Record<string, unknown> = {};
  if (provider != null) updates.provider = provider;
  if (systemPrompt != null) updates.systemPrompt = systemPrompt;
  if (apiKey) updates.apiKeyEncrypted = encrypt(apiKey);

  let config;
  if (existing) {
    [config] = await db
      .update(aiConfigTable)
      .set(updates as any)
      .where(eq(aiConfigTable.id, existing.id))
      .returning();
  } else {
    [config] = await db
      .insert(aiConfigTable)
      .values({
        provider: (provider as "openai" | "grok") ?? "openai",
        systemPrompt: systemPrompt ?? "",
        apiKeyEncrypted: apiKey ? encrypt(apiKey) : undefined,
      })
      .returning();
  }

  await logAudit(req, "UPDATE_AI_CONFIG", "ai_config", config.id, null, { provider: config.provider });

  res.json({
    id: config.id,
    provider: config.provider,
    systemPrompt: resolvedSystemPrompt(config.systemPrompt),
    hasApiKey: !!config.apiKeyEncrypted,
    updatedAt: config.updatedAt,
  });
});

router.post("/ai/test", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { provider, apiKey } = req.body as { provider?: string; apiKey?: string };

  // Resolve key: use provided key, or fall back to stored key
  let keyToTest: string | null = null;

  if (apiKey && apiKey.trim()) {
    keyToTest = apiKey.trim();
  } else {
    const [config] = await db.select().from(aiConfigTable).limit(1);
    if (config?.apiKeyEncrypted) {
      try {
        keyToTest = decrypt(config.apiKeyEncrypted);
      } catch {
        res.status(503).json({ ok: false, error: "Failed to decrypt stored API key" });
        return;
      }
    }
  }

  if (!keyToTest) {
    res.status(400).json({ ok: false, error: "No API key provided and none is stored" });
    return;
  }

  const resolvedProvider = provider ?? "openai";
  let endpoint: string;
  let model: string;
  let providerLabel: string;

  if (resolvedProvider === "grok") {
    endpoint = "https://api.x.ai/v1/chat/completions";
    model = "grok-3";
    providerLabel = "Grok (xAI)";
  } else {
    endpoint = "https://api.openai.com/v1/chat/completions";
    model = "gpt-4o-mini";
    providerLabel = "OpenAI";
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${keyToTest}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      res.json({ ok: true, provider: providerLabel });
      return;
    }

    const text = await response.text();
    let friendlyError = "Invalid API key or provider error";
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed?.error?.message) friendlyError = parsed.error.message;
    } catch {
      // use raw text if JSON parse fails
      if (text) friendlyError = text.slice(0, 200);
    }

    // Map common HTTP statuses to readable messages
    if (response.status === 401) {
      friendlyError = "Invalid API key — authentication failed";
    } else if (response.status === 403) {
      friendlyError = "API key does not have permission to use this model";
    } else if (response.status === 429) {
      friendlyError = "Rate limit or quota exceeded on this key";
    }

    res.json({ ok: false, error: friendlyError });
  } catch (err: unknown) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    res.json({ ok: false, error: isTimeout ? "Provider unreachable — request timed out" : "Provider unreachable — network error" });
  }
});

// ── Shared helper: resolve API key and provider ───────────────────────────────
async function resolveApiKey(config: {
  provider: string;
  apiKeyEncrypted: string | null;
} | undefined): Promise<{ apiKey: string; provider: string } | { error: string; status: number }> {
  if (config?.apiKeyEncrypted) {
    try {
      return { apiKey: decrypt(config.apiKeyEncrypted), provider: config.provider };
    } catch {
      const envKey = process.env.XAI_API_KEY;
      if (envKey) return { apiKey: envKey, provider: "grok" };
      return { error: "AI API key is corrupted. Please re-enter it in admin settings.", status: 503 };
    }
  }
  const envKey = process.env.XAI_API_KEY;
  if (envKey) return { apiKey: envKey, provider: "grok" };
  return { error: "AI not configured. Please set an API key in admin settings.", status: 503 };
}

function providerEndpoint(provider: string): { endpoint: string; model: string } {
  if (provider === "grok") return { endpoint: "https://api.x.ai/v1/chat/completions", model: "grok-3" };
  return { endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" };
}

function parseInventoryQuantity(estimatedGallons: unknown, fullContainers: unknown): number | null {
  for (const candidate of [estimatedGallons, fullContainers]) {
    if (candidate === null || candidate === undefined || String(candidate).trim() === "") continue;
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

type ReportUsageLine = {
  productId?: number;
  usage?: string | number | null;
  received?: string | number | null;
};

function parseUsageSnapshot(value: unknown): ReportUsageLine[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((line): line is ReportUsageLine => Boolean(line && typeof line === "object"));
}

type ReportQuality = "complete" | "partial" | "insufficient";
const REPORT_QUALITY_RANK: Record<ReportQuality, number> = {
  insufficient: 0,
  partial: 1,
  complete: 2,
};

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function normalizeReport(
  raw: Record<string, unknown>,
  minimumQuality: ReportQuality,
  qualityNote: string,
  reorderForecasts: ReorderForecast[],
): Record<string, unknown> {
  const parsedQuality: ReportQuality =
    raw.dataQuality === "complete" || raw.dataQuality === "partial" || raw.dataQuality === "insufficient"
      ? raw.dataQuality
      : "partial";
  const dataQuality =
    REPORT_QUALITY_RANK[parsedQuality] <= REPORT_QUALITY_RANK[minimumQuality]
      ? parsedQuality
      : minimumQuality;
  const modelNote = typeof raw.dataQualityNote === "string" ? raw.dataQualityNote.trim() : "";
  const rawConfidence = Number(raw.confidence);

  return {
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Inventory report",
    overview: typeof raw.overview === "string" ? raw.overview : "",
    keyFindings: stringList(raw.keyFindings),
    anomalies: stringList(raw.anomalies),
    recommendations: stringList(raw.recommendations),
    risks: stringList(raw.risks),
    confidence: Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0,
    dataQuality,
    dataQualityNote: dataQuality === "complete"
      ? null
      : [qualityNote, modelNote].filter(Boolean).join(" ") || "The available inventory data is incomplete.",
    reorderForecasts,
  };
}

// ── Build rich inventory context for chat ─────────────────────────────────────
async function buildChatContext(effectiveStoreId: number | null): Promise<string> {
  const since14d = new Date(Date.now() - 14 * 86_400_000);

  // Parallel: all products + recent sessions for the scope
  const [allProducts, recentSessions] = await Promise.all([
    db.select({
      id: productsTable.id, name: productsTable.name, unit: productsTable.unit,
      minLevel: productsTable.minLevel, maxLevel: productsTable.maxLevel,
      vendor: productsTable.vendor, cost: productsTable.cost,
    })
      .from(productsTable)
      .where(and(eq(productsTable.isActive, true), isNull(productsTable.deletedAt))),

    db.select({
      id: inventorySessionsTable.id, storeId: inventorySessionsTable.storeId,
      finalizedAt: inventorySessionsTable.finalizedAt, notes: inventorySessionsTable.notes,
    })
      .from(inventorySessionsTable)
      .where(and(
        eq(inventorySessionsTable.status, "finalized"),
        gte(inventorySessionsTable.finalizedAt, since14d),
        ...(effectiveStoreId ? [eq(inventorySessionsTable.storeId, effectiveStoreId)] : []),
      ))
      .orderBy(desc(inventorySessionsTable.finalizedAt))
      .limit(effectiveStoreId ? 5 : 30),
  ]);

  // Fetch all stores so we can show store names
  const stores = await db.select({ id: storesTable.id, name: storesTable.name, storeNumber: storesTable.storeNumber })
    .from(storesTable).where(isNull(storesTable.deletedAt));
  const storeMap = Object.fromEntries(stores.map((s) => [s.id, s]));
  const productMap = Object.fromEntries(allProducts.map((p) => [p.id, p]));

  // Fetch items for those sessions
  const sessionIds = recentSessions.map((s) => s.id);
  const sessionItems = sessionIds.length > 0
    ? await db.select({
        sessionId: inventorySessionItemsTable.sessionId,
        productId: inventorySessionItemsTable.productId,
        fullContainers: inventorySessionItemsTable.fullContainers,
        partialContainers: inventorySessionItemsTable.partialContainers,
        estimatedGallons: inventorySessionItemsTable.estimatedGallons,
      }).from(inventorySessionItemsTable).where(inArray(inventorySessionItemsTable.sessionId, sessionIds))
    : [];

  // A scoped prompt should only carry catalog metadata for products that are
  // present in that store's recent sessions.  Products and stores are shared
  // tables, so leaving the full catalog/list in the context could expose
  // another store's product names even when its inventory sessions are
  // correctly excluded above.
  const contextProducts = effectiveStoreId
    ? allProducts.filter((product) => sessionItems.some((item) => item.productId === product.id))
    : allProducts;
  const contextStores = effectiveStoreId
    ? stores.filter((store) => store.id === effectiveStoreId)
    : stores;

  // Latest session per store → current stock snapshot + alerts
  const latestByStore: Record<number, number> = {};
  for (const s of recentSessions) {
    if (!latestByStore[s.storeId]) latestByStore[s.storeId] = s.id;
  }
  const latestItems = sessionItems.filter((i) => Object.values(latestByStore).includes(i.sessionId));

  // Current stock per product (summed across latest sessions)
  const stockNow: Record<number, number> = {};
  for (const item of latestItems) {
    const gallons = item.estimatedGallons ? parseFloat(String(item.estimatedGallons)) : 0;
    stockNow[item.productId] = (stockNow[item.productId] ?? 0) + gallons;
  }

  // Usage trend (oldest→newest, gallons consumed = start - end per product)
  const usageByProduct: Record<number, number[]> = {};
  for (const session of [...recentSessions].reverse()) {
    const items = sessionItems.filter((i) => i.sessionId === session.id);
    for (const item of items) {
      if (!usageByProduct[item.productId]) usageByProduct[item.productId] = [];
      usageByProduct[item.productId]!.push(
        item.estimatedGallons ? parseFloat(String(item.estimatedGallons)) : 0,
      );
    }
  }

  // Stock alerts (below minimum)
  const alerts: string[] = [];
  for (const p of contextProducts) {
    if (!p.minLevel) continue;
    const level = stockNow[p.id] ?? null;
    if (level !== null && level < parseFloat(String(p.minLevel))) {
      alerts.push(`⚠ ${p.name}: ${level.toFixed(1)} ${p.unit ?? "gal"} (min: ${p.minLevel})`);
    }
  }

  // Session summary lines
  const sessionLines = recentSessions.slice(0, 10).map((s) => {
    const storeName = storeMap[s.storeId]?.name ?? `Store ${s.storeId}`;
    const date = s.finalizedAt?.toISOString().split("T")[0] ?? "?";
    const items = sessionItems.filter((i) => i.sessionId === s.id);
    const highlights = items
      .slice(0, 4)
      .map((i) => {
        const p = productMap[i.productId];
        return `${p?.name ?? "?"}: ${i.estimatedGallons ?? "?"}${p?.unit ?? "gal"}`;
      })
      .join(", ");
    return `  [${date}] ${storeName}: ${highlights}${items.length > 4 ? ` (+${items.length - 4} more)` : ""}`;
  });

  // Current stock summary
  const stockLines = contextProducts
    .filter((p) => stockNow[p.id] !== undefined)
    .sort((a, b) => (stockNow[b.id] ?? 0) - (stockNow[a.id] ?? 0))
    .map((p) => {
      const lvl = (stockNow[p.id] ?? 0).toFixed(1);
      const min = p.minLevel ? parseFloat(String(p.minLevel)) : null;
      const max = p.maxLevel ? parseFloat(String(p.maxLevel)) : null;
      const status = min && parseFloat(lvl) < min ? " [BELOW MIN]" : max && parseFloat(lvl) > max ? " [OVERSTOCKED]" : "";
      return `  ${p.name}: ${lvl} ${p.unit ?? "gal"} | min:${min ?? "–"} max:${max ?? "–"}${status}`;
    });

  const parts: string[] = [];
  parts.push(`== LIVE INVENTORY SNAPSHOT (last 14 days) ==`);
  parts.push(`Today: ${new Date().toISOString().split("T")[0]}`);
  parts.push(`Scope: ${effectiveStoreId ? contextStores[0]?.name : "all stores"}`);
  parts.push(`Products in catalog: ${contextProducts.length} | Stores: ${contextStores.length}`);

  if (stockLines.length > 0) {
    parts.push(`\nCURRENT STOCK LEVELS:`);
    parts.push(stockLines.join("\n"));
  }

  if (alerts.length > 0) {
    parts.push(`\nSTOCK ALERTS (${alerts.length} below minimum):`);
    parts.push(alerts.join("\n"));
  } else if (stockLines.length > 0) {
    parts.push(`\nSTOCK ALERTS: None — no items with current stock snapshots are below minimum levels.`);
  } else {
    parts.push(`\nSTOCK ALERTS: Unavailable — no current stock snapshot exists for this scope in the last 14 days. Do not infer stock levels or alert status.`);
  }

  if (sessionLines.length > 0) {
    parts.push(`\nRECENT SESSIONS (${recentSessions.length} in 14 days):`);
    parts.push(sessionLines.join("\n"));
  } else {
    parts.push(`\nRECENT SESSIONS: None found in the last 14 days.`);
  }

  return parts.join("\n");
}

router.post("/ai/chat", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { messages, storeId } = req.body as {
    messages?: Array<{ role: string; content: string }>;
    storeId?: number;
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages array is required" });
    return;
  }

  const [config] = await db.select().from(aiConfigTable).limit(1);
  const resolved = await resolveApiKey(config);
  if ("error" in resolved) { res.status(resolved.status).json({ error: resolved.error }); return; }
  const { apiKey, provider } = resolved;

  const user = getUser(req);
  const { storeId: scopedId, denied } = resolveStoreScope(user, res);
  if (denied) return;
  const effectiveStoreId = user.role === "store_user" ? scopedId : storeId ?? null;

  if (storeId && !canAccessStore(user, storeId)) {
    res.status(403).json({ error: "Access denied to this store's inventory data" });
    return;
  }

  const [inventoryContext] = await Promise.all([buildChatContext(effectiveStoreId)]);

  // Use custom system prompt if configured, otherwise fall back to the built-in one
  const basePrompt = (config?.systemPrompt && config.systemPrompt.trim().length > 20)
    ? config.systemPrompt
    : CHAT_SYSTEM_PROMPT;
  const systemContent = `${basePrompt}\n\n${inventoryContext}`;

  const { endpoint, model } = providerEndpoint(provider);
  // Test-only endpoint override lets E2E verify the generated context without
  // spending provider credits. NODE_ENV gates this header out of production.
  const testEndpoint = process.env.NODE_ENV === "test" && req.headers["x-test-ai-url"]
    ? String(req.headers["x-test-ai-url"])
    : endpoint;

  const response = await fetch(testEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: systemContent }, ...messages],
      max_tokens: 4096,
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok) {
    const err = await response.text();
    res.status(502).json({ error: `AI provider error: ${err}` });
    return;
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  res.json({
    message: data.choices[0]?.message?.content ?? "",
    usage: data.usage ? {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    } : undefined,
  });
});

// ── POST /api/ai/chat/stream — SSE streaming chat ─────────────────────────────
router.post("/ai/chat/stream", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { messages, storeId } = req.body as {
    messages?: Array<{ role: string; content: string }>;
    storeId?: number;
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages array is required" });
    return;
  }

  // Track disconnects immediately, before any awaited config/context work.
  // The full abort handler is installed below once its controller exists.
  let clientGoneBeforeSetup = false;
  const onEarlyClientGone = () => { clientGoneBeforeSetup = true; };
  const removeEarlyCloseListener = () => { req.off("aborted", onEarlyClientGone); };
  req.on("aborted", onEarlyClientGone);
  res.once("finish", removeEarlyCloseListener);

  // Test-only synchronization point: confirms the route accepted the request
  // before the e2e client disconnects. It runs before config/context/upstream
  // work so the test can deterministically exercise the connection-phase close.
  if (process.env.NODE_ENV === "test" && req.headers["x-test-ai-observe-url"]) {
    try {
      await fetch(String(req.headers["x-test-ai-observe-url"]), {
        method: "POST",
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      // Observability must never affect route behavior.
    }
  }
  if (clientGoneBeforeSetup || req.socket?.destroyed) {
    removeEarlyCloseListener();
    return;
  }

  // ── 1. Fast auth/config checks (< ~10 ms) — return proper HTTP errors ──────
  // These are done before flushHeaders() so the client can still receive
  // non-200 HTTP status codes.
  const [config] = await db.select().from(aiConfigTable).limit(1);
  if (clientGoneBeforeSetup || req.socket?.destroyed) {
    removeEarlyCloseListener();
    return;
  }
  const resolved = await resolveApiKey(config);
  if ("error" in resolved) { res.status(resolved.status).json({ error: resolved.error }); return; }
  const { apiKey, provider } = resolved;

  const user = getUser(req);
  const { storeId: scopedId, denied } = resolveStoreScope(user, res);
  if (denied) return;
  const effectiveStoreId = user.role === "store_user" ? scopedId : storeId ?? null;

  if (storeId && !canAccessStore(user, storeId)) {
    res.status(403).json({ error: "Access denied to this store's inventory data" });
    return;
  }

  // ── 2. Commit SSE response headers ──────────────────────────────────────────
  // Headers are flushed after auth but before the slow buildChatContext so the
  // client receives its 200 + SSE handshake promptly.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable Nginx buffering if present
  res.flushHeaders();

  const sendEvent = (data: string) => { res.write(`data: ${data}\n\n`); };

  // ── 3. Register disconnect handler BEFORE buildChatContext ──────────────────
  // `buildChatContext` executes several DB queries and can take 50-300 ms.
  // Installing the handler here ensures any client drop during that window
  // immediately aborts the controller, preventing a wasted upstream AI call.
  // We also listen on the socket directly because in Node.js 24 the TCP socket
  // can be torn down before `req`'s "close" event fires.
  const controller = new AbortController();
  let clientGone = clientGoneBeforeSetup;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const onClientGone = () => {
    if (clientGone) return; // idempotent — may be called from both listeners
    clientGone = true;
    // In Node.js 24, abort() can throw synchronously through undici's
    // abort-listener propagation chain.
    try { controller.abort(); } catch { /* swallow */ }
    activeReader?.cancel().catch(() => { /* ignore cancel errors */ });
  };
  req.on("close", onClientGone);
  req.socket?.on("close", onClientGone);
  removeEarlyCloseListener();

  // Outer finally: always remove disconnect listeners regardless of exit path
  // (error, abort, normal completion) so they don't outlive this request on
  // HTTP keep-alive sockets.
  try {
    // ── 4. Slow context build — guarded by the listener registered above ─────
    const inventoryContext = await buildChatContext(effectiveStoreId);

    // Short-circuit: skip the expensive AI call if the client left during
    // context building.
    if (clientGone || req.socket?.destroyed) return;

    const basePrompt = (config?.systemPrompt && config.systemPrompt.trim().length > 20)
      ? config.systemPrompt
      : CHAT_SYSTEM_PROMPT;
    const systemContent = `${basePrompt}\n\n${inventoryContext}`;

    const { endpoint, model } = providerEndpoint(provider);
    // In test mode allow the e2e suite to redirect the upstream to a controllable
    // mock — gated on NODE_ENV=test so it is inert in production.
    const streamEndpoint = (process.env.NODE_ENV === "test" && req.headers["x-test-ai-url"])
      ? String(req.headers["x-test-ai-url"])
      : endpoint;

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(streamEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: systemContent }, ...messages],
          max_tokens: 4096,
          stream: true,
        }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]),
      });
    } catch {
      // Suppress write errors when the client already disconnected
      if (!clientGone) {
        sendEvent(JSON.stringify({ error: "AI provider unreachable" }));
      }
      res.end();
      return;
    }

    if (!upstreamResponse.ok) {
      const err = await upstreamResponse.text();
      sendEvent(JSON.stringify({ error: `AI provider error: ${err.slice(0, 200)}` }));
      res.end();
      return;
    }

    if (!upstreamResponse.body) {
      sendEvent(JSON.stringify({ error: "No response body from AI provider" }));
      res.end();
      return;
    }

    const reader = upstreamResponse.body.getReader();
    activeReader = reader; // expose to disconnect handler for explicit cancellation
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!clientGone) {
        let done: boolean, value: Uint8Array | undefined;
        try {
          ({ done, value } = await reader.read());
        } catch (readErr) {
          // AbortError is expected when the client disconnects — treat it as a
          // clean disconnect rather than an error so the handler exits gracefully.
          if ((readErr as Error)?.name === "AbortError") break;
          throw readErr;
        }
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") {
            sendEvent("[DONE]");
            res.end();
            return;
          }
          try {
            const parsed = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
            };
            const chunk = parsed.choices?.[0]?.delta?.content;
            const finish = parsed.choices?.[0]?.finish_reason;
            if (chunk) sendEvent(JSON.stringify({ chunk }));
            if (finish === "stop" || finish === "length") {
              sendEvent("[DONE]");
              res.end();
              return;
            }
          } catch {
            // malformed JSON from provider — skip
          }
        }
      }
    } finally {
      reader.cancel().catch(() => { /* ignore cancel errors */ });
    }

    if (!clientGone) {
      sendEvent("[DONE]");
      res.end();
    }
  } finally {
    // Always remove both disconnect listeners so they don't outlive this request.
    req.removeListener("close", onClientGone);
    req.socket?.removeListener("close", onClientGone);
  }
});

// ---------------------------------------------------------------------------
// POST /api/ai/report — AI-generated structured report from live DB data
// ---------------------------------------------------------------------------
router.post("/ai/report", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { query, reportType, storeId: reqStoreId, days = 30 } = req.body as {
    query?: string;
    reportType?: string;
    storeId?: number;
    days?: number;
  };

  const [config] = await db.select().from(aiConfigTable).limit(1);

  let apiKey: string;
  let resolvedProvider = config?.provider ?? "grok";

  if (config?.apiKeyEncrypted) {
    try {
      apiKey = decrypt(config.apiKeyEncrypted);
    } catch {
      // Stored key can't be decrypted (SESSION_SECRET may have changed) — fall back to env var
    const envKey = process.env.XAI_API_KEY;
      if (envKey) {
        apiKey = envKey;
        resolvedProvider = "grok";
      } else {
        res.status(503).json({ error: "AI API key is corrupted. Please re-enter it in admin settings." });
        return;
      }
    }
  } else {
    // No stored key — try env var directly
    const envKey = process.env.XAI_API_KEY;
    if (envKey) {
      apiKey = envKey;
      resolvedProvider = "grok";
    } else {
      res.status(503).json({ error: "AI not configured. Please set an API key in admin settings." });
      return;
    }
  }

  const periodDays = Math.min(Math.max(Number(days) || 30, 7), 365);
  const since = new Date(Date.now() - periodDays * 86_400_000);

  // ── 1. Pull raw data from DB ───────────────────────────────────────────────
  const storeFilter = reqStoreId ? eq(storesTable.id, reqStoreId) : isNull(storesTable.deletedAt);

  const [stores, products, sessions, historySessions, allReceiving] = await Promise.all([
    db.select({ id: storesTable.id, name: storesTable.name, storeNumber: storesTable.storeNumber, isActive: storesTable.isActive })
      .from(storesTable)
      .where(storeFilter),

    db.select({ id: productsTable.id, name: productsTable.name, unit: productsTable.unit,
        minLevel: productsTable.minLevel, maxLevel: productsTable.maxLevel,
        cost: productsTable.cost, vendor: productsTable.vendor, categoryId: productsTable.categoryId,
      })
      .from(productsTable)
      .where(and(eq(productsTable.isActive, true), isNull(productsTable.deletedAt))),

    db.select({ id: inventorySessionsTable.id, storeId: inventorySessionsTable.storeId,
        warehouseId: inventorySessionsTable.warehouseId, startedAt: inventorySessionsTable.startedAt,
        status: inventorySessionsTable.status, finalizedAt: inventorySessionsTable.finalizedAt,
        notes: inventorySessionsTable.notes, usageSummarySnapshot: inventorySessionsTable.usageSummarySnapshot,
      })
      .from(inventorySessionsTable)
      .where(and(
        eq(inventorySessionsTable.status, "finalized"),
        gte(inventorySessionsTable.finalizedAt, since),
        ...(reqStoreId ? [eq(inventorySessionsTable.storeId, reqStoreId)] : []),
      ))
      .orderBy(desc(inventorySessionsTable.finalizedAt))
      .limit(200),

    db.select({ id: inventorySessionsTable.id, storeId: inventorySessionsTable.storeId,
        warehouseId: inventorySessionsTable.warehouseId, startedAt: inventorySessionsTable.startedAt,
        finalizedAt: inventorySessionsTable.finalizedAt, usageSummarySnapshot: inventorySessionsTable.usageSummarySnapshot,
      })
      .from(inventorySessionsTable)
      .where(and(
        eq(inventorySessionsTable.status, "finalized"),
        lt(inventorySessionsTable.finalizedAt, since),
        ...(reqStoreId ? [eq(inventorySessionsTable.storeId, reqStoreId)] : []),
      ))
      .orderBy(desc(inventorySessionsTable.finalizedAt)),

    db.select({ id: receivingRecordsTable.id, storeId: receivingRecordsTable.storeId,
        receivedAt: receivingRecordsTable.receivedAt,
      })
      .from(receivingRecordsTable)
      .where(and(
        gte(receivingRecordsTable.receivedAt, since),
        ...(reqStoreId ? [eq(receivingRecordsTable.storeId, reqStoreId)] : []),
      ))
      .limit(500),
  ]);

  // Session items for recent sessions
  const sessionIds = sessions.map((s) => s.id);
  const sessionItems = sessionIds.length > 0
    ? await db.select({
        sessionId: inventorySessionItemsTable.sessionId,
        productId: inventorySessionItemsTable.productId,
        fullContainers: inventorySessionItemsTable.fullContainers,
        partialContainers: inventorySessionItemsTable.partialContainers,
        estimatedGallons: inventorySessionItemsTable.estimatedGallons,
      })
      .from(inventorySessionItemsTable)
      .where(inArray(inventorySessionItemsTable.sessionId, sessionIds))
    : [];

  // ── 2. Compute derived summaries ──────────────────────────────────────────
  const storeMap = Object.fromEntries(stores.map((s) => [s.id, s]));
  const productMap = Object.fromEntries(products.map((p) => [p.id, p]));

  // Usage comes from server-calculated finalized snapshots, not from summing
  // stock counts. Summing stock snapshots would mislabel on-hand inventory as
  // consumption and produce wrong purchasing recommendations.
  const usageByProduct: Record<number, { name: string; unit: string; totalGallons: number; sessions: number }> = {};
  let missingUsageSnapshots = 0;
  const sessionsWithItems = new Set(sessionItems.map((item) => item.sessionId));
  for (const session of sessions) {
    const snapshot = parseUsageSnapshot(session.usageSummarySnapshot);
    if (!snapshot) {
      missingUsageSnapshots++;
      continue;
    }
    for (const line of snapshot) {
      const productId = Number(line.productId);
      const p = productMap[productId];
      const usage = Number(line.usage);
      if (!p || !Number.isFinite(usage) || usage < 0) continue;
      if (!usageByProduct[productId]) {
        usageByProduct[productId] = { name: p.name, unit: p.unit ?? "units", totalGallons: 0, sessions: 0 };
      }
      usageByProduct[productId]!.totalGallons += usage;
      if (usage > 0) usageByProduct[productId]!.sessions += 1;
    }
  }

  const topConsumers = Object.values(usageByProduct)
    .sort((a, b) => b.totalGallons - a.totalGallons)
    .slice(0, 10)
    .map((u) => `${u.name}: ${u.totalGallons.toFixed(3)} ${u.unit} consumed across ${u.sessions} sessions`);

  // Products below minimum level (using latest session per store)
  const latestByStore: Record<number, number> = {}; // storeId → sessionId
  for (const s of sessions) {
    if (!latestByStore[s.storeId]) latestByStore[s.storeId] = s.id;
  }
  const latestSessionIds = Object.values(latestByStore);
  const latestItems = sessionItems.filter((i) => latestSessionIds.includes(i.sessionId));

  const forecastEvidence = new Map<number, ReorderForecastEvidence>();
  const allBasisSessions = [...historySessions, ...sessions].sort(
    (a, b) => (a.finalizedAt?.getTime() ?? 0) - (b.finalizedAt?.getTime() ?? 0),
  );
  const latestStockByProduct: Record<number, number> = {};
  for (const item of latestItems) {
    const stock = parseInventoryQuantity(item.estimatedGallons, item.fullContainers);
    if (stock !== null) {
      latestStockByProduct[item.productId] =
        (latestStockByProduct[item.productId] ?? 0) + stock;
    }
  }

  for (const session of sessions) {
    const snapshot = parseUsageSnapshot(session.usageSummarySnapshot);
    if (!snapshot || !session.finalizedAt) continue;
    const previous = allBasisSessions
      .filter((candidate) =>
        candidate.id !== session.id &&
        candidate.storeId === session.storeId &&
        candidate.warehouseId === session.warehouseId &&
        (candidate.finalizedAt?.getTime() ?? 0) < (session.startedAt?.getTime() ?? 0),
      )
      .sort((a, b) => (b.finalizedAt?.getTime() ?? 0) - (a.finalizedAt?.getTime() ?? 0))[0];
    const intervalStart = previous?.finalizedAt ?? session.startedAt;
    const basisDays = intervalStart
      ? (session.finalizedAt.getTime() - intervalStart.getTime()) / 86_400_000
      : 0;
    if (!Number.isFinite(basisDays) || basisDays <= 0) continue;

    for (const line of snapshot) {
      const productId = Number(line.productId);
      const product = productMap[productId];
      const usage = Number(line.usage);
      const received = Number(line.received ?? 0);
      if (!product || !Number.isFinite(usage) || usage < 0) continue;
      const evidence = forecastEvidence.get(productId) ?? {
        productId,
        productName: product.name,
        unit: product.unit,
        unitCost: product.cost == null ? null : Number(product.cost),
        reorderPoint: product.minLevel == null ? null : Number(product.minLevel),
        targetLevel: product.maxLevel == null ? null : Number(product.maxLevel),
        currentStock: latestStockByProduct[productId] ?? null,
        samples: [],
        missingSnapshotCount: missingUsageSnapshots,
        receivingRecordCount: allReceiving.length,
      };
      evidence.samples.push({
        usage,
        received: Number.isFinite(received) && received >= 0 ? received : 0,
        basisDays,
        finalizedAt: session.finalizedAt.toISOString(),
      });
      forecastEvidence.set(productId, evidence);
    }
  }

  const reorderForecasts = products
    .filter((product) =>
      forecastEvidence.has(product.id) || latestStockByProduct[product.id] !== undefined,
    )
    .map((product) => calculateReorderForecast(
      forecastEvidence.get(product.id) ?? {
        productId: product.id,
        productName: product.name,
        unit: product.unit,
        unitCost: product.cost == null ? null : Number(product.cost),
        reorderPoint: product.minLevel == null ? null : Number(product.minLevel),
        targetLevel: product.maxLevel == null ? null : Number(product.maxLevel),
        currentStock: latestStockByProduct[product.id] ?? null,
        samples: [],
        missingSnapshotCount: missingUsageSnapshots,
        receivingRecordCount: allReceiving.length,
      },
    ));

  const alerts: string[] = [];
  for (const item of latestItems) {
    const p = productMap[item.productId];
    if (!p?.minLevel) continue;
    const gallons = parseInventoryQuantity(item.estimatedGallons, item.fullContainers);
    if (gallons === null) continue;
    const min = parseFloat(String(p.minLevel));
    if (gallons < min) {
      const store = storeMap[sessions.find((s) => s.id === item.sessionId)?.storeId ?? 0];
      alerts.push(`${p.name} at ${store?.name ?? "?"}: ${gallons.toFixed(1)} ${p.unit ?? "units"} (min: ${min})`);
    }
  }

  // Store session counts
  const sessionsByStore = sessions.reduce<Record<number, number>>((acc, s) => {
    acc[s.storeId] = (acc[s.storeId] ?? 0) + 1;
    return acc;
  }, {});

  const storeActivity = Object.entries(sessionsByStore)
    .map(([sid, cnt]) => `${storeMap[Number(sid)]?.name ?? `Store ${sid}`}: ${cnt} sessions`)
    .join(", ");

  // ── 3. Build prompt ────────────────────────────────────────────────────────
  const userQuery = query?.trim() || reportType || "Generate a comprehensive inventory executive summary";

  const contextText = `
DATABASE SNAPSHOT — Red Carpet Car Wash Inventory System
Period: last ${periodDays} days (since ${since.toISOString().split("T")[0]})
Generated: ${new Date().toISOString()}

STORES (${stores.length} total, ${stores.filter((s) => s.isActive).length} active):
${stores.map((s) => `  - ${s.name} (${s.storeNumber})${s.isActive ? "" : " [inactive]"}`).join("\n")}

PRODUCTS (${products.length} active):
${products.map((p) => `  - ${p.name} | unit: ${p.unit ?? "?"} | min: ${p.minLevel ?? "none"} | max: ${p.maxLevel ?? "none"} | cost: ${p.cost ? "$" + p.cost : "?"}/unit`).join("\n")}

SESSIONS (${sessions.length} finalized in period):
${storeActivity || "No sessions found"}

TOP 10 CONSUMERS BY MEASURED USAGE:
${topConsumers.length > 0 ? topConsumers.join("\n") : "Insufficient session data"}

USAGE MATH:
- Usage totals come from finalized server snapshots: previous count + received quantity - current count, floored at zero.
- Stock levels and usage are different measures. Do not describe stock on hand as consumption.
- Finalized sessions with missing usage snapshots are excluded from consumption totals (${missingUsageSnapshots} missing).

STOCK ALERTS — Items below minimum level (${alerts.length}):
${alerts.length > 0 ? alerts.join("\n") : "No items below minimum"}

RECEIVING RECORDS: ${allReceiving.length} deliveries in period

REORDER FORECASTS (calculated from verified finalized usage snapshots; do not invent missing fields):
${reorderForecasts.length > 0
    ? reorderForecasts.map((forecast) =>
      `  - ${forecast.productName}: status=${forecast.status}; reason=${forecast.statusReason}; inputs=${JSON.stringify(forecast.inputs)}${forecast.consumptionRatePerDay != null ? `; consumptionRatePerDay=${forecast.consumptionRatePerDay}` : ""}${forecast.daysOfSupply != null ? `; daysOfSupply=${forecast.daysOfSupply}; daysUntilReorder=${forecast.daysUntilReorder}; suggestedQuantity=${forecast.suggestedQuantity}; suggestedValue=${forecast.suggestedValue}` : ""}`,
    ).join("\n")
    : "No products have verified finalized usage snapshots in the requested period."}
`.trim();

  const systemPrompt = `You are an expert inventory intelligence AI for Red Carpet Car Wash — a multi-location car wash chain. Your job is to generate accurate, trustworthy inventory reports based ONLY on the database records provided.

ANALYSIS APPROACH — work through each step before writing your findings:
1. SCOPE: How many stores and sessions are in the dataset? Is the data complete or sparse?
2. CONSUMPTION: Which products are consumed fastest? Are rates consistent across stores or wildly different?
3. STOCK HEALTH: Which items are below minimum, and how critical is it? Days-of-supply if calculable.
4. ANOMALIES: Any store missing sessions? Any product spiking or disappearing? Receiving gaps?
5. ACTIONS: Rank recommendations by urgency — "order today" vs "monitor" vs "investigate".

RULES:
- NEVER fabricate, estimate, or invent numbers not present in the data
- Treat measured usage totals as consumption and current stock levels as on-hand inventory; never substitute one for the other
- Use the supplied REORDER FORECASTS as the source of truth for forecast status and numeric inputs. Never recalculate or fill omitted fields.
- Every forecast must remain labeled calculated, partial, or unavailable. Only repeat days of supply, reorder timing, or suggested quantity when those fields are present in a calculated forecast.
- If data is insufficient for a finding, omit that finding rather than guessing
- State dataQuality: "insufficient" when fewer than 2 sessions exist in the period
- Be specific: use product names, store names, exact numbers from the snapshot
- keyFindings must each be a complete, standalone sentence with a number in it
- recommendations must be prioritized and actionable (verb + subject + metric)
- risks must be business-impact statements, not restatements of findings

Respond with ONLY valid JSON (no markdown fences, no explanation outside JSON) matching exactly:
{
  "title": "string (descriptive, 8 words max)",
  "overview": "string (3-4 sentences: what period, what stores, top takeaway, confidence level)",
  "keyFindings": ["string", ...],
  "anomalies": ["string", ...],
  "recommendations": ["string", ...],
  "risks": ["string", ...],
  "confidence": 0.0-1.0,
  "dataQuality": "complete" | "partial" | "insufficient",
  "dataQualityNote": "string (only if partial/insufficient — explain why)"
}`;

  const userMessage = `${userQuery}\n\n${contextText}`;

  // ── 4. Call AI ─────────────────────────────────────────────────────────────
  const endpoint = resolvedProvider === "grok"
    ? "https://api.x.ai/v1/chat/completions"
    : "https://api.openai.com/v1/chat/completions";
  const model = resolvedProvider === "grok" ? "grok-3" : "gpt-4o";
  // Test-only endpoint override lets E2E verify encrypted-key resolution and
  // response handling without spending provider credits. NODE_ENV gates this
  // header out of production.
  const testEndpoint = process.env.NODE_ENV === "test" && req.headers["x-test-ai-url"]
    ? String(req.headers["x-test-ai-url"])
    : endpoint;

  const aiResponse = await fetch(testEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      max_tokens: 4096,
      response_format: resolvedProvider !== "grok" ? { type: "json_object" } : undefined,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!aiResponse.ok) {
    const err = await aiResponse.text();
    res.status(502).json({ error: `AI provider error: ${err.slice(0, 200)}` });
    return;
  }

  const aiData = await aiResponse.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  const rawContent = aiData.choices[0]?.message?.content ?? "";

  // Parse AI JSON — strip any accidental code fences
  let report: Record<string, unknown>;
  try {
    const cleaned = rawContent.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    report = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    // If JSON parse fails, return raw text as overview
    report = {
      title: "AI Report",
      overview: rawContent,
      keyFindings: [],
      anomalies: [],
      recommendations: [],
      risks: [],
      confidence: 0.5,
      dataQuality: "partial",
      dataQualityNote: "Report was generated but could not be structured.",
    };
  }

  const minimumQuality: ReportQuality =
    sessions.length < 2 || sessionsWithItems.size === 0
      ? "insufficient"
      : sessionsWithItems.size < sessions.length || missingUsageSnapshots > 0
        ? "partial"
        : "complete";
  const qualityNote = sessions.length === 0
    ? "No finalized inventory sessions were found in the requested period."
    : sessionsWithItems.size === 0
      ? "Finalized sessions were found, but none contained item data."
      : sessions.length < 2
        ? "Fewer than two finalized sessions are available, so trend conclusions are not reliable."
        : missingUsageSnapshots > 0
          ? `${missingUsageSnapshots} finalized session(s) did not include a usage snapshot, so consumption totals are partial.`
          : "";
  const normalizedReport = normalizeReport(report, minimumQuality, qualityNote, reorderForecasts);

  res.json({
    ...normalizedReport,
    generatedAt: new Date().toISOString(),
    periodDays,
    storeCount: stores.length,
    sessionCount: sessions.length,
    alertCount: alerts.length,
  });
});

export default router;
