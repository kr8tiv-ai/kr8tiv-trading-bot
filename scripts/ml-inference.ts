import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * ML inference scaffold for the cockpit (#9 from the suggestion list).
 *
 * Layout:
 *   models/
 *     ├── btcusdt-15m.onnx        — XGBoost classifier exported via skl2onnx
 *     ├── btcusdt-15m.meta.json   — { trainedAtMs, samples, winRate, ... }
 *     ├── ethusdt-15m.onnx
 *     └── solusdt-15m.onnx
 *
 * Training pipeline lives in `ml/` (Python) — see ml/README.md.
 *
 * Inference uses `onnxruntime-node` via dynamic import so the package is
 * **optional**. If it's not installed (default), the cockpit shows
 * "ML disabled — pnpm add -w onnxruntime-node + run pnpm ml:train".
 *
 * Once a model is loaded, `predictMlConfidence(features)` returns a 0..1
 * blended confidence the cockpit shows alongside the deterministic strategy
 * score so Matt can ensemble the two before approving.
 */
const MODEL_DIR = join(process.cwd(), "models");

export type MlModelMeta = {
  readonly symbol: string;
  readonly trainedAtMs: number;
  readonly samples: number;
  readonly winRate: number;
  readonly featureNames: string[];
  readonly notes?: string;
};

export type MlInferenceStatus =
  | { readonly available: false; readonly reason: string }
  | {
      readonly available: true;
      readonly models: ReadonlyArray<{
        readonly symbol: string;
        readonly modelPath: string;
        readonly meta: MlModelMeta | null;
      }>;
    };

export type MlPrediction = {
  readonly symbol: string;
  readonly confidence: number; // 0..1
  readonly featureCount: number;
  readonly meta: MlModelMeta | null;
};

const SUPPORTED_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;
type SupportedSymbol = (typeof SUPPORTED_SYMBOLS)[number];

function modelPath(symbol: SupportedSymbol): string {
  return join(MODEL_DIR, `${symbol.toLowerCase()}-15m.onnx`);
}

function metaPath(symbol: SupportedSymbol): string {
  return join(MODEL_DIR, `${symbol.toLowerCase()}-15m.meta.json`);
}

function readMeta(symbol: SupportedSymbol): MlModelMeta | null {
  const path = metaPath(symbol);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as MlModelMeta;
  } catch {
    return null;
  }
}

export function getMlInferenceStatus(): MlInferenceStatus {
  if (!existsSync(MODEL_DIR)) {
    return {
      available: false,
      reason: "no models/ directory yet — run pnpm ml:train after pnpm history:ingest --days 60",
    };
  }
  const found = SUPPORTED_SYMBOLS.flatMap((symbol) => {
    const path = modelPath(symbol);
    if (!existsSync(path)) return [];
    return [
      {
        symbol,
        modelPath: path,
        meta: readMeta(symbol),
      },
    ];
  });
  if (found.length === 0) {
    return {
      available: false,
      reason: "models/ exists but no *.onnx files — run `pnpm ml:train` to produce them",
    };
  }
  return { available: true, models: found };
}

/**
 * Lazy-load onnxruntime-node. Returns null if the package isn't installed,
 * so the cockpit can degrade gracefully.
 */
async function loadRuntime(): Promise<{
  // biome-ignore lint/suspicious/noExplicitAny: onnxruntime-node has its own types we don't depend on at compile time
  InferenceSession: any;
  // biome-ignore lint/suspicious/noExplicitAny: same as above
  Tensor: any;
} | null> {
  try {
    // @ts-expect-error optional peer — only loaded when Matt installs it
    const ort = (await import("onnxruntime-node")) as unknown as {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import payload
      InferenceSession: any;
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import payload
      Tensor: any;
    };
    return ort;
  } catch {
    return null;
  }
}

const sessionCache = new Map<string, unknown>();

export async function predictMlConfidence(args: {
  readonly symbol: SupportedSymbol;
  readonly features: number[];
}): Promise<MlPrediction | null> {
  const status = getMlInferenceStatus();
  if (!status.available) return null;
  const entry = status.models.find((m) => m.symbol === args.symbol);
  if (!entry) return null;

  const ort = await loadRuntime();
  if (ort === null) return null;

  let session = sessionCache.get(entry.modelPath);
  if (!session) {
    session = await ort.InferenceSession.create(entry.modelPath);
    sessionCache.set(entry.modelPath, session);
  }
  const tensor = new ort.Tensor("float32", Float32Array.from(args.features), [
    1,
    args.features.length,
  ]);
  // XGBoost-via-ONNX sklearn-pipeline-style models expose either a probability
  // tensor under "probabilities" or a single float under "label". We try both.
  // biome-ignore lint/suspicious/noExplicitAny: ONNX session run output is dynamic
  const output = (await (session as any).run({ input: tensor })) as Record<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: tensor output
    any
  >;
  const probsTensor = output.probabilities ?? output.output_probability ?? null;
  let confidence: number;
  if (probsTensor && Array.isArray(probsTensor.data)) {
    // Two-class output — take P(positive class).
    const data = probsTensor.data as number[];
    confidence = clamp01(Number(data[1] ?? data[0] ?? 0));
  } else {
    const labelTensor = Object.values(output)[0];
    if (
      labelTensor &&
      typeof labelTensor === "object" &&
      "data" in labelTensor &&
      Array.isArray((labelTensor as { data: number[] }).data)
    ) {
      const v = Number((labelTensor as { data: number[] }).data[0] ?? 0);
      confidence = clamp01(v);
    } else {
      confidence = 0.5;
    }
  }

  return {
    symbol: args.symbol,
    confidence,
    featureCount: args.features.length,
    meta: entry.meta,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

/**
 * Stat the model file so the cockpit can show how stale it is (e.g. "trained
 * 8 days ago" → suggest a retrain).
 */
export function modelAgeDays(symbol: SupportedSymbol): number | null {
  const path = modelPath(symbol);
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  return Math.round((Date.now() - stat.mtimeMs) / (24 * 60 * 60 * 1000));
}
