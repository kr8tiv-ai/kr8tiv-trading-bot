import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { reviewTradePlan } from "@kr8tiv/accountability";
import { closeDatabase, openDatabase, type BetterSqliteDatabase } from "@kr8tiv/db";
import {
  applySchema,
  findTradeJournalEntry,
  listRecentTradeJournalEntries,
  recordApprovalDecision,
  recordTelegramDispatch,
  saveTradeJournalEntry,
  type TradeJournalEntry,
} from "@kr8tiv/executor";
import { createLogger } from "@kr8tiv/logger";
import { MEXCFuturesClient } from "@kr8tiv/mexc-futures";
import { WindowsCredentialManagerProvider } from "@kr8tiv/secrets";
import { buildTradePlansFromScan } from "@kr8tiv/signal-engine";
import {
  buildStyleConflicts,
  buildStyleFingerprint,
  reconstructTrades,
} from "@kr8tiv/style-engine";
import {
  AccountableTradePlanSchema,
  ImportedTradeSchema,
  type AccountabilityCheck,
  type AccountableTradePlan,
  type ImportedTrade,
  type MarketScan,
  type StyleConflict,
  type StyleFingerprint,
} from "@kr8tiv/shared-schemas";
import { publicOnlyProvider, scanSymbols } from "./scan-signals.js";
import {
  startTelegramDispatcher,
  type TelegramDispatcher,
} from "./trader-app-telegram.js";
import { buildPastTradeAnalysis } from "./trade-history-analysis.js";

const HOST = process.env.TRADER_APP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.TRADER_APP_PORT ?? 3020);
const BODY_LIMIT_BYTES = 64 * 1024;
const SUPPORTED_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;

const log = createLogger().child({ service: "trader-app" });
let dispatcher: TelegramDispatcher | null = null;

type ApiReviewResponse = {
  plan: AccountableTradePlan;
  review: AccountabilityCheck;
  conflicts: StyleConflict[];
  savedId: number | null;
  telegram:
    | { chatId: number; messageId: number; status: "pending" }
    | { error: string }
    | null;
};

type ApiModelPlan = {
  scan: Pick<MarketScan, "symbol" | "regime" | "currentPrice" | "warnings">;
  plan: AccountableTradePlan;
  review: AccountabilityCheck;
  conflicts: StyleConflict[];
};

type ApiModelScanResponse = {
  scans: MarketScan[];
  plans: ApiModelPlan[];
  generatedAtMs: number;
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  json(res, 404, { error: "not_found" });
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw.length === 0 ? {} : JSON.parse(raw));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

function withDb<T>(fn: (db: BetterSqliteDatabase) => T): T {
  const db = openDatabase();
  try {
    applySchema(db);
    return fn(db);
  } finally {
    closeDatabase(db);
  }
}

/**
 * Read imported trades for a single symbol. Feeds the FIFO lot reconstructor +
 * style fingerprint per request. Returns `[]` if no history has been ingested
 * yet — the cockpit falls back to "insufficient style sample" conflict.
 */
function readImportedTradesForSymbols(
  db: BetterSqliteDatabase,
  symbols: readonly string[],
): ImportedTrade[] {
  if (symbols.length === 0) return [];
  const placeholders = symbols.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT
        venue,
        market,
        symbol,
        side,
        price,
        size,
        quote_notional AS quoteNotional,
        fee,
        fee_currency AS feeCurrency,
        executed_at_ms AS executedAtMs,
        source_trade_id AS sourceTradeId,
        source_order_id AS sourceOrderId,
        leverage,
        risk_mode AS riskMode,
        thesis,
        journal_note AS journalNote,
        raw_response AS rawResponse
      FROM trades
      WHERE symbol IN (${placeholders})
      ORDER BY executed_at_ms ASC`,
    )
    .all(...symbols);
  return ImportedTradeSchema.array().parse(rows);
}

function loadFingerprints(symbols: readonly string[]): Map<string, StyleFingerprint> {
  return withDb((db) => {
    const trades = readImportedTradesForSymbols(db, symbols);
    const closed = reconstructTrades(trades);
    return new Map(
      symbols.map((symbol) => [symbol, buildStyleFingerprint(symbol, closed)]),
    );
  });
}

function conflictsForPlan(
  plan: AccountableTradePlan,
  fingerprint: StyleFingerprint | undefined,
  generatedAtMs: number,
): StyleConflict[] {
  const proposedNotionalQuote = plan.marginQuote * plan.leverage;
  return buildStyleConflicts(
    { symbol: plan.symbol, generatedAtMs, proposedNotionalQuote },
    fingerprint,
  );
}

function handleReview(
  body: unknown,
  save: boolean,
): ApiReviewResponse {
  const plan = AccountableTradePlanSchema.parse({
    ...(typeof body === "object" && body !== null ? body : {}),
    market: "mexc-futures",
  });
  const review = reviewTradePlan(plan);
  const fingerprints = loadFingerprints([plan.symbol]);
  const conflicts = conflictsForPlan(
    plan,
    fingerprints.get(plan.symbol),
    Date.now(),
  );
  const savedId = save
    ? withDb((db) =>
        saveTradeJournalEntry(db, plan, review, {
          conflicts,
          approvalStatus:
            dispatcher !== null && review.okToProceed ? "pending" : null,
        }),
      )
    : null;
  return { plan, review, conflicts, savedId, telegram: null };
}

async function dispatchApprovalIfPossible(
  response: ApiReviewResponse,
): Promise<ApiReviewResponse> {
  if (
    response.savedId === null ||
    !response.review.okToProceed ||
    dispatcher === null
  ) {
    return response;
  }
  try {
    const result = await dispatcher.sendApprovalCard({
      journalId: response.savedId,
      plan: response.plan,
      review: response.review,
      conflicts: response.conflicts,
    });
    withDb((db) =>
      recordTelegramDispatch(db, response.savedId ?? 0, {
        chatId: result.chatId,
        messageId: result.messageId,
      }),
    );
    return {
      ...response,
      telegram: {
        chatId: result.chatId,
        messageId: result.messageId,
        status: "pending",
      },
    };
  } catch (err) {
    log.warn({ err, savedId: response.savedId }, "telegram dispatch failed");
    return {
      ...response,
      telegram: {
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

async function handleModelScan(url: URL): Promise<ApiModelScanResponse> {
  const requestedNotional = Number(url.searchParams.get("notional") ?? "12");
  const marginQuote =
    Number.isFinite(requestedNotional) && requestedNotional > 0
      ? requestedNotional
      : 12;
  const client = await MEXCFuturesClient.create({ secrets: publicOnlyProvider });
  const scans = await scanSymbols(client, {
    json: true,
    symbols: [...SUPPORTED_SYMBOLS],
    shortInterval: "Min15",
    longInterval: "Hour4",
    limit: 120,
    style: false,
    proposedNotionalQuote: marginQuote,
  });
  const generatedAtMs = Date.now();
  const fingerprints = loadFingerprints(SUPPORTED_SYMBOLS);
  const plans = scans.flatMap((scan) =>
    buildTradePlansFromScan(scan, { marginQuote }).map((plan) => ({
      scan: {
        symbol: scan.symbol,
        regime: scan.regime,
        currentPrice: scan.currentPrice,
        warnings: scan.warnings,
      },
      plan,
      review: reviewTradePlan(plan),
      conflicts: conflictsForPlan(
        plan,
        fingerprints.get(plan.symbol),
        generatedAtMs,
      ),
    })),
  );
  return { scans, plans, generatedAtMs };
}

function countTodaysEntries(entries: TradeJournalEntry[]): number {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return entries.filter((entry) => entry.createdAtMs >= cutoff).length;
}

function countPendingApprovals(entries: TradeJournalEntry[]): number {
  return entries.filter((entry) => entry.approvalStatus === "pending").length;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/") {
    html(res, renderApp());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    json(res, 200, {
      ok: true,
      app: "kr8tiv-trader-cockpit",
      telegram: dispatcher !== null ? { chatId: dispatcher.chatId } : null,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/journal") {
    const entries = withDb((db) => listRecentTradeJournalEntries(db, 50));
    json(res, 200, {
      entries,
      telegramEnabled: dispatcher !== null,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/history-analysis") {
    const analysis = withDb((db) =>
      buildPastTradeAnalysis(readImportedTradesForSymbols(db, SUPPORTED_SYMBOLS)),
    );
    json(res, 200, analysis);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/model-scan") {
    try {
      json(res, 200, await handleModelScan(url));
    } catch (err) {
      json(res, 500, {
        error: "model_scan_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/review") {
    try {
      const payload = await readBody(req);
      const save = url.searchParams.get("save") === "1";
      let response = handleReview(payload, save);
      if (save) {
        response = await dispatchApprovalIfPossible(response);
      }
      json(res, 200, response);
    } catch (err) {
      json(res, 400, {
        error: "bad_trade_plan",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  notFound(res);
}

function renderApp(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>kr8tiv Trader Cockpit</title>
  <style>
    :root {
      --ink: #f4efe3;
      --muted: #a79e8d;
      --bg: #070806;
      --panel: rgba(20, 24, 18, 0.84);
      --line: rgba(244, 239, 227, 0.14);
      --green: #94ff98;
      --amber: #ffd36a;
      --red: #ff6b6b;
      --blue: #7ad7ff;
      --pink: #ff9acb;
      --steel: #20291f;
      --shadow: 0 24px 70px rgba(0, 0, 0, 0.42);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      font-family: Bahnschrift, "Segoe UI Variable", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 12% 14%, rgba(148, 255, 152, 0.16), transparent 26rem),
        radial-gradient(circle at 88% 5%, rgba(122, 215, 255, 0.15), transparent 23rem),
        linear-gradient(135deg, #060705 0%, #10140d 48%, #050604 100%);
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image:
        linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px);
      background-size: 42px 42px;
      mask-image: linear-gradient(to bottom, black, transparent 78%);
    }
    main {
      width: min(1440px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 32px 0 56px;
    }
    .hero {
      display: grid;
      grid-template-columns: 1.2fr 0.8fr;
      gap: 24px;
      align-items: stretch;
      margin-bottom: 24px;
    }
    .plate {
      border: 1px solid var(--line);
      background: var(--panel);
      box-shadow: var(--shadow);
      backdrop-filter: blur(18px);
      border-radius: 28px;
      overflow: hidden;
    }
    .intro {
      padding: 34px;
      position: relative;
    }
    .intro::after {
      content: "";
      position: absolute;
      width: 220px;
      height: 220px;
      right: -50px;
      bottom: -72px;
      border: 1px solid rgba(148, 255, 152, 0.35);
      border-radius: 50%;
      box-shadow: inset 0 0 54px rgba(148, 255, 152, 0.08);
    }
    .eyebrow {
      color: var(--green);
      letter-spacing: 0.2em;
      text-transform: uppercase;
      font-size: 12px;
      margin: 0 0 16px;
    }
    h1 {
      font-family: "Iowan Old Style", "Palatino Linotype", Cambria, serif;
      font-weight: 600;
      letter-spacing: -0.06em;
      font-size: clamp(48px, 7vw, 118px);
      line-height: 0.86;
      margin: 0;
      max-width: 900px;
    }
    .lede {
      max-width: 780px;
      color: var(--muted);
      font-size: 17px;
      line-height: 1.6;
      margin: 22px 0 0;
    }
    .status {
      padding: 24px;
      display: grid;
      gap: 14px;
    }
    .status h2, .card h2 {
      margin: 0;
      font-size: 16px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .mode-grid {
      display: grid;
      gap: 12px;
    }
    .scan-controls {
      display: grid;
      gap: 10px;
      margin-top: 8px;
    }
    .scan-controls button {
      width: 100%;
      justify-content: center;
    }
    .toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .toggle input { accent-color: var(--green); }
    .telegram-pill {
      display: inline-flex;
      gap: 6px;
      align-items: center;
      border-radius: 999px;
      padding: 5px 10px;
      background: rgba(148,255,152,0.12);
      color: var(--green);
      font-size: 11px;
      letter-spacing: 0.09em;
      text-transform: uppercase;
    }
    .telegram-pill.off {
      background: rgba(244,239,227,0.06);
      color: var(--muted);
    }
    .mode {
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 16px;
      background: rgba(255, 255, 255, 0.035);
    }
    .mode strong { display: block; color: var(--ink); margin-bottom: 6px; }
    .mode span { color: var(--muted); font-size: 13px; line-height: 1.45; }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 420px;
      gap: 24px;
    }
    .card { padding: 24px; }
    form {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
      margin-top: 20px;
    }
    label { display: grid; gap: 7px; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.09em; }
    input, select, textarea {
      width: 100%;
      border: 1px solid rgba(244, 239, 227, 0.18);
      border-radius: 16px;
      background: rgba(0, 0, 0, 0.32);
      color: var(--ink);
      padding: 13px 14px;
      font: inherit;
      outline: none;
    }
    textarea {
      min-height: 102px;
      resize: vertical;
    }
    input:focus, select:focus, textarea:focus {
      border-color: rgba(148, 255, 152, 0.75);
      box-shadow: 0 0 0 4px rgba(148, 255, 152, 0.09);
    }
    .span-2 { grid-column: span 2; }
    .span-4 { grid-column: span 4; }
    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      grid-column: span 4;
      margin-top: 6px;
    }
    button {
      border: 0;
      border-radius: 999px;
      padding: 13px 18px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      color: #071007;
      background: var(--green);
      transition: transform 160ms ease, filter 160ms ease;
    }
    button.secondary {
      background: transparent;
      color: var(--ink);
      border: 1px solid var(--line);
    }
    button.small {
      padding: 8px 14px;
      font-size: 12px;
      letter-spacing: 0.06em;
    }
    button:hover { transform: translateY(-1px); filter: brightness(1.05); }
    .verdict {
      margin-top: 18px;
      border-radius: 22px;
      border: 1px solid var(--line);
      padding: 18px;
      background: rgba(0, 0, 0, 0.28);
      min-height: 160px;
    }
    .verdict.ok { border-color: rgba(148, 255, 152, 0.42); }
    .verdict.block { border-color: rgba(255, 107, 107, 0.5); }
    .verdict h3 { margin: 0 0 12px; font-size: 30px; letter-spacing: -0.04em; }
    .metric-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 12px 0; }
    .metric {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 12px;
      background: rgba(255, 255, 255, 0.03);
    }
    .metric small { color: var(--muted); display: block; margin-bottom: 4px; }
    .metric b { font-size: 20px; }
    ul { margin: 10px 0 0; padding-left: 18px; color: var(--muted); }
    li { margin: 6px 0; }
    .conflicts { color: var(--pink); }
    .conflicts li { color: var(--pink); }
    .journal {
      display: grid;
      gap: 12px;
      margin-top: 18px;
      max-height: 740px;
      overflow: auto;
      padding-right: 4px;
    }
    .entry {
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 15px;
      background: linear-gradient(135deg, rgba(255,255,255,0.045), rgba(255,255,255,0.018));
    }
    .entry-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
      align-items: center;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      border: 1px solid var(--line);
      padding: 5px 9px;
      font-size: 12px;
      color: var(--muted);
    }
    .pill.ok { color: var(--green); border-color: rgba(148, 255, 152, 0.35); }
    .pill.block { color: var(--red); border-color: rgba(255, 107, 107, 0.35); }
    .pill.pending { color: var(--amber); border-color: rgba(255, 211, 106, 0.35); }
    .pill.approved { color: var(--green); border-color: rgba(148, 255, 152, 0.42); }
    .pill.rejected { color: var(--red); border-color: rgba(255, 107, 107, 0.42); }
    .pill.info { color: var(--blue); border-color: rgba(122, 215, 255, 0.42); }
    .pill.conflict { color: var(--pink); border-color: rgba(255, 154, 203, 0.42); }
    .entry p { margin: 8px 0 0; color: var(--muted); line-height: 1.45; font-size: 13px; }
    .model-panel {
      margin-top: 18px;
      border-top: 1px solid var(--line);
      padding-top: 18px;
    }
    .model-panel h3 {
      margin: 0 0 10px;
      font-size: 15px;
      color: var(--muted);
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .model-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .empty {
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 20px;
      padding: 20px;
      text-align: center;
    }
    @media (max-width: 980px) {
      .hero, .layout { grid-template-columns: 1fr; }
      form { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .span-4 { grid-column: span 2; }
      .actions { grid-column: span 2; }
    }
    @media (max-width: 620px) {
      main { width: min(100vw - 20px, 1440px); padding-top: 12px; }
      .intro, .card, .status { padding: 18px; border-radius: 22px; }
      form, .metric-row { grid-template-columns: 1fr; }
      .span-2, .span-4, .actions { grid-column: span 1; }
      h1 { font-size: 46px; }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div class="plate intro">
        <p class="eyebrow">MEXC futures accountability cockpit</p>
        <h1>Plan the trade before the trade plans you.</h1>
        <p class="lede">BTC, ETH, and SOL futures. Longs, shorts, scalps, and longer plays. The cockpit pulls live signals, the accountability engine argues with you, and Telegram confirms before anything counts as a real plan.</p>
      </div>
      <aside class="plate status">
        <h2>Risk modes <span id="telegram-status" class="telegram-pill off">telegram off</span></h2>
        <div class="mode-grid">
          <div class="mode"><strong>Sniper</strong><span>30x-100x, small margin, tight invalidation, fast review. Built for risky snipes without letting size drift.</span></div>
          <div class="mode"><strong>Core</strong><span>Higher capital, 30x max, cleaner thesis, better R/R. Built for trades that deserve patience.</span></div>
        </div>
        <div class="scan-controls">
          <button id="scan-model" type="button">Scan live BTC/ETH/SOL model</button>
          <label class="toggle">
            <input id="auto-poll" type="checkbox" checked>
            <span>Auto-refresh every 30s</span>
          </label>
          <span id="scan-meta" class="pill" style="align-self:flex-start">idle</span>
        </div>
      </aside>
    </section>

    <section class="layout">
      <div class="plate card">
        <h2>Trade intake</h2>
        <form id="trade-form">
          <label>Symbol
            <select name="symbol">
              <option>BTCUSDT</option>
              <option>ETHUSDT</option>
              <option>SOLUSDT</option>
            </select>
          </label>
          <label>Side
            <select name="direction">
              <option value="long">Long</option>
              <option value="short">Short</option>
            </select>
          </label>
          <label>Horizon
            <select name="horizon">
              <option value="scalp">Scalp</option>
              <option value="swing">Swing</option>
            </select>
          </label>
          <label>Mode
            <select name="riskMode">
              <option value="sniper">Sniper</option>
              <option value="core">Core</option>
            </select>
          </label>
          <label>Leverage
            <input name="leverage" inputmode="decimal" value="75">
          </label>
          <label>Margin USDT
            <input name="marginQuote" inputmode="decimal" value="12">
          </label>
          <label>Entry
            <input name="entryPrice" inputmode="decimal" value="93500">
          </label>
          <label>Stop
            <input name="stopLossPrice" inputmode="decimal" value="93140">
          </label>
          <label class="span-2">Target
            <input name="takeProfitPrice" inputmode="decimal" value="94400">
          </label>
          <label class="span-2">Generated from signal ID (optional)
            <input name="generatedFromSignalId" placeholder="signal_...">
          </label>
          <label class="span-4">Why this trade?
            <textarea name="thesis">15m reclaim with momentum confirmation after liquidity sweep</textarea>
          </label>
          <label class="span-4">Accountability note
            <textarea name="journalNote">This is planned, not revenge, and invalidates quickly below reclaim.</textarea>
          </label>
          <div class="actions">
            <button type="submit" data-save="0">Review only</button>
            <button type="submit" data-save="1" class="secondary">Review + save + Telegram</button>
          </div>
        </form>
        <div id="verdict" class="verdict">
          <h3>Waiting for a plan</h3>
          <p class="lede">Fill the trade, then make the bot argue with you before you size it. If Telegram is configured, a "Review + save + Telegram" press also sends you the card to approve on your phone.</p>
        </div>
        <div class="model-panel">
          <h3>Live model drafts</h3>
          <div id="model-output" class="journal"><div class="empty">Run the live model scan to pull MEXC futures structure.</div></div>
        </div>
      </div>

      <aside class="plate card">
        <h2>Past-trade analysis</h2>
        <div id="history-analysis" class="journal"><div class="empty">Loading imported MEXC futures history...</div></div>

        <div class="model-panel">
        <h2>Recent journal</h2>
        <div id="journal" class="journal"><div class="empty">Loading journal...</div></div>
        </div>
      </aside>
    </section>
  </main>

  <script>
    const form = document.querySelector("#trade-form");
    const verdictEl = document.querySelector("#verdict");
    const journalEl = document.querySelector("#journal");
    const historyEl = document.querySelector("#history-analysis");
    const modelEl = document.querySelector("#model-output");
    const scanModelButton = document.querySelector("#scan-model");
    const autoPollToggle = document.querySelector("#auto-poll");
    const scanMetaEl = document.querySelector("#scan-meta");
    const telegramStatusEl = document.querySelector("#telegram-status");
    let saveNext = false;
    let autoPollTimer = null;
    let modelScanInFlight = false;
    let telegramEnabled = false;

    function num(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      }[c]));
    }

    function formPayload() {
      const data = new FormData(form);
      const payload = Object.fromEntries(data.entries());
      for (const key of ["leverage", "marginQuote", "entryPrice", "stopLossPrice", "takeProfitPrice"]) {
        payload[key] = num(payload[key]);
      }
      if (!payload.generatedFromSignalId) delete payload.generatedFromSignalId;
      return payload;
    }

    function fillIntakeFromPlan(plan) {
      const map = {
        symbol: plan.symbol,
        direction: plan.direction,
        horizon: plan.horizon,
        riskMode: plan.riskMode,
        leverage: plan.leverage,
        marginQuote: plan.marginQuote,
        entryPrice: plan.entryPrice,
        stopLossPrice: plan.stopLossPrice,
        takeProfitPrice: plan.takeProfitPrice,
        generatedFromSignalId: plan.generatedFromSignalId ?? "",
      };
      for (const [name, value] of Object.entries(map)) {
        const el = form.elements.namedItem(name);
        if (el) el.value = value;
      }
      const thesisEl = form.elements.namedItem("thesis");
      if (thesisEl && (!thesisEl.value || thesisEl.dataset.autofilled === "1")) {
        thesisEl.value = plan.thesis;
        thesisEl.dataset.autofilled = "1";
      }
      const noteEl = form.elements.namedItem("journalNote");
      if (noteEl && (!noteEl.value || noteEl.dataset.autofilled === "1")) {
        noteEl.value = "Loaded from live model; review invalidation before saving.";
        noteEl.dataset.autofilled = "1";
      }
      form.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function issueList(label, items, extraClass = "") {
      if (!items.length) return "";
      return "<strong>" + label + "</strong><ul class='" + extraClass + "'>"
        + items.map((i) => "<li>" + escapeHtml(i.message) + "</li>").join("")
        + "</ul>";
    }

    function renderVerdict(result) {
      const r = result.review;
      const conflicts = result.conflicts ?? [];
      const tg = result.telegram;
      verdictEl.className = "verdict " + (r.okToProceed ? "ok" : "block");
      const tgLine = tg && "chatId" in tg
        ? "<p><span class='pill pending'>Telegram card sent — approve on your phone</span></p>"
        : tg && "error" in tg
        ? "<p><span class='pill rejected'>Telegram dispatch failed: " + escapeHtml(tg.error) + "</span></p>"
        : "";
      verdictEl.innerHTML =
        "<h3>" + (r.okToProceed ? "OK to plan" : "Blocked") + "</h3>" +
        "<div class='metric-row'>" +
          "<div class='metric'><small>Max loss</small><b>" + r.estimatedLossQuote.toFixed(2) + " USDT</b></div>" +
          "<div class='metric'><small>Reward</small><b>" + r.estimatedRewardQuote.toFixed(2) + " USDT</b></div>" +
          "<div class='metric'><small>R multiple</small><b>" + r.riskRewardRatio.toFixed(2) + "R</b></div>" +
        "</div>" +
        issueList("Blocks", r.blocks) +
        issueList("Warnings", r.warnings) +
        issueList("Style conflicts", conflicts, "conflicts") +
        (result.savedId ? "<p><span class='pill ok'>saved trade_journal#" + result.savedId + "</span></p>" : "") +
        tgLine;
    }

    function approvalPill(entry) {
      if (entry.approvalStatus === "approved") return "<span class='pill approved'>approved</span>";
      if (entry.approvalStatus === "rejected") return "<span class='pill rejected'>rejected</span>";
      if (entry.approvalStatus === "pending")  return "<span class='pill pending'>pending</span>";
      if (entry.approvalStatus === "expired")  return "<span class='pill rejected'>expired</span>";
      return "";
    }

    function renderConflictList(conflicts) {
      if (!conflicts || conflicts.length === 0) return "";
      return "<p><b>Style:</b></p><ul class='conflicts'>" +
        conflicts.map((c) => "<li>(" + c.severity + ") " + escapeHtml(c.message) + "</li>").join("") +
        "</ul>";
    }

    function renderJournal(entries) {
      if (!entries.length) {
        journalEl.innerHTML = "<div class='empty'>No journal entries yet. Save one clean plan and the receipts start here.</div>";
        return;
      }
      journalEl.innerHTML = entries.map((e) => {
        const when = new Date(e.createdAtMs).toLocaleString();
        return "<article class='entry'>" +
          "<div class='entry-head'><strong>" + escapeHtml(e.symbol) + " " + escapeHtml(e.direction.toUpperCase()) + " " + e.leverage + "x</strong>" +
          "<span class='pill " + (e.okToProceed ? "ok" : "block") + "'>" + (e.okToProceed ? "OK" : "BLOCKED") + "</span></div>" +
          "<span class='pill'>" + escapeHtml(e.riskMode) + " / " + escapeHtml(e.horizon) + " / " + when + "</span>" +
          " " + approvalPill(e) +
          "<p><b>Why:</b> " + escapeHtml(e.thesis) + "</p>" +
          "<p><b>Note:</b> " + escapeHtml(e.journalNote) + "</p>" +
          "<p>Risk " + e.estimatedLossQuote.toFixed(2) + " USDT → reward " + e.estimatedRewardQuote.toFixed(2) + " USDT (" + e.riskRewardRatio.toFixed(2) + "R)</p>" +
          renderConflictList(e.conflicts) +
        "</article>";
      }).join("");
    }

    function pct(value) {
      return (Number(value || 0) * 100).toFixed(0) + "%";
    }

    function money(value) {
      const n = Number(value || 0);
      return (n >= 0 ? "+" : "") + n.toFixed(2) + " USDT";
    }

    function renderHistoryAnalysis(analysis) {
      const totals = analysis.totals;
      if (!totals.importedTrades) {
        historyEl.innerHTML =
          "<div class='empty'>No imported futures fills yet. Run <code>pnpm history:ingest --symbols 'BTCUSDT,ETHUSDT,SOLUSDT' --days 90</code>, then this panel becomes your personal trading mirror.</div>";
        return;
      }
      historyEl.innerHTML =
        "<article class='entry'>" +
          "<div class='entry-head'><strong>All MEXC futures history</strong><span class='pill " + (totals.netPnlQuote >= 0 ? "ok" : "block") + "'>" + money(totals.netPnlQuote) + "</span></div>" +
          "<div class='metric-row'>" +
            "<div class='metric'><small>Imported fills</small><b>" + totals.importedTrades + "</b></div>" +
            "<div class='metric'><small>Closed trades</small><b>" + totals.closedTrades + "</b></div>" +
            "<div class='metric'><small>Win rate</small><b>" + pct(totals.winRate) + "</b></div>" +
          "</div>" +
          "<p>Profit factor " + Number(totals.profitFactor || 0).toFixed(2) + " | fees " + Number(totals.feesQuote || 0).toFixed(2) + " USDT | avg closed trade " + money(totals.avgNetPnlQuote) + "</p>" +
        "</article>" +
        analysis.symbols.map((row) =>
          "<article class='entry'>" +
            "<div class='entry-head'><strong>" + escapeHtml(row.symbol) + "</strong><span class='pill " + (row.netPnlQuote >= 0 ? "ok" : "block") + "'>" + money(row.netPnlQuote) + "</span></div>" +
            "<span class='pill'>" + row.closedTrades + " closed</span> <span class='pill'>" + pct(row.winRate) + " win</span> <span class='pill'>PF " + Number(row.profitFactor || 0).toFixed(2) + "</span>" +
            "<p>Long: " + row.long.closedTrades + " trades / " + money(row.long.netPnlQuote) + " / " + pct(row.long.winRate) + " win</p>" +
            "<p>Short: " + row.short.closedTrades + " trades / " + money(row.short.netPnlQuote) + " / " + pct(row.short.winRate) + " win</p>" +
          "</article>"
        ).join("");
    }

    function renderModel(data) {
      const ts = data.generatedAtMs
        ? new Date(data.generatedAtMs).toLocaleTimeString()
        : "";
      const meta = ts
        ? "<div class='model-meta'><span>last scan " + ts + "</span></div>"
        : "";
      if (!data.plans || !data.plans.length) {
        modelEl.innerHTML = meta +
          "<div class='empty'>No accountable trade plan right now. That is a signal too — wait for cleaner BTC/ETH/SOL structure.</div>" +
          (data.scans || []).map((s) =>
            "<article class='entry'><div class='entry-head'><strong>" + escapeHtml(s.symbol) + "</strong><span class='pill'>" + escapeHtml(s.regime) + "</span></div>" +
            "<p>Price " + s.currentPrice + " | Ideas: " + (s.ideas ? s.ideas.length : 0) + "</p></article>"
          ).join("");
        return;
      }
      modelEl.innerHTML = meta + data.plans.map((item, idx) => {
        const p = item.plan;
        const r = item.review;
        const conflicts = item.conflicts || [];
        return "<article class='entry'>" +
          "<div class='entry-head'><strong>" + escapeHtml(p.symbol) + " " + escapeHtml(p.direction.toUpperCase()) + " " + p.leverage + "x</strong>" +
          "<span class='pill " + (r.okToProceed ? "ok" : "block") + "'>" + (r.okToProceed ? "OK" : "BLOCKED") + "</span></div>" +
          "<span class='pill'>" + escapeHtml(p.riskMode) + " / " + escapeHtml(p.horizon) + " / " + escapeHtml(item.scan.regime) + "</span>" +
          "<p>Entry " + p.entryPrice + " | Stop " + p.stopLossPrice + " | Target " + p.takeProfitPrice + "</p>" +
          "<p>Risk " + r.estimatedLossQuote.toFixed(2) + " USDT → reward " + r.estimatedRewardQuote.toFixed(2) + " USDT (" + r.riskRewardRatio.toFixed(2) + "R)</p>" +
          "<p><b>Thesis:</b> " + escapeHtml(p.thesis) + "</p>" +
          renderConflictList(conflicts) +
          "<p><button class='small' data-use-plan='" + idx + "'>Use this plan</button></p>" +
        "</article>";
      }).join("");
      modelEl.querySelectorAll("button[data-use-plan]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.dataset.usePlan);
          const plan = data.plans[idx]?.plan;
          if (plan) fillIntakeFromPlan(plan);
        });
      });
    }

    async function loadJournal() {
      const res = await fetch("/api/journal");
      const body = await res.json();
      telegramEnabled = Boolean(body.telegramEnabled);
      telegramStatusEl.className = "telegram-pill " + (telegramEnabled ? "" : "off");
      telegramStatusEl.textContent = telegramEnabled ? "telegram on" : "telegram off";
      renderJournal(body.entries ?? []);
    }

    async function loadHistoryAnalysis() {
      const res = await fetch("/api/history-analysis");
      const body = await res.json();
      renderHistoryAnalysis(body);
    }

    async function runModelScan(reason) {
      if (modelScanInFlight) return;
      modelScanInFlight = true;
      scanMetaEl.textContent = reason === "auto" ? "auto-scanning..." : "scanning live...";
      if (reason !== "auto" || modelEl.textContent.trim() === "") {
        modelEl.innerHTML = "<div class='empty'>Scanning live MEXC futures candles...</div>";
      }
      try {
        const margin = encodeURIComponent(formPayload().marginQuote || 12);
        const res = await fetch("/api/model-scan?notional=" + margin);
        const body = await res.json();
        if (!res.ok) {
          scanMetaEl.textContent = "scan failed";
          modelEl.innerHTML = "<div class='empty'>Model scan failed: " + escapeHtml(body.message) + "</div>";
          return;
        }
        renderModel(body);
        const stamp = new Date(body.generatedAtMs ?? Date.now()).toLocaleTimeString();
        scanMetaEl.textContent = (reason === "auto" ? "auto " : "") + "scan @ " + stamp;
      } finally {
        modelScanInFlight = false;
      }
    }

    function startAutoPoll() {
      stopAutoPoll();
      autoPollTimer = setInterval(() => {
        if (document.hidden) return;
        runModelScan("auto").catch((err) => console.error("auto-scan failed:", err));
      }, 30_000);
    }

    function stopAutoPoll() {
      if (autoPollTimer !== null) {
        clearInterval(autoPollTimer);
        autoPollTimer = null;
      }
    }

    autoPollToggle.addEventListener("change", () => {
      if (autoPollToggle.checked) {
        runModelScan("auto").catch((err) => console.error("auto-scan failed:", err));
        startAutoPoll();
      } else {
        stopAutoPoll();
      }
    });

    form.addEventListener("click", (event) => {
      if (event.target instanceof HTMLButtonElement && event.target.type === "submit") {
        saveNext = event.target.dataset.save === "1";
      }
    });

    form.addEventListener("input", (event) => {
      if (event.target instanceof HTMLTextAreaElement) {
        event.target.dataset.autofilled = "0";
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      verdictEl.innerHTML = "<h3>Reviewing...</h3>";
      const res = await fetch("/api/review" + (saveNext ? "?save=1" : ""), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(formPayload()),
      });
      const body = await res.json();
      if (!res.ok) {
        verdictEl.className = "verdict block";
        verdictEl.innerHTML = "<h3>Invalid plan</h3><p>" + escapeHtml(body.message) + "</p>";
        return;
      }
      renderVerdict(body);
      await loadJournal();
    });

    scanModelButton.addEventListener("click", () => {
      runModelScan("manual").catch((err) => console.error("manual-scan failed:", err));
    });

    loadJournal().catch((err) => {
      journalEl.innerHTML = "<div class='empty'>Journal load failed: " + String(err) + "</div>";
    });

    loadHistoryAnalysis().catch((err) => {
      historyEl.innerHTML = "<div class='empty'>History analysis failed: " + escapeHtml(String(err)) + "</div>";
    });

    // Kick off the auto-poll loop immediately — this is the product: live signals streamed into the cockpit.
    runModelScan("boot").catch((err) => console.error("boot-scan failed:", err));
    startAutoPoll();
  </script>
</body>
</html>`;
}

async function buildStatusMessage(): Promise<string> {
  return withDb((db) => {
    const entries = listRecentTradeJournalEntries(db, 10);
    const today = countTodaysEntries(entries);
    const pending = countPendingApprovals(entries);
    const latest = entries[0];
    const latestLine = latest
      ? `${latest.symbol} ${latest.direction} ${latest.leverage}x ${latest.riskMode} @ ${new Date(latest.createdAtMs).toISOString().slice(0, 19)}`
      : "(no journal entries yet)";
    return [
      "kr8tiv cockpit",
      `Journal entries last 24h: ${today}`,
      `Pending approvals: ${pending}`,
      `Latest: ${latestLine}`,
    ].join("\n");
  });
}

async function main(): Promise<void> {
  dispatcher = await startTelegramDispatcher({
    secrets: new WindowsCredentialManagerProvider(),
    log,
    handlers: {
      lookupEntry: (journalId) => {
        const entry = withDb((db) => findTradeJournalEntry(db, journalId));
        if (!entry) return null;
        return {
          id: entry.id,
          symbol: entry.symbol,
          direction: entry.direction,
          leverage: entry.leverage,
          riskMode: entry.riskMode,
          telegramMessageId: entry.telegramMessageId,
        };
      },
      recordDecision: (journalId, decision) =>
        withDb((db) => recordApprovalDecision(db, journalId, decision)),
      onDecision: async (record) => {
        log.info(record, "approval decision recorded");
      },
      onStatus: () => buildStatusMessage(),
    },
  });
  if (dispatcher === null) {
    log.info(
      "trader-app running without Telegram — journal still works. Provision telegram-bot-token + TELEGRAM_CHAT_ID to enable approvals.",
    );
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      log.error({ err }, "route handler error");
      json(res, 500, {
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });

  server.listen(PORT, HOST, () => {
    process.stdout.write(`Trader cockpit listening at http://${HOST}:${PORT}\n`);
    if (dispatcher !== null) {
      process.stdout.write(
        `Telegram approvals enabled for chat ${dispatcher.chatId}\n`,
      );
    }
  });

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutting down trader-app");
    server.close();
    if (dispatcher !== null) {
      await dispatcher.stop();
      dispatcher = null;
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((err) => {
      log.error({ err }, "shutdown error");
      process.exit(1);
    });
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((err) => {
      log.error({ err }, "shutdown error");
      process.exit(1);
    });
  });
}

main().catch((err) => {
  log.fatal({ err }, "trader-app failed to start");
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
