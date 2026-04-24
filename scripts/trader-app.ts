import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { reviewTradePlan } from "@kr8tiv/accountability";
import { closeDatabase, openDatabase } from "@kr8tiv/db";
import {
  listRecentTradeJournalEntries,
  saveTradeJournalEntry,
  type TradeJournalEntry,
} from "@kr8tiv/executor";
import {
  AccountableTradePlanSchema,
  type AccountabilityCheck,
  type AccountableTradePlan,
} from "@kr8tiv/shared-schemas";

const HOST = process.env.TRADER_APP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.TRADER_APP_PORT ?? 3020);
const BODY_LIMIT_BYTES = 64 * 1024;

type ApiReviewResponse = {
  plan: AccountableTradePlan;
  review: AccountabilityCheck;
  savedId: number | null;
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

function withDb<T>(fn: (db: ReturnType<typeof openDatabase>) => T): T {
  const db = openDatabase();
  try {
    return fn(db);
  } finally {
    closeDatabase(db);
  }
}

function listJournal(): TradeJournalEntry[] {
  return withDb((db) => listRecentTradeJournalEntries(db, 50));
}

function handleReview(body: unknown, save: boolean): ApiReviewResponse {
  const plan = AccountableTradePlanSchema.parse({
    ...(typeof body === "object" && body !== null ? body : {}),
    market: "mexc-futures",
  });
  const review = reviewTradePlan(plan);
  const savedId = save
    ? withDb((db) => saveTradeJournalEntry(db, plan, review))
    : null;
  return { plan, review, savedId };
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/") {
    html(res, renderApp());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    json(res, 200, { ok: true, app: "kr8tiv-trader-cockpit" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/journal") {
    json(res, 200, { entries: listJournal() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/review") {
    try {
      const payload = await readBody(req);
      json(res, 200, handleReview(payload, url.searchParams.get("save") === "1"));
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
    .entry p { margin: 8px 0 0; color: var(--muted); line-height: 1.45; font-size: 13px; }
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
        <p class="lede">BTC, ETH, and SOL futures. Longs, shorts, scalps, and longer plays. The cockpit checks leverage mode, stop, target, risk/reward, and your written reason before anything becomes a journaled plan.</p>
      </div>
      <aside class="plate status">
        <h2>Risk modes</h2>
        <div class="mode-grid">
          <div class="mode"><strong>Sniper</strong><span>30x-100x, small margin, tight invalidation, fast review. Built for risky snipes without letting size drift.</span></div>
          <div class="mode"><strong>Core</strong><span>Higher capital, 30x max, cleaner thesis, better R/R. Built for trades that deserve patience.</span></div>
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
            <button type="submit" data-save="1" class="secondary">Review + save journal</button>
          </div>
        </form>
        <div id="verdict" class="verdict">
          <h3>Waiting for a plan</h3>
          <p class="lede">Fill the trade, then make the bot argue with you before you size it.</p>
        </div>
      </div>

      <aside class="plate card">
        <h2>Recent journal</h2>
        <div id="journal" class="journal"><div class="empty">Loading journal...</div></div>
      </aside>
    </section>
  </main>

  <script>
    const form = document.querySelector("#trade-form");
    const verdictEl = document.querySelector("#verdict");
    const journalEl = document.querySelector("#journal");
    let saveNext = false;

    function num(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
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

    function issueList(label, items) {
      if (!items.length) return "";
      return "<strong>" + label + "</strong><ul>" + items.map((i) => "<li>" + i.message + "</li>").join("") + "</ul>";
    }

    function renderVerdict(result) {
      const r = result.review;
      verdictEl.className = "verdict " + (r.okToProceed ? "ok" : "block");
      verdictEl.innerHTML =
        "<h3>" + (r.okToProceed ? "OK to plan" : "Blocked") + "</h3>" +
        "<div class='metric-row'>" +
          "<div class='metric'><small>Max loss</small><b>" + r.estimatedLossQuote.toFixed(2) + " USDT</b></div>" +
          "<div class='metric'><small>Reward</small><b>" + r.estimatedRewardQuote.toFixed(2) + " USDT</b></div>" +
          "<div class='metric'><small>R multiple</small><b>" + r.riskRewardRatio.toFixed(2) + "R</b></div>" +
        "</div>" +
        issueList("Blocks", r.blocks) +
        issueList("Warnings", r.warnings) +
        (result.savedId ? "<p><span class='pill ok'>saved trade_journal#" + result.savedId + "</span></p>" : "");
    }

    function renderJournal(entries) {
      if (!entries.length) {
        journalEl.innerHTML = "<div class='empty'>No journal entries yet. Save one clean plan and the receipts start here.</div>";
        return;
      }
      journalEl.innerHTML = entries.map((e) => {
        const when = new Date(e.createdAtMs).toLocaleString();
        return "<article class='entry'>" +
          "<div class='entry-head'><strong>" + e.symbol + " " + e.direction.toUpperCase() + " " + e.leverage + "x</strong>" +
          "<span class='pill " + (e.okToProceed ? "ok" : "block") + "'>" + (e.okToProceed ? "OK" : "BLOCKED") + "</span></div>" +
          "<span class='pill'>" + e.riskMode + " / " + e.horizon + " / " + when + "</span>" +
          "<p><b>Why:</b> " + e.thesis + "</p>" +
          "<p><b>Note:</b> " + e.journalNote + "</p>" +
          "<p>Risk " + e.estimatedLossQuote.toFixed(2) + " USDT -> reward " + e.estimatedRewardQuote.toFixed(2) + " USDT (" + e.riskRewardRatio.toFixed(2) + "R)</p>" +
        "</article>";
      }).join("");
    }

    async function loadJournal() {
      const res = await fetch("/api/journal");
      const body = await res.json();
      renderJournal(body.entries ?? []);
    }

    form.addEventListener("click", (event) => {
      if (event.target instanceof HTMLButtonElement) {
        saveNext = event.target.dataset.save === "1";
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
        verdictEl.innerHTML = "<h3>Invalid plan</h3><p>" + body.message + "</p>";
        return;
      }
      renderVerdict(body);
      await loadJournal();
    });

    loadJournal().catch((err) => {
      journalEl.innerHTML = "<div class='empty'>Journal load failed: " + String(err) + "</div>";
    });
  </script>
</body>
</html>`;
}

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    json(res, 500, {
      error: "internal_error",
      message: err instanceof Error ? err.message : String(err),
    });
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Trader cockpit listening at http://${HOST}:${PORT}\n`);
});
