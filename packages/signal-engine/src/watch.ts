import {
  SignalWatchEventSchema,
  type MarketScan,
  type SignalWatchEvent,
  type TradeIdea,
} from "@kr8tiv/shared-schemas";

const CONFIDENCE_DELTA_THRESHOLD = 0.08;
const ENTRY_DRIFT_THRESHOLD = 0.003;

export function ideaKey(idea: TradeIdea): string {
  return `${idea.direction}:${idea.horizon}`;
}

function makeEvent(args: Omit<SignalWatchEvent, "eventId">): SignalWatchEvent {
  return SignalWatchEventSchema.parse({
    ...args,
    eventId:
      args.eventType === "regime-changed"
        ? `${args.symbol}:${args.eventType}:${args.occurredAtMs}`
        : `${args.symbol}:${args.ideaKey ?? "none"}:${args.eventType}:${args.occurredAtMs}`,
  });
}

function openIdeaEvent(
  scan: MarketScan,
  idea: TradeIdea,
  occurredAtMs: number,
): SignalWatchEvent {
  return makeEvent({
    symbol: scan.symbol,
    eventType: "idea-opened",
    occurredAtMs,
    regime: scan.regime,
    currentPrice: scan.currentPrice,
    title: `new ${idea.horizon} ${idea.direction} setup`,
    message: idea.thesis,
    ideaKey: ideaKey(idea),
    direction: idea.direction,
    horizon: idea.horizon,
    confidence: idea.confidence,
  });
}

function closeIdeaEvent(
  scan: MarketScan,
  previousIdea: TradeIdea,
  occurredAtMs: number,
): SignalWatchEvent {
  return makeEvent({
    symbol: scan.symbol,
    eventType: "idea-closed",
    occurredAtMs,
    regime: scan.regime,
    currentPrice: scan.currentPrice,
    title: `${previousIdea.horizon} ${previousIdea.direction} setup closed`,
    message: `the prior ${previousIdea.horizon} ${previousIdea.direction} idea is no longer active`,
    ideaKey: ideaKey(previousIdea),
    direction: previousIdea.direction,
    horizon: previousIdea.horizon,
    previousConfidence: previousIdea.confidence,
  });
}

function updatedIdeaEvent(
  scan: MarketScan,
  previousIdea: TradeIdea,
  idea: TradeIdea,
  occurredAtMs: number,
): SignalWatchEvent {
  const strengthened = idea.confidence >= previousIdea.confidence;
  return makeEvent({
    symbol: scan.symbol,
    eventType: "idea-updated",
    occurredAtMs,
    regime: scan.regime,
    currentPrice: scan.currentPrice,
    title: `${idea.horizon} ${idea.direction} setup ${strengthened ? "strengthened" : "softened"}`,
    message: idea.thesis,
    ideaKey: ideaKey(idea),
    direction: idea.direction,
    horizon: idea.horizon,
    confidence: idea.confidence,
    previousConfidence: previousIdea.confidence,
  });
}

function regimeChangedEvent(
  previous: MarketScan,
  current: MarketScan,
  occurredAtMs: number,
): SignalWatchEvent {
  return makeEvent({
    symbol: current.symbol,
    eventType: "regime-changed",
    occurredAtMs,
    regime: current.regime,
    currentPrice: current.currentPrice,
    previousRegime: previous.regime,
    title: "regime changed",
    message: `higher timeframe shifted from ${previous.regime} to ${current.regime}`,
  });
}

function materiallyChanged(previousIdea: TradeIdea, idea: TradeIdea): boolean {
  const confidenceDelta = Math.abs(idea.confidence - previousIdea.confidence);
  const entryDrift =
    Math.abs(idea.entryPrice - previousIdea.entryPrice) /
    Math.max(previousIdea.entryPrice, Number.EPSILON);
  return (
    confidenceDelta >= CONFIDENCE_DELTA_THRESHOLD ||
    entryDrift >= ENTRY_DRIFT_THRESHOLD ||
    idea.thesis !== previousIdea.thesis
  );
}

export function diffScans(
  previous: MarketScan | null,
  current: MarketScan,
  occurredAtMs = Date.now(),
): SignalWatchEvent[] {
  const events: SignalWatchEvent[] = [];

  if (previous === null) {
    for (const idea of current.ideas) {
      events.push(openIdeaEvent(current, idea, occurredAtMs));
    }
    return events;
  }

  if (previous.regime !== current.regime) {
    events.push(regimeChangedEvent(previous, current, occurredAtMs));
  }

  const previousIdeas = new Map(
    previous.ideas.map((idea) => [ideaKey(idea), idea] as const),
  );
  const currentIdeas = new Map(
    current.ideas.map((idea) => [ideaKey(idea), idea] as const),
  );

  for (const [key, idea] of currentIdeas) {
    const previousIdea = previousIdeas.get(key);
    if (!previousIdea) {
      events.push(openIdeaEvent(current, idea, occurredAtMs));
      continue;
    }
    if (materiallyChanged(previousIdea, idea)) {
      events.push(updatedIdeaEvent(current, previousIdea, idea, occurredAtMs));
    }
  }

  for (const [key, previousIdea] of previousIdeas) {
    if (!currentIdeas.has(key)) {
      events.push(closeIdeaEvent(current, previousIdea, occurredAtMs));
    }
  }

  return events;
}

