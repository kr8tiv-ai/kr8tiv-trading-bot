import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { reviewTradePlan } from "@kr8tiv/accountability";
import { type BetterSqliteDatabase, closeDatabase, openDatabase } from "@kr8tiv/db";
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
import {
  type AccountabilityCheck,
  type AccountableTradePlan,
  AccountableTradePlanSchema,
  type ImportedTrade,
  ImportedTradeSchema,
  type MarketScan,
  type StyleConflict,
  type StyleFingerprint,
} from "@kr8tiv/shared-schemas";
import {
  analyzeMarket,
  assessFuturesContext,
  buildAdaptiveGridPlan,
  buildSetupBoardRow,
  buildTradePlansFromScan,
  compareBacktestStrategies,
  scoreGridTradingCandidate,
} from "@kr8tiv/signal-engine";
import {
  buildStyleConflicts,
  buildStyleFingerprint,
  reconstructTrades,
} from "@kr8tiv/style-engine";
import { type AssetFundamentalAssessment, fetchAssetFundamentals } from "./fundamentals.js";
import { readFuturesAccountStatus } from "./futures-account-status.js";
import { ingestFuturesHistory } from "./history-ingest.js";
import { publicOnlyProvider, scanSymbols } from "./scan-signals.js";
import { buildPastTradeAnalysis } from "./trade-history-analysis.js";
import {
  listRecentTradeFeedback,
  listStrategyEffectiveness,
  readTraderSettings,
  recordBacktestComparison,
  recordTradeFeedback,
  saveTraderSettings,
  type TradeFeedbackAction,
} from "./trader-app-state.js";
import { startTelegramDispatcher, type TelegramDispatcher } from "./trader-app-telegram.js";

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
  telegram: { chatId: number; messageId: number; status: "pending" } | { error: string } | null;
};

type ApiModelPlan = {
  scan: Pick<MarketScan, "symbol" | "regime" | "currentPrice" | "warnings" | "strategies">;
  plan: AccountableTradePlan;
  review: AccountabilityCheck;
  conflicts: StyleConflict[];
};

type ApiModelScanResponse = {
  scans: MarketScan[];
  plans: ApiModelPlan[];
  generatedAtMs: number;
};

type ApiBacktestResponse = {
  generatedAtMs: number;
  interval: "Min15";
  limit: number;
  results: Array<{
    symbol: string;
    currentPrice: number;
    comparison: ReturnType<typeof compareBacktestStrategies>;
  }>;
};

type ApiStrategyEffectivenessResponse = {
  generatedAtMs: number;
  rows: ReturnType<typeof listStrategyEffectiveness>;
};

type ApiGridPlanResponse = {
  generatedAtMs: number;
  interval: "Min15";
  limit: number;
  plans: Array<ReturnType<typeof buildAdaptiveGridPlan>>;
};

type ApiGridCandidatesResponse = {
  generatedAtMs: number;
  interval: "Min15";
  limit: number;
  candidates: Array<ReturnType<typeof scoreGridTradingCandidate>>;
};

type ApiMarketContextResponse = {
  generatedAtMs: number;
  contexts: Awaited<ReturnType<MEXCFuturesClient["fetchMarketContext"]>>[];
  assessments: ReturnType<typeof assessFuturesContext>[];
};

type ApiSetupBoardResponse = {
  generatedAtMs: number;
  interval: "Min15";
  limit: number;
  rows: Array<ReturnType<typeof buildSetupBoardRow>>;
};

const FEEDBACK_ACTIONS = new Set<TradeFeedbackAction>([
  "took_trade",
  "skipped_trade",
  "broke_rules",
  "review_later",
]);

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
    return new Map(symbols.map((symbol) => [symbol, buildStyleFingerprint(symbol, closed)]));
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

function handleReview(body: unknown, save: boolean): ApiReviewResponse {
  const plan = AccountableTradePlanSchema.parse({
    ...(typeof body === "object" && body !== null ? body : {}),
    market: "mexc-futures",
  });
  const review = reviewTradePlan(plan);
  const fingerprints = loadFingerprints([plan.symbol]);
  const conflicts = conflictsForPlan(plan, fingerprints.get(plan.symbol), Date.now());
  const savedId = save
    ? withDb((db) =>
        saveTradeJournalEntry(db, plan, review, {
          conflicts,
          approvalStatus: dispatcher !== null && review.okToProceed ? "pending" : null,
        }),
      )
    : null;
  return { plan, review, conflicts, savedId, telegram: null };
}

async function dispatchApprovalIfPossible(response: ApiReviewResponse): Promise<ApiReviewResponse> {
  if (response.savedId === null || !response.review.okToProceed || dispatcher === null) {
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
    Number.isFinite(requestedNotional) && requestedNotional > 0 ? requestedNotional : 12;
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
        strategies: scan.strategies,
      },
      plan,
      review: reviewTradePlan(plan),
      conflicts: conflictsForPlan(plan, fingerprints.get(plan.symbol), generatedAtMs),
    })),
  );
  return { scans, plans, generatedAtMs };
}

async function handleBacktest(url: URL): Promise<ApiBacktestResponse> {
  const requestedLimit = Number(url.searchParams.get("limit") ?? "320");
  const limit =
    Number.isInteger(requestedLimit) && requestedLimit >= 80 && requestedLimit <= 500
      ? requestedLimit
      : 320;
  const client = await MEXCFuturesClient.create({ secrets: publicOnlyProvider });
  const generatedAtMs = Date.now();
  const results = await Promise.all(
    SUPPORTED_SYMBOLS.map(async (symbol) => {
      const candles = await client.fetchCandles({
        symbol,
        interval: "Min15",
        limit,
      });
      return {
        symbol,
        currentPrice: candles.at(-1)?.close ?? 0,
        comparison: compareBacktestStrategies(candles, {
          lookback: 20,
          riskMultipleTarget: 2,
          gridSpacingPct: 0.006,
          feeRate: 0.0006,
        }),
      };
    }),
  );
  withDb((db) => {
    for (const row of results) {
      recordBacktestComparison(db, {
        generatedAtMs,
        interval: "Min15",
        limit,
        symbol: row.symbol,
        currentPrice: row.currentPrice,
        comparison: row.comparison,
      });
    }
  });

  return {
    generatedAtMs,
    interval: "Min15",
    limit,
    results,
  };
}

function handleStrategyEffectiveness(): ApiStrategyEffectivenessResponse {
  return {
    generatedAtMs: Date.now(),
    rows: withDb((db) => listStrategyEffectiveness(db)),
  };
}

async function handleGridPlan(url: URL): Promise<ApiGridPlanResponse> {
  const requestedLimit = Number(url.searchParams.get("limit") ?? "120");
  const limit =
    Number.isInteger(requestedLimit) && requestedLimit >= 80 && requestedLimit <= 500
      ? requestedLimit
      : 120;
  const requestedLeverage = Number(url.searchParams.get("leverage") ?? "20");
  const leverage =
    Number.isFinite(requestedLeverage) && requestedLeverage >= 1 && requestedLeverage <= 100
      ? requestedLeverage
      : 20;
  const settings = withDb((db) => readTraderSettings(db));
  const client = await MEXCFuturesClient.create({ secrets: publicOnlyProvider });
  const plans = await Promise.all(
    SUPPORTED_SYMBOLS.map(async (symbol) => {
      const candles = await client.fetchCandles({
        symbol,
        interval: "Min15",
        limit,
      });
      return buildAdaptiveGridPlan({
        symbol,
        candles,
        capitalQuote: settings.capitalBudgetQuote,
        leverage,
        riskMode: "medium",
        gridCount: 6,
      });
    }),
  );
  return {
    generatedAtMs: Date.now(),
    interval: "Min15",
    limit,
    plans,
  };
}

async function handleGridCandidates(url: URL): Promise<ApiGridCandidatesResponse> {
  const requestedLimit = Number(url.searchParams.get("limit") ?? "160");
  const limit =
    Number.isInteger(requestedLimit) && requestedLimit >= 80 && requestedLimit <= 500
      ? requestedLimit
      : 160;
  const requestedLeverage = Number(url.searchParams.get("leverage") ?? "20");
  const leverage =
    Number.isFinite(requestedLeverage) && requestedLeverage >= 1 && requestedLeverage <= 100
      ? requestedLeverage
      : 20;
  const settings = withDb((db) => readTraderSettings(db));
  const fundamentalsBySymbol = await tryFetchFundamentalsBySymbol();
  const client = await MEXCFuturesClient.create({ secrets: publicOnlyProvider });
  const candidates = await Promise.all(
    SUPPORTED_SYMBOLS.map(async (symbol) => {
      const [candles, context] = await Promise.all([
        client.fetchCandles({ symbol, interval: "Min15", limit }),
        client.fetchMarketContext(symbol),
      ]);
      const comparison = compareBacktestStrategies(candles, {
        lookback: 20,
        riskMultipleTarget: 2,
        gridSpacingPct: 0.006,
        feeRate: 0.0006,
      });
      const plan = buildAdaptiveGridPlan({
        symbol,
        candles,
        capitalQuote: settings.capitalBudgetQuote,
        leverage,
        riskMode: "medium",
        gridCount: 6,
      });
      const fundamentals = fundamentalsBySymbol.get(symbol);
      return scoreGridTradingCandidate({
        plan,
        comparison,
        context: assessFuturesContext(context),
        ...(fundamentals ? { fundamentals } : {}),
      });
    }),
  );
  return {
    generatedAtMs: Date.now(),
    interval: "Min15",
    limit,
    candidates,
  };
}

async function handleMarketContext(): Promise<ApiMarketContextResponse> {
  const client = await MEXCFuturesClient.create({ secrets: publicOnlyProvider });
  const contexts = await Promise.all(
    SUPPORTED_SYMBOLS.map((symbol) => client.fetchMarketContext(symbol)),
  );
  return {
    generatedAtMs: Date.now(),
    contexts,
    assessments: contexts.map((context) => assessFuturesContext(context)),
  };
}

async function tryFetchFundamentalsBySymbol(): Promise<Map<string, AssetFundamentalAssessment>> {
  try {
    const response = await fetchAssetFundamentals();
    return new Map(response.assessments.map((assessment) => [assessment.symbol, assessment]));
  } catch {
    // Fundamentals are a confirmation/veto layer, not the primary futures feed.
    // If CoinGecko is rate-limited or unavailable, keep the cockpit usable.
    return new Map();
  }
}

async function handleSetupBoard(url: URL): Promise<ApiSetupBoardResponse> {
  const requestedLimit = Number(url.searchParams.get("limit") ?? "160");
  const limit =
    Number.isInteger(requestedLimit) && requestedLimit >= 80 && requestedLimit <= 500
      ? requestedLimit
      : 160;
  const requestedLeverage = Number(url.searchParams.get("leverage") ?? "20");
  const leverage =
    Number.isFinite(requestedLeverage) && requestedLeverage >= 1 && requestedLeverage <= 100
      ? requestedLeverage
      : 20;
  const requestedMargin = Number(url.searchParams.get("margin") ?? "25");
  const marginQuote =
    Number.isFinite(requestedMargin) && requestedMargin > 0 ? requestedMargin : 25;
  const settings = withDb((db) => readTraderSettings(db));
  const fingerprints = loadFingerprints(SUPPORTED_SYMBOLS);
  const fundamentalsBySymbol = await tryFetchFundamentalsBySymbol();
  const client = await MEXCFuturesClient.create({ secrets: publicOnlyProvider });
  const generatedAtMs = Date.now();
  const rows = await Promise.all(
    SUPPORTED_SYMBOLS.map(async (symbol) => {
      const [shortCandles, longCandles, context] = await Promise.all([
        client.fetchCandles({ symbol, interval: "Min15", limit }),
        client.fetchCandles({ symbol, interval: "Hour4", limit: Math.min(limit, 240) }),
        client.fetchMarketContext(symbol),
      ]);
      const scan = analyzeMarket({
        symbol,
        market: "mexc-futures",
        shortTimeframe: "15m",
        longTimeframe: "4h",
        shortCandles,
        longCandles,
        marketContext: context,
      });
      const comparison = compareBacktestStrategies(shortCandles, {
        lookback: 20,
        riskMultipleTarget: 2,
        gridSpacingPct: 0.006,
        feeRate: 0.0006,
      });
      const gridPlan = buildAdaptiveGridPlan({
        symbol,
        candles: shortCandles,
        capitalQuote: settings.capitalBudgetQuote,
        leverage,
        riskMode: "medium",
        gridCount: 6,
      });
      const styleConflictCount = buildStyleConflicts(
        {
          symbol,
          generatedAtMs,
          proposedNotionalQuote: marginQuote * leverage,
        },
        fingerprints.get(symbol),
      ).length;
      const fundamentals = fundamentalsBySymbol.get(symbol);
      return buildSetupBoardRow({
        scan,
        comparison,
        context: assessFuturesContext(context),
        gridPlan,
        ...(fundamentals ? { fundamentals } : {}),
        styleConflictCount,
      });
    }),
  );
  return { generatedAtMs, interval: "Min15", limit, rows };
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

  if (req.method === "GET" && url.pathname === "/api/account-status") {
    try {
      json(res, 200, await readFuturesAccountStatus());
    } catch (err) {
      json(res, 500, {
        error: "account_status_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
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

  if (req.method === "GET" && url.pathname === "/api/settings") {
    json(
      res,
      200,
      withDb((db) => readTraderSettings(db)),
    );
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings") {
    try {
      const payload = await readBody(req);
      const body = typeof payload === "object" && payload !== null ? payload : {};
      json(
        res,
        200,
        withDb((db) => saveTraderSettings(db, body)),
      );
    } catch (err) {
      json(res, 400, {
        error: "bad_settings",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/history-ingest") {
    try {
      const payload = await readBody(req);
      const body = typeof payload === "object" && payload !== null ? payload : {};
      const requestedDays = Number((body as { days?: unknown }).days ?? 60);
      const days =
        Number.isInteger(requestedDays) && requestedDays >= 1 && requestedDays <= 365
          ? requestedDays
          : 60;
      const reports = await ingestFuturesHistory({
        symbols: [...SUPPORTED_SYMBOLS],
        days,
        limit: 100,
        maxPages: 5,
        json: true,
      });
      json(res, 200, {
        generatedAtMs: Date.now(),
        days,
        reports,
      });
    } catch (err) {
      json(res, 500, {
        error: "history_ingest_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/feedback") {
    json(res, 200, {
      feedback: withDb((db) => listRecentTradeFeedback(db, 30)),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/feedback") {
    try {
      const payload = await readBody(req);
      const body = typeof payload === "object" && payload !== null ? payload : {};
      const action = "action" in body ? body.action : null;
      if (typeof action !== "string" || !FEEDBACK_ACTIONS.has(action as TradeFeedbackAction)) {
        throw new Error(
          "feedback action must be one of took_trade/skipped_trade/broke_rules/review_later",
        );
      }
      const feedback = withDb((db) =>
        recordTradeFeedback(db, {
          journalId: "journalId" in body ? Number(body.journalId) : null,
          action: action as TradeFeedbackAction,
          note: "note" in body && typeof body.note === "string" ? body.note : "",
        }),
      );
      json(res, 200, {
        feedback,
        recent: withDb((db) => listRecentTradeFeedback(db, 30)),
      });
    } catch (err) {
      json(res, 400, {
        error: "bad_feedback",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/history-analysis") {
    const analysis = withDb((db) =>
      buildPastTradeAnalysis(readImportedTradesForSymbols(db, SUPPORTED_SYMBOLS)),
    );
    json(res, 200, analysis);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/fundamentals") {
    try {
      json(res, 200, await fetchAssetFundamentals());
    } catch (err) {
      json(res, 500, {
        error: "fundamentals_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
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

  if (req.method === "GET" && url.pathname === "/api/backtest") {
    try {
      json(res, 200, await handleBacktest(url));
    } catch (err) {
      json(res, 500, {
        error: "backtest_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/strategy-effectiveness") {
    try {
      json(res, 200, handleStrategyEffectiveness());
    } catch (err) {
      json(res, 500, {
        error: "strategy_effectiveness_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/grid-plan") {
    try {
      json(res, 200, await handleGridPlan(url));
    } catch (err) {
      json(res, 500, {
        error: "grid_plan_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/grid-candidates") {
    try {
      json(res, 200, await handleGridCandidates(url));
    } catch (err) {
      json(res, 500, {
        error: "grid_candidates_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/market-context") {
    try {
      json(res, 200, await handleMarketContext());
    } catch (err) {
      json(res, 500, {
        error: "market_context_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/setup-board") {
    try {
      json(res, 200, await handleSetupBoard(url));
    } catch (err) {
      json(res, 500, {
        error: "setup_board_failed",
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
    .quick-panel {
      grid-column: span 4;
      display: grid;
      gap: 12px;
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 14px;
      background: rgba(148, 255, 152, 0.045);
    }
    .quick-panel strong {
      color: var(--ink);
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .capital-panel {
      margin-top: 16px;
      margin-bottom: 18px;
    }
    .quick-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .settings-row label {
      min-width: 130px;
      flex: 1 1 130px;
    }
    .settings-row input {
      padding: 10px 11px;
      border-radius: 12px;
    }
    .chip {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 8px 11px;
      background: rgba(0, 0, 0, 0.24);
      color: var(--muted);
      font-size: 12px;
      cursor: pointer;
      transition: border-color 160ms ease, color 160ms ease, transform 160ms ease;
    }
    .chip:hover {
      border-color: rgba(148, 255, 152, 0.55);
      color: var(--ink);
      transform: translateY(-1px);
    }
    .chip.warn {
      border-color: rgba(255, 211, 106, 0.3);
      color: var(--amber);
    }
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
    .strategy-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid rgba(244, 239, 227, 0.08);
    }
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
          <div class="mode"><strong>Medium</strong><span>10x-50x, faster than core but not full-send. Built for clean BTC/ETH/SOL setups that need discipline more than adrenaline.</span></div>
          <div class="mode"><strong>Core</strong><span>Higher capital, 30x max, cleaner thesis, better R/R. Built for trades that deserve patience.</span></div>
        </div>
        <div class="scan-controls">
          <button id="scan-model" type="button">Scan live BTC/ETH/SOL model</button>
          <button id="run-backtest" type="button" class="secondary">Compare strategy edges</button>
          <button id="refresh-effectiveness" type="button" class="secondary">Refresh strategy memory</button>
          <button id="build-grid" type="button" class="secondary">Build futures grid plan</button>
          <button id="score-grid" type="button" class="secondary">Score grid candidates</button>
          <button id="refresh-fundamentals" type="button" class="secondary">Refresh fundamentals</button>
          <button id="refresh-context" type="button" class="secondary">Refresh funding + basis context</button>
          <button id="refresh-setup-board" type="button" class="secondary">Score setup board</button>
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
        <div class="quick-panel capital-panel">
          <strong>Capital settings</strong>
          <div class="quick-row settings-row">
            <label>Total futures capital
              <input id="capital-budget" inputmode="decimal" value="100">
            </label>
            <label>Default margin
              <input id="default-margin" inputmode="decimal" value="25">
            </label>
            <label>Sniper margin
              <input id="sniper-margin" inputmode="decimal" value="10">
            </label>
            <label>Medium margin
              <input id="medium-margin" inputmode="decimal" value="25">
            </label>
            <label>Core margin
              <input id="core-margin" inputmode="decimal" value="50">
            </label>
            <label>Daily loss stop
              <input id="max-daily-loss" inputmode="decimal" value="25">
            </label>
          </div>
          <div class="quick-row">
            <button id="save-settings" class="chip" type="button">Save capital rules</button>
            <span id="settings-status" class="pill">settings local</span>
          </div>
        </div>
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
              <option value="medium">Medium</option>
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
          <div class="quick-panel">
            <strong>Fast trade controls</strong>
            <div class="quick-row" aria-label="risk mode presets">
              <button class="chip warn" type="button" data-mode-preset="sniper">Sniper preset</button>
              <button class="chip" type="button" data-mode-preset="medium">Medium preset</button>
              <button class="chip" type="button" data-mode-preset="core">Core preset</button>
            </div>
            <div class="quick-row" aria-label="capital presets">
              <button class="chip" type="button" data-capital="10">10 USDT probe</button>
              <button class="chip" type="button" data-capital="25">25 USDT medium</button>
              <button class="chip" type="button" data-capital="50">50 USDT core</button>
              <button class="chip warn" type="button" data-capital="100">100 USDT deliberate</button>
            </div>
            <div class="quick-row" aria-label="trade reason presets">
              <button class="chip" type="button" data-why="Liquidity sweep + reclaim">Sweep + reclaim</button>
              <button class="chip" type="button" data-why="Trend continuation pullback">Trend pullback</button>
              <button class="chip" type="button" data-why="Breakout retest with volume">Breakout retest</button>
              <button class="chip" type="button" data-why="Funding and basis crowding fade">Funding fade</button>
              <button class="chip warn" type="button" data-why="Impulse/revenge check">Impulse check</button>
            </div>
          </div>
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
          <h3>Setup board</h3>
          <div id="setup-board-output" class="journal"><div class="empty">Scoring BTC/ETH/SOL setups across model, backtest, context, grid, and style conflicts...</div></div>
        </div>
        <div class="model-panel">
          <h3>Backtest lab</h3>
          <div id="backtest-output" class="journal"><div class="empty">Run the backtest to compare breakout, EMA pullback, Jarvis volume-profile, and adaptive futures grid on recent MEXC candles.</div></div>
        </div>
        <div class="model-panel">
          <h3>Strategy effectiveness memory</h3>
          <div id="strategy-effectiveness-output" class="journal"><div class="empty">Run Backtest Lab to begin ranking which strategy is actually working by symbol.</div></div>
        </div>
        <div class="model-panel">
          <h3>Grid planner</h3>
          <div id="grid-output" class="journal"><div class="empty">Build a medium-risk futures grid plan for BTC, ETH, and SOL using your saved capital rules. Planner only; no live grid orders fire.</div></div>
        </div>
        <div class="model-panel">
          <h3>Grid trading candidates</h3>
          <div id="grid-candidates-output" class="journal"><div class="empty">Score whether BTC, ETH, or SOL is actually gridable right now using replay edge, grid levels, and futures context.</div></div>
        </div>
        <div class="model-panel">
          <h3>Futures context</h3>
          <div id="context-output" class="journal"><div class="empty">Loading funding, basis, volume, and open-interest context...</div></div>
        </div>
        <div class="model-panel">
          <h3>Fundamentals pulse</h3>
          <div id="fundamentals-output" class="journal"><div class="empty">Loading BTC/ETH/SOL liquidity, market cap, and 24h move context...</div></div>
        </div>
        <div class="model-panel">
          <h3>Live model drafts</h3>
          <div id="model-output" class="journal"><div class="empty">Run the live model scan to pull MEXC futures structure.</div></div>
        </div>
      </div>

      <aside class="plate card">
        <h2>Live account</h2>
        <div id="account-status" class="journal"><div class="empty">Loading read-only MEXC futures account status...</div></div>
        <div class="quick-row" style="margin-top:10px">
          <button id="refresh-account" class="chip" type="button">Refresh account</button>
        </div>

        <div class="model-panel">
        <h2>Past-trade analysis</h2>
        <div class="quick-row" style="margin:0 0 10px">
          <button id="import-history" class="chip" type="button">Import 60d futures history</button>
        </div>
        <div id="history-analysis" class="journal"><div class="empty">Loading imported MEXC futures history...</div></div>
        </div>

        <div class="model-panel">
        <h2>Recent journal</h2>
        <div id="journal" class="journal"><div class="empty">Loading journal...</div></div>
        </div>
        <div class="model-panel">
        <h2>Quick feedback</h2>
        <div id="feedback-log" class="journal"><div class="empty">No feedback yet. Use the Took / Skipped / Broke rules buttons on a journal row.</div></div>
        </div>
      </aside>
    </section>
  </main>

  <script>
    const form = document.querySelector("#trade-form");
    const verdictEl = document.querySelector("#verdict");
    const journalEl = document.querySelector("#journal");
    const accountEl = document.querySelector("#account-status");
    const historyEl = document.querySelector("#history-analysis");
    const modelEl = document.querySelector("#model-output");
    const setupBoardEl = document.querySelector("#setup-board-output");
    const backtestEl = document.querySelector("#backtest-output");
    const effectivenessEl = document.querySelector("#strategy-effectiveness-output");
    const gridEl = document.querySelector("#grid-output");
    const gridCandidatesEl = document.querySelector("#grid-candidates-output");
    const contextEl = document.querySelector("#context-output");
    const fundamentalsEl = document.querySelector("#fundamentals-output");
    const feedbackEl = document.querySelector("#feedback-log");
    const scanModelButton = document.querySelector("#scan-model");
    const runBacktestButton = document.querySelector("#run-backtest");
    const refreshEffectivenessButton = document.querySelector("#refresh-effectiveness");
    const buildGridButton = document.querySelector("#build-grid");
    const scoreGridButton = document.querySelector("#score-grid");
    const refreshFundamentalsButton = document.querySelector("#refresh-fundamentals");
    const refreshContextButton = document.querySelector("#refresh-context");
    const refreshSetupBoardButton = document.querySelector("#refresh-setup-board");
    const refreshAccountButton = document.querySelector("#refresh-account");
    const importHistoryButton = document.querySelector("#import-history");
    const saveSettingsButton = document.querySelector("#save-settings");
    const autoPollToggle = document.querySelector("#auto-poll");
    const scanMetaEl = document.querySelector("#scan-meta");
    const settingsStatusEl = document.querySelector("#settings-status");
    const telegramStatusEl = document.querySelector("#telegram-status");
    let saveNext = false;
    let autoPollTimer = null;
    let modelScanInFlight = false;
    let telegramEnabled = false;
    let activeSettings = {
      capitalBudgetQuote: 100,
      defaultMarginQuote: 25,
      sniperMarginQuote: 10,
      mediumMarginQuote: 25,
      coreMarginQuote: 50,
      maxDailyLossQuote: 25,
    };

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

    function settingInput(id) {
      return document.querySelector("#" + id);
    }

    function settingsPayload() {
      return {
        capitalBudgetQuote: num(settingInput("capital-budget").value),
        defaultMarginQuote: num(settingInput("default-margin").value),
        sniperMarginQuote: num(settingInput("sniper-margin").value),
        mediumMarginQuote: num(settingInput("medium-margin").value),
        coreMarginQuote: num(settingInput("core-margin").value),
        maxDailyLossQuote: num(settingInput("max-daily-loss").value),
      };
    }

    function applySettings(settings) {
      activeSettings = { ...activeSettings, ...settings };
      settingInput("capital-budget").value = settings.capitalBudgetQuote;
      settingInput("default-margin").value = settings.defaultMarginQuote;
      settingInput("sniper-margin").value = settings.sniperMarginQuote;
      settingInput("medium-margin").value = settings.mediumMarginQuote;
      settingInput("core-margin").value = settings.coreMarginQuote;
      settingInput("max-daily-loss").value = settings.maxDailyLossQuote;
      const marginEl = form.elements.namedItem("marginQuote");
      if (marginEl && (!marginEl.value || marginEl.value === "12")) {
        marginEl.value = settings.defaultMarginQuote;
      }
      settingsStatusEl.textContent = "capital " + settings.capitalBudgetQuote + " USDT · default " + settings.defaultMarginQuote + " USDT";
    }

    function applyModePreset(mode) {
      const presets = {
        sniper: {
          riskMode: "sniper",
          horizon: "scalp",
          leverage: 75,
          marginQuote: activeSettings.sniperMarginQuote,
          thesis: "Fast sniper idea: only valid if entry is immediate, stop is tight, and invalidation is respected.",
          note: "Sniper preset applied. No averaging down. If it hesitates, skip.",
        },
        medium: {
          riskMode: "medium",
          horizon: "scalp",
          leverage: 25,
          marginQuote: activeSettings.mediumMarginQuote,
          thesis: "Medium-risk setup: model, backtest, context, and personal style should mostly agree before entry.",
          note: "Medium preset applied. Size is controlled; wait for confirmation instead of forcing.",
        },
        core: {
          riskMode: "core",
          horizon: "swing",
          leverage: 15,
          marginQuote: activeSettings.coreMarginQuote,
          thesis: "Core setup: larger capital only when thesis is clean, invalidation is clear, and patience is justified.",
          note: "Core preset applied. Lower leverage, stronger thesis, no impulse entry.",
        },
      };
      const preset = presets[mode];
      if (!preset) return;
      for (const [name, value] of Object.entries({
        riskMode: preset.riskMode,
        horizon: preset.horizon,
        leverage: preset.leverage,
        marginQuote: preset.marginQuote,
      })) {
        const el = form.elements.namedItem(name);
        if (el) el.value = value;
      }
      const thesisEl = form.elements.namedItem("thesis");
      const noteEl = form.elements.namedItem("journalNote");
      if (thesisEl && thesisEl.dataset.autofilled !== "0") {
        thesisEl.value = preset.thesis;
        thesisEl.dataset.autofilled = "1";
      }
      if (noteEl && noteEl.dataset.autofilled !== "0") {
        noteEl.value = preset.note;
        noteEl.dataset.autofilled = "1";
      }
      settingsStatusEl.textContent = mode + " preset · " + preset.marginQuote + " USDT margin · " + preset.leverage + "x";
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

    function applyQuickReason(label) {
      const thesisEl = form.elements.namedItem("thesis");
      const noteEl = form.elements.namedItem("journalNote");
      const symbol = form.elements.namedItem("symbol")?.value || "BTCUSDT";
      const direction = form.elements.namedItem("direction")?.value || "long";
      const horizon = form.elements.namedItem("horizon")?.value || "scalp";

      const thesisMap = {
        "Liquidity sweep + reclaim": horizon + " " + direction + " on " + symbol + ": liquidity sweep reclaimed structure with momentum confirmation.",
        "Trend continuation pullback": horizon + " " + direction + " on " + symbol + ": trend continuation pullback into value with invalidation defined.",
        "Breakout retest with volume": horizon + " " + direction + " on " + symbol + ": breakout retest holding with volume confirmation.",
        "Funding and basis crowding fade": horizon + " " + direction + " on " + symbol + ": funding/basis crowding supports a fade with tight invalidation.",
        "Impulse/revenge check": horizon + " " + direction + " on " + symbol + ": I am checking whether this is impulse; only valid if structure and stop are clean.",
      };
      const noteMap = {
        "Impulse/revenge check": "Accountability flag: pause 60 seconds and confirm this is not revenge, boredom, or chasing.",
      };

      if (thesisEl) {
        thesisEl.value = thesisMap[label] || label;
        thesisEl.dataset.autofilled = "1";
      }
      if (noteEl) {
        noteEl.value = noteMap[label] || "Fast-preset reason selected; I must verify stop, target, and sizing before entry.";
        noteEl.dataset.autofilled = "1";
      }
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

    function renderDrivers(strategies) {
      if (!strategies || strategies.length === 0) return "";
      return "<p><b>Drivers:</b> " + strategies.map((s) =>
        "<span class='pill'>" + escapeHtml(s.strategy) + " " + escapeHtml(s.bias) + " " + Math.round((s.confidence || 0) * 100) + "%</span>"
      ).join(" ") + "</p>";
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
          "<div class='quick-row feedback-row'>" +
            "<button class='chip' type='button' data-feedback='took_trade' data-feedback-note='took planned trade; stop and target were defined first' data-journal-id='" + e.id + "'>Took planned</button>" +
            "<button class='chip' type='button' data-feedback='skipped_trade' data-feedback-note='skipped because setup/context/backtest did not agree enough' data-journal-id='" + e.id + "'>Skipped: weak edge</button>" +
            "<button class='chip' type='button' data-feedback='skipped_trade' data-feedback-note='skipped because I felt rushed, emotional, or revenge-y' data-journal-id='" + e.id + "'>Skipped: emotion</button>" +
            "<button class='chip warn' type='button' data-feedback='broke_rules' data-feedback-note='broke rules: entered from FOMO or before confirmation' data-journal-id='" + e.id + "'>FOMO entry</button>" +
            "<button class='chip warn' type='button' data-feedback='broke_rules' data-feedback-note='broke rules: moved or ignored stop loss' data-journal-id='" + e.id + "'>Moved stop</button>" +
            "<button class='chip warn' type='button' data-feedback='broke_rules' data-feedback-note='broke rules: size/leverage was too aggressive for this setup' data-journal-id='" + e.id + "'>Oversized</button>" +
            "<button class='chip' type='button' data-feedback='review_later' data-feedback-note='review later: needs screenshot/context notes after session' data-journal-id='" + e.id + "'>Review later</button>" +
          "</div>" +
        "</article>";
      }).join("");
      journalEl.querySelectorAll("button[data-feedback]").forEach((btn) => {
        btn.addEventListener("click", () => {
          recordFeedback(btn.dataset.feedback, Number(btn.dataset.journalId), btn.dataset.feedbackNote || "");
        });
      });
    }

    function pct(value) {
      return (Number(value || 0) * 100).toFixed(0) + "%";
    }

    function tinyPct(value) {
      return (Number(value || 0) * 100).toFixed(3) + "%";
    }

    function money(value) {
      const n = Number(value || 0);
      return (n >= 0 ? "+" : "") + n.toFixed(2) + " USDT";
    }

    function feedbackLabel(action) {
      if (action === "took_trade") return "Took trade";
      if (action === "skipped_trade") return "Skipped";
      if (action === "broke_rules") return "Broke rules";
      return "Review later";
    }

    function renderFeedback(items) {
      if (!items || items.length === 0) {
        feedbackEl.innerHTML = "<div class='empty'>No feedback yet. Use the journal buttons to create accountability receipts.</div>";
        return;
      }
      feedbackEl.innerHTML = items.map((item) =>
        "<article class='entry'>" +
          "<div class='entry-head'><strong>" + escapeHtml(feedbackLabel(item.action)) + "</strong><span class='pill'>TJ#" + (item.journalId ?? "manual") + "</span></div>" +
          "<p>" + escapeHtml(item.note || "quick click") + "</p>" +
          "<p>" + new Date(item.createdAtMs).toLocaleString() + "</p>" +
        "</article>"
      ).join("");
    }

    function renderHistoryAnalysis(analysis) {
      const totals = analysis.totals;
      if (!totals.importedTrades) {
        historyEl.innerHTML =
          "<div class='empty'>No imported futures fills yet. Use the import button above or run <code>pnpm history:ingest --symbols 'BTCUSDT,ETHUSDT,SOLUSDT' --days 90</code>, then this panel becomes your personal trading mirror.</div>";
        return;
      }
      const coaching = analysis.coaching || [];
      const coachingHtml = coaching.length
        ? "<article class='entry'>" +
          "<div class='entry-head'><strong>Coaching flags</strong><span class='pill pending'>" + coaching.length + " active</span></div>" +
          coaching.slice(0, 5).map((item) =>
            "<div class='strategy-row'>" +
              "<span class='pill " + (item.severity === "block" ? "block" : item.severity === "warn" ? "pending" : "info") + "'>" + escapeHtml(item.severity) + "</span>" +
              "<span class='pill'>" + escapeHtml(item.scope) + "</span>" +
              "<span class='pill'>" + escapeHtml(item.code) + "</span>" +
              "<p><b>" + escapeHtml(item.message) + "</b><br>" + escapeHtml(item.suggestedAction) + "<br><small>" + escapeHtml(item.evidence) + "</small></p>" +
            "</div>"
          ).join("") +
          "</article>"
        : "<article class='entry'><div class='entry-head'><strong>Coaching flags</strong><span class='pill ok'>none</span></div><p>No strong personal leak detected yet. Keep logging trades so the mirror gets sharper.</p></article>";
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
        coachingHtml +
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
            "<p>Price " + s.currentPrice + " | Ideas: " + (s.ideas ? s.ideas.length : 0) + "</p>" +
            renderDrivers(s.strategies) +
            "</article>"
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
          renderDrivers(item.scan.strategies) +
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

    function renderBacktest(data) {
      const stamp = data.generatedAtMs ? new Date(data.generatedAtMs).toLocaleTimeString() : "";
      backtestEl.innerHTML =
        "<div class='model-meta'><span>15m replay " + escapeHtml(stamp) + " · " + data.limit + " candles</span></div>" +
        data.results.map((row) => {
          const c = row.comparison;
          const best = c.best;
          const rows = (c.results ?? []).map((b) =>
            "<div class='strategy-row'>" +
              "<span class='pill'>" + escapeHtml(b.strategy) + "</span>" +
              "<span class='pill " + (b.netPnlPct >= 0 ? "ok" : "block") + "'>" + (b.netPnlPct >= 0 ? "+" : "") + b.netPnlPct.toFixed(2) + "%</span>" +
              "<span class='pill'>" + b.trades.length + " trades</span>" +
              "<span class='pill'>" + pct(b.winRate) + " win</span>" +
              "<span class='pill'>PF " + Number(b.profitFactor || 0).toFixed(2) + "</span>" +
              "<span class='pill'>DD " + Number(b.maxDrawdownPct || 0).toFixed(2) + "%</span>" +
            "</div>"
          ).join("");
          return "<article class='entry'>" +
            "<div class='entry-head'><strong>" + escapeHtml(row.symbol) + "</strong><span class='pill " + (best && best.netPnlPct >= 0 ? "ok" : "block") + "'>" + escapeHtml(best ? best.strategy : "no edge") + "</span></div>" +
            "<p>" + escapeHtml(c.recommendation || "not enough replay data") + " | current price " + Number(row.currentPrice || 0).toFixed(4) + "</p>" +
            rows +
            ((c.results ?? []).flatMap((b) => b.warnings ?? []).length ? "<p>" + (c.results ?? []).flatMap((b) => b.warnings ?? []).map(escapeHtml).join(" | ") + "</p>" : "") +
          "</article>";
        }).join("");
    }

    function renderStrategyEffectiveness(data) {
      const stamp = data.generatedAtMs ? new Date(data.generatedAtMs).toLocaleTimeString() : "";
      const rows = data.rows ?? [];
      if (!rows.length) {
        effectivenessEl.innerHTML =
          "<div class='empty'>No saved backtest snapshots yet. Run Backtest Lab once to start the strategy memory.</div>";
        return;
      }
      effectivenessEl.innerHTML =
        "<div class='model-meta'><span>strategy memory " + escapeHtml(stamp) + " · saved Backtest Lab snapshots</span></div>" +
        rows.map((row) => {
          const bestClass = row.bestStrategy ? "ok" : "block";
          const strategies = (row.strategies ?? []).map((item) =>
            "<div class='strategy-row'>" +
              "<span class='pill'>" + escapeHtml(item.strategy) + "</span>" +
              "<span class='pill " + (item.latestNetPnlPct >= 0 ? "ok" : "block") + "'>latest " + (item.latestNetPnlPct >= 0 ? "+" : "") + Number(item.latestNetPnlPct || 0).toFixed(2) + "%</span>" +
              "<span class='pill'>avg " + (item.avgNetPnlPct >= 0 ? "+" : "") + Number(item.avgNetPnlPct || 0).toFixed(2) + "%</span>" +
              "<span class='pill'>" + item.latestTradeCount + " trades</span>" +
              "<span class='pill'>PF " + Number(item.latestProfitFactor || 0).toFixed(2) + "</span>" +
              "<span class='pill'>score " + Number(item.score || 0).toFixed(2) + "</span>" +
              "<span class='pill'>" + item.samples + " samples</span>" +
            "</div>"
          ).join("");
          return "<article class='entry'>" +
            "<div class='entry-head'><strong>" + escapeHtml(row.symbol) + " strategy memory</strong><span class='pill " + bestClass + "'>" + escapeHtml(row.bestStrategy || "no edge") + "</span></div>" +
            "<p>" + escapeHtml(row.latestRecommendation || "Run Backtest Lab for evidence.") + " | current " + Number(row.latestCurrentPrice || 0).toFixed(row.symbol === "SOLUSDT" ? 4 : 2) + " | snapshots " + row.snapshotCount + "</p>" +
            strategies +
          "</article>";
        }).join("");
    }

    function renderGridPlan(data) {
      const stamp = data.generatedAtMs ? new Date(data.generatedAtMs).toLocaleTimeString() : "";
      gridEl.innerHTML =
        "<div class='model-meta'><span>15m grid map " + escapeHtml(stamp) + " · " + data.limit + " candles · planner only</span></div>" +
        data.plans.map((plan) => {
          const warnings = plan.warnings ?? [];
          const levels = plan.levels ?? [];
          const shownLevels = levels.slice(0, 6).map((level) =>
            "<div class='strategy-row'>" +
              "<span class='pill " + (level.side === "long" ? "ok" : "pending") + "'>" + escapeHtml(level.side.toUpperCase()) + "</span>" +
              "<span class='pill'>entry " + Number(level.entryPrice || 0).toFixed(plan.symbol === "SOLUSDT" ? 4 : 2) + "</span>" +
              "<span class='pill'>TP " + Number(level.takeProfitPrice || 0).toFixed(plan.symbol === "SOLUSDT" ? 4 : 2) + "</span>" +
              "<span class='pill block'>SL " + Number(level.stopLossPrice || 0).toFixed(plan.symbol === "SOLUSDT" ? 4 : 2) + "</span>" +
              "<span class='pill'>" + Number(level.marginQuote || 0).toFixed(2) + " margin</span>" +
              "<span class='pill'>" + Number(level.notionalQuote || 0).toFixed(2) + " notional</span>" +
            "</div>"
          ).join("");
          return "<article class='entry'>" +
            "<div class='entry-head'><strong>" + escapeHtml(plan.symbol) + " adaptive futures grid</strong><span class='pill " + (levels.length ? "ok" : "block") + "'>" + levels.length + " levels</span></div>" +
            "<p>Range " + Number(plan.rangeLow || 0).toFixed(plan.symbol === "SOLUSDT" ? 4 : 2) + " → " + Number(plan.rangeHigh || 0).toFixed(plan.symbol === "SOLUSDT" ? 4 : 2) +
            " (" + (Number(plan.rangePct || 0) * 100).toFixed(2) + "%) · current " + Number(plan.currentPrice || 0).toFixed(plan.symbol === "SOLUSDT" ? 4 : 2) + "</p>" +
            "<p><span class='pill'>" + escapeHtml(plan.riskMode) + "</span> <span class='pill'>" + Number(plan.allocatedCapitalQuote || 0).toFixed(2) + " USDT allocated</span>" +
            (levels[0] ? " <span class='pill'>" + levels[0].leverage + "x</span>" : "") + "</p>" +
            (warnings.length ? "<p>" + warnings.map(escapeHtml).join(" | ") + "</p>" : "") +
            (shownLevels || "<div class='empty'>No grid levels. The range or capital settings failed the planner guardrails.</div>") +
          "</article>";
        }).join("");
    }

    function renderGridCandidates(data) {
      const stamp = data.generatedAtMs ? new Date(data.generatedAtMs).toLocaleTimeString() : "";
      gridCandidatesEl.innerHTML =
        "<div class='model-meta'><span>grid candidate score " + escapeHtml(stamp) + " · paper/planner only</span></div>" +
        (data.candidates ?? []).map((candidate) => {
          const actionClass = candidate.action === "paper_grid" ? "ok" : candidate.action === "watch" ? "pending" : "block";
          const blockers = candidate.blockers ?? [];
          const notes = candidate.notes ?? [];
          return "<article class='entry'>" +
            "<div class='entry-head'><strong>" + escapeHtml(candidate.symbol) + " grid candidate</strong><span class='pill " + actionClass + "'>" + escapeHtml(candidate.action.replace("_", " ")) + " · " + candidate.score + "/100</span></div>" +
            "<p><span class='pill'>levels " + candidate.gridLevelCount + "</span> <span class='pill'>range " + (Number(candidate.rangePct || 0) * 100).toFixed(2) + "%</span> <span class='pill'>best " + escapeHtml(candidate.bestBacktestStrategy || "none") + "</span> <span class='pill'>context " + escapeHtml(candidate.contextCrowding) + "</span> <span class='pill'>fund " + escapeHtml(candidate.fundamentalPosture || "n/a") + (candidate.fundamentalScore === null ? "" : " " + candidate.fundamentalScore + "/100") + "</span></p>" +
            "<p>Grid replay net " + (candidate.gridBacktestNetPnlPct === null ? "n/a" : Number(candidate.gridBacktestNetPnlPct || 0).toFixed(2) + "%") +
            " · win " + (candidate.gridBacktestWinRate === null ? "n/a" : pct(candidate.gridBacktestWinRate)) +
            " · PF " + (candidate.gridBacktestProfitFactor === null ? "n/a" : Number(candidate.gridBacktestProfitFactor || 0).toFixed(2)) +
            " · allocated " + Number(candidate.allocatedCapitalQuote || 0).toFixed(2) + " USDT</p>" +
            (blockers.length ? "<p><b>Blockers:</b> " + blockers.map(escapeHtml).join(" | ") + "</p>" : "") +
            (notes.length ? "<ul>" + notes.slice(0, 4).map((note) => "<li>" + escapeHtml(note) + "</li>").join("") + "</ul>" : "") +
          "</article>";
        }).join("");
    }

    function renderMarketContext(data) {
      const stamp = data.generatedAtMs ? new Date(data.generatedAtMs).toLocaleTimeString() : "";
      contextEl.innerHTML =
        "<div class='model-meta'><span>funding + basis snapshot " + escapeHtml(stamp) + "</span></div>" +
        data.assessments.map((assessment) => {
          const context = (data.contexts ?? []).find((item) => item.symbol === assessment.symbol) || {};
          const biasClass = assessment.bias === "long" ? "ok" : assessment.bias === "short" ? "pending" : "info";
          return "<article class='entry'>" +
            "<div class='entry-head'><strong>" + escapeHtml(assessment.symbol) + " context</strong><span class='pill " + biasClass + "'>" + escapeHtml(assessment.bias) + " bias · " + assessment.score + "/100</span></div>" +
            "<p><span class='pill'>" + escapeHtml(assessment.crowding) + "</span> <span class='pill'>funding " + tinyPct(assessment.fundingRate) + "</span> <span class='pill'>basis " + tinyPct(assessment.basisPct) + "</span> <span class='pill'>24h " + tinyPct(assessment.riseFallRate) + "</span></p>" +
            "<p>Price " + Number(context.lastPrice || 0).toFixed(assessment.symbol === "SOLUSDT" ? 4 : 2) +
            " · fair/index " + Number(context.fairPrice || 0).toFixed(assessment.symbol === "SOLUSDT" ? 4 : 2) + " / " + Number(context.indexPrice || 0).toFixed(assessment.symbol === "SOLUSDT" ? 4 : 2) +
            " · holdVol " + Number(assessment.holdVol || 0).toLocaleString() + " · amount24 " + Number(assessment.amount24 || 0).toLocaleString() + "</p>" +
            "<ul>" + assessment.notes.map((note) => "<li>" + escapeHtml(note) + "</li>").join("") + "</ul>" +
          "</article>";
        }).join("");
    }

    function renderFundamentals(data) {
      const stamp = data.generatedAtMs ? new Date(data.generatedAtMs).toLocaleTimeString() : "";
      fundamentalsEl.innerHTML =
        "<div class='model-meta'><span>CoinGecko liquidity + market cap pulse " + escapeHtml(stamp) + " · confirmation/veto only</span></div>" +
        (data.assessments ?? []).map((item) => {
          const postureClass = item.posture === "supportive" ? "ok" : item.posture === "caution" ? "pending" : "block";
          const notes = item.notes ?? [];
          return "<article class='entry'>" +
            "<div class='entry-head'><strong>" + escapeHtml(item.symbol) + " fundamentals</strong><span class='pill " + postureClass + "'>" + escapeHtml(item.posture) + " · " + item.score + "/100</span></div>" +
            "<p><span class='pill'>price $" + Number(item.priceUsd || 0).toLocaleString() + "</span> <span class='pill'>24h " + Number(item.change24hPct || 0).toFixed(2) + "%</span> <span class='pill'>vol/mcap " + (Number(item.volumeToMarketCap || 0) * 100).toFixed(2) + "%</span></p>" +
            "<p>Market cap $" + Number(item.marketCapUsd || 0).toLocaleString() + " · 24h volume $" + Number(item.volume24hUsd || 0).toLocaleString() + "</p>" +
            (notes.length ? "<ul>" + notes.slice(0, 4).map((note) => "<li>" + escapeHtml(note) + "</li>").join("") + "</ul>" : "") +
          "</article>";
        }).join("");
    }

    function renderAccountStatus(status) {
      if (!status.available) {
        accountEl.innerHTML =
          "<article class='entry'><div class='entry-head'><strong>Futures account</strong><span class='pill pending'>read-only unavailable</span></div>" +
          "<p>" + escapeHtml(status.message || "Missing futures credentials.") + "</p>" +
          "<p><span class='pill'>safe mode</span> Signals, backtests, setup board, and journal still work.</p></article>";
        return;
      }
      const s = status.snapshot;
      const positions = s.positions || [];
      accountEl.innerHTML =
        "<article class='entry'>" +
          "<div class='entry-head'><strong>USDT margin</strong><span class='pill ok'>connected</span></div>" +
          "<div class='metric-row'>" +
            "<div class='metric'><small>Total</small><b>" + Number(s.usdt.total || 0).toFixed(2) + "</b></div>" +
            "<div class='metric'><small>Free</small><b>" + Number(s.usdt.free || 0).toFixed(2) + "</b></div>" +
            "<div class='metric'><small>Used</small><b>" + Number(s.usdt.used || 0).toFixed(2) + "</b></div>" +
          "</div>" +
          "<p>Fetched " + new Date(s.fetchedAtMs || Date.now()).toLocaleTimeString() + "</p>" +
        "</article>" +
        (positions.length
          ? positions.map((p) =>
              "<article class='entry'>" +
                "<div class='entry-head'><strong>" + escapeHtml(p.symbol) + " " + escapeHtml(String(p.side).toUpperCase()) + "</strong><span class='pill " + (Number(p.unrealizedPnl || 0) >= 0 ? "ok" : "block") + "'>" + money(p.unrealizedPnl) + "</span></div>" +
                "<p><span class='pill'>" + Number(p.leverage || 0).toFixed(0) + "x</span> <span class='pill'>notional " + Number(p.notionalQuote || 0).toFixed(2) + "</span> <span class='pill'>entry " + Number(p.entryPrice || 0).toFixed(4) + "</span> <span class='pill'>mark " + Number(p.markPrice || 0).toFixed(4) + "</span></p>" +
                (p.liquidationPrice ? "<p><span class='pill block'>liq " + Number(p.liquidationPrice || 0).toFixed(4) + "</span> <span class='pill'>" + escapeHtml(p.marginMode || "margin") + "</span></p>" : "") +
              "</article>"
            ).join("")
          : "<article class='entry'><div class='entry-head'><strong>Open positions</strong><span class='pill ok'>flat</span></div><p>No BTC/ETH/SOL futures positions reported.</p></article>");
    }

    function renderSetupBoard(data) {
      const stamp = data.generatedAtMs ? new Date(data.generatedAtMs).toLocaleTimeString() : "";
      setupBoardEl.innerHTML =
        "<div class='model-meta'><span>setup board " + escapeHtml(stamp) + " · " + data.limit + " candles</span></div>" +
        data.rows.map((row) => {
          const actionClass = row.action === "wait" ? "block" : row.action === "consider_long" ? "ok" : "pending";
          const blockers = row.blockers ?? [];
          const notes = row.notes ?? [];
          return "<article class='entry'>" +
            "<div class='entry-head'><strong>" + escapeHtml(row.symbol) + " " + escapeHtml(row.action.replace("_", " ").toUpperCase()) + "</strong><span class='pill " + actionClass + "'>" + row.score + "/100</span></div>" +
            "<p><span class='pill'>" + escapeHtml(row.primaryDirection) + "</span> <span class='pill'>" + escapeHtml(row.primaryStrategy || "no setup") + "</span> <span class='pill'>best " + escapeHtml(row.bestBacktestStrategy || "none") + "</span> <span class='pill'>context " + escapeHtml(row.contextBias) + " " + row.contextScore + "/100</span> <span class='pill'>fund " + escapeHtml(row.fundamentalPosture || "n/a") + (row.fundamentalScore === null ? "" : " " + row.fundamentalScore + "/100") + "</span> <span class='pill'>grid " + row.gridLevelCount + " levels</span> <span class='pill'>style " + row.styleConflictCount + "</span></p>" +
            (row.backtestNetPnlPct !== null ? "<p>Recent best backtest net: " + Number(row.backtestNetPnlPct || 0).toFixed(2) + "%</p>" : "<p>Recent best backtest net: no positive edge</p>") +
            (blockers.length ? "<p><b>Blockers:</b> " + blockers.map(escapeHtml).join(" | ") + "</p>" : "") +
            (notes.length ? "<ul>" + notes.slice(0, 4).map((note) => "<li>" + escapeHtml(note) + "</li>").join("") + "</ul>" : "") +
          "</article>";
        }).join("");
    }

    async function loadJournal() {
      const res = await fetch("/api/journal");
      const body = await res.json();
      telegramEnabled = Boolean(body.telegramEnabled);
      telegramStatusEl.className = "telegram-pill " + (telegramEnabled ? "" : "off");
      telegramStatusEl.textContent = telegramEnabled ? "telegram on" : "telegram off";
      renderJournal(body.entries ?? []);
    }

    async function loadSettings() {
      const res = await fetch("/api/settings");
      const body = await res.json();
      if (res.ok) applySettings(body);
    }

    async function saveSettings() {
      settingsStatusEl.textContent = "saving...";
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settingsPayload()),
      });
      const body = await res.json();
      if (!res.ok) {
        settingsStatusEl.textContent = "settings failed";
        return;
      }
      applySettings(body);
    }

    async function loadFeedback() {
      const res = await fetch("/api/feedback");
      const body = await res.json();
      renderFeedback(body.feedback ?? []);
    }

    async function recordFeedback(action, journalId, note) {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, journalId, note }),
      });
      const body = await res.json();
      if (res.ok) {
        renderFeedback(body.recent ?? []);
      }
    }

    async function loadHistoryAnalysis() {
      const res = await fetch("/api/history-analysis");
      const body = await res.json();
      renderHistoryAnalysis(body);
    }

    async function runHistoryIngest() {
      historyEl.innerHTML = "<div class='empty'>Importing recent BTC/ETH/SOL MEXC futures fills. This is read-only and may take a moment...</div>";
      const res = await fetch("/api/history-ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ days: 60 }),
      });
      const body = await res.json();
      if (!res.ok) {
        historyEl.innerHTML =
          "<div class='empty'>History ingest failed: " + escapeHtml(body.message || "unknown error") +
          "<br><br>Check WCM entries <code>mexc-futures-access</code> and <code>mexc-futures-secret</code>, then retry.</div>";
        return;
      }
      const summary = (body.reports ?? []).map((report) =>
        escapeHtml(report.symbol) + ": " + Number(report.insertedOrUpdated || 0) + " fills"
      ).join(" · ");
      historyEl.innerHTML = "<div class='empty'>History import complete: " + summary + ". Rebuilding coaching view...</div>";
      await loadHistoryAnalysis();
    }

    async function loadMarketContext() {
      const res = await fetch("/api/market-context");
      const body = await res.json();
      if (!res.ok) {
        contextEl.innerHTML = "<div class='empty'>Market context failed: " + escapeHtml(body.message) + "</div>";
        return;
      }
      renderMarketContext(body);
    }

    async function loadFundamentals() {
      const res = await fetch("/api/fundamentals");
      const body = await res.json();
      if (!res.ok) {
        fundamentalsEl.innerHTML = "<div class='empty'>Fundamentals failed: " + escapeHtml(body.message) + "</div>";
        return;
      }
      renderFundamentals(body);
    }

    async function loadAccountStatus() {
      const res = await fetch("/api/account-status");
      const body = await res.json();
      if (!res.ok) {
        accountEl.innerHTML = "<div class='empty'>Account status failed: " + escapeHtml(body.message) + "</div>";
        return;
      }
      renderAccountStatus(body);
    }

    async function loadStrategyEffectiveness() {
      const res = await fetch("/api/strategy-effectiveness");
      const body = await res.json();
      if (!res.ok) {
        effectivenessEl.innerHTML = "<div class='empty'>Strategy memory failed: " + escapeHtml(body.message) + "</div>";
        return;
      }
      renderStrategyEffectiveness(body);
    }

    async function loadGridCandidates() {
      const leverage = encodeURIComponent(formPayload().leverage || 20);
      const res = await fetch("/api/grid-candidates?limit=160&leverage=" + leverage);
      const body = await res.json();
      if (!res.ok) {
        gridCandidatesEl.innerHTML = "<div class='empty'>Grid candidate scoring failed: " + escapeHtml(body.message) + "</div>";
        return;
      }
      renderGridCandidates(body);
    }

    async function loadSetupBoard() {
      const payload = formPayload();
      const margin = encodeURIComponent(payload.marginQuote || 25);
      const leverage = encodeURIComponent(payload.leverage || 20);
      const res = await fetch("/api/setup-board?limit=160&margin=" + margin + "&leverage=" + leverage);
      const body = await res.json();
      if (!res.ok) {
        setupBoardEl.innerHTML = "<div class='empty'>Setup board failed: " + escapeHtml(body.message) + "</div>";
        return;
      }
      renderSetupBoard(body);
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

    document.querySelectorAll("[data-capital]").forEach((button) => {
      button.addEventListener("click", () => {
        const margin = button.dataset.capital;
        const marginEl = form.elements.namedItem("marginQuote");
        if (marginEl && margin) marginEl.value = margin;
      });
    });

    document.querySelectorAll("[data-mode-preset]").forEach((button) => {
      button.addEventListener("click", () => {
        applyModePreset(button.dataset.modePreset || "medium");
      });
    });

    document.querySelectorAll("[data-why]").forEach((button) => {
      button.addEventListener("click", () => {
        applyQuickReason(button.dataset.why || "");
      });
    });

    saveSettingsButton.addEventListener("click", () => {
      saveSettings().catch((err) => {
        settingsStatusEl.textContent = "settings failed: " + String(err);
      });
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

    runBacktestButton.addEventListener("click", async () => {
      backtestEl.innerHTML = "<div class='empty'>Replaying BTC/ETH/SOL MEXC futures candles...</div>";
      try {
        const res = await fetch("/api/backtest?limit=320");
        const body = await res.json();
        if (!res.ok) {
          backtestEl.innerHTML = "<div class='empty'>Backtest failed: " + escapeHtml(body.message) + "</div>";
          return;
        }
        renderBacktest(body);
        loadStrategyEffectiveness().catch((err) => {
          effectivenessEl.innerHTML = "<div class='empty'>Strategy memory failed: " + escapeHtml(String(err)) + "</div>";
        });
      } catch (err) {
        backtestEl.innerHTML = "<div class='empty'>Backtest failed: " + escapeHtml(String(err)) + "</div>";
      }
    });

    refreshEffectivenessButton.addEventListener("click", () => {
      effectivenessEl.innerHTML = "<div class='empty'>Refreshing saved strategy-effectiveness memory...</div>";
      loadStrategyEffectiveness().catch((err) => {
        effectivenessEl.innerHTML = "<div class='empty'>Strategy memory failed: " + escapeHtml(String(err)) + "</div>";
      });
    });

    buildGridButton.addEventListener("click", async () => {
      gridEl.innerHTML = "<div class='empty'>Building BTC/ETH/SOL futures grid plan from live MEXC candles...</div>";
      try {
        const leverage = encodeURIComponent(formPayload().leverage || 20);
        const res = await fetch("/api/grid-plan?limit=120&leverage=" + leverage);
        const body = await res.json();
        if (!res.ok) {
          gridEl.innerHTML = "<div class='empty'>Grid planner failed: " + escapeHtml(body.message) + "</div>";
          return;
        }
        renderGridPlan(body);
      } catch (err) {
        gridEl.innerHTML = "<div class='empty'>Grid planner failed: " + escapeHtml(String(err)) + "</div>";
      }
    });

    scoreGridButton.addEventListener("click", () => {
      gridCandidatesEl.innerHTML = "<div class='empty'>Scoring BTC/ETH/SOL grid candidates from replay edge, grid levels, and futures context...</div>";
      loadGridCandidates().catch((err) => {
        gridCandidatesEl.innerHTML = "<div class='empty'>Grid candidate scoring failed: " + escapeHtml(String(err)) + "</div>";
      });
    });

    refreshContextButton.addEventListener("click", () => {
      contextEl.innerHTML = "<div class='empty'>Refreshing MEXC futures context...</div>";
      loadMarketContext().catch((err) => {
        contextEl.innerHTML = "<div class='empty'>Market context failed: " + escapeHtml(String(err)) + "</div>";
      });
    });

    refreshFundamentalsButton.addEventListener("click", () => {
      fundamentalsEl.innerHTML = "<div class='empty'>Refreshing BTC/ETH/SOL fundamentals...</div>";
      loadFundamentals().catch((err) => {
        fundamentalsEl.innerHTML = "<div class='empty'>Fundamentals failed: " + escapeHtml(String(err)) + "</div>";
      });
    });

    refreshSetupBoardButton.addEventListener("click", () => {
      setupBoardEl.innerHTML = "<div class='empty'>Scoring setup board from live candles, backtests, context, and style history...</div>";
      loadSetupBoard().catch((err) => {
        setupBoardEl.innerHTML = "<div class='empty'>Setup board failed: " + escapeHtml(String(err)) + "</div>";
      });
    });

    refreshAccountButton.addEventListener("click", () => {
      accountEl.innerHTML = "<div class='empty'>Refreshing read-only futures account status...</div>";
      loadAccountStatus().catch((err) => {
        accountEl.innerHTML = "<div class='empty'>Account status failed: " + escapeHtml(String(err)) + "</div>";
      });
    });

    importHistoryButton.addEventListener("click", () => {
      runHistoryIngest().catch((err) => {
        historyEl.innerHTML = "<div class='empty'>History ingest failed: " + escapeHtml(String(err)) + "</div>";
      });
    });

    loadJournal().catch((err) => {
      journalEl.innerHTML = "<div class='empty'>Journal load failed: " + String(err) + "</div>";
    });
    loadSettings().catch((err) => {
      settingsStatusEl.textContent = "settings failed: " + String(err);
    });
    loadFeedback().catch((err) => {
      feedbackEl.innerHTML = "<div class='empty'>Feedback load failed: " + escapeHtml(String(err)) + "</div>";
    });
    loadAccountStatus().catch((err) => {
      accountEl.innerHTML = "<div class='empty'>Account status failed: " + escapeHtml(String(err)) + "</div>";
    });
    loadStrategyEffectiveness().catch((err) => {
      effectivenessEl.innerHTML = "<div class='empty'>Strategy memory failed: " + escapeHtml(String(err)) + "</div>";
    });
    loadGridCandidates().catch((err) => {
      gridCandidatesEl.innerHTML = "<div class='empty'>Grid candidate scoring failed: " + escapeHtml(String(err)) + "</div>";
    });

    loadHistoryAnalysis().catch((err) => {
      historyEl.innerHTML = "<div class='empty'>History analysis failed: " + escapeHtml(String(err)) + "</div>";
    });
    loadMarketContext().catch((err) => {
      contextEl.innerHTML = "<div class='empty'>Market context failed: " + escapeHtml(String(err)) + "</div>";
    });
    loadFundamentals().catch((err) => {
      fundamentalsEl.innerHTML = "<div class='empty'>Fundamentals failed: " + escapeHtml(String(err)) + "</div>";
    });
    loadSetupBoard().catch((err) => {
      setupBoardEl.innerHTML = "<div class='empty'>Setup board failed: " + escapeHtml(String(err)) + "</div>";
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
      process.stdout.write(`Telegram approvals enabled for chat ${dispatcher.chatId}\n`);
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
