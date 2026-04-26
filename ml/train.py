"""Train an XGBoost classifier per symbol from local SQLite trade history +
cached candles, export to ONNX so the Node cockpit can serve it via
`scripts/ml-inference.ts`.

Run:
    python train.py --symbol BTCUSDT --candles ../data/cache/btc-15m.json \
                    --trades ../data/core.sqlite --out-dir ../models

This is a *scaffold* — read it end-to-end before pointing at real data and
adjust the feature engineering for your trading style. The defaults are sane
but not opinionated.

Features (per 15m candle close):
    - ret_1, ret_5, ret_20      — returns over 1/5/20 candles
    - rsi_14                     — relative strength index
    - macd_hist                  — MACD histogram
    - atr_14_pct                 — ATR / close
    - vol_ratio_20               — volume / 20-period MA volume
    - hour_utc                   — categorical 0-23 (one-hot)

Label:
    - 1 if next-candle close moved at least +0.3% (LONG winner)
    - 0 otherwise

Output:
    - <out-dir>/<symbol-lower>-15m.onnx
    - <out-dir>/<symbol-lower>-15m.meta.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

try:
    from xgboost import XGBClassifier
except ImportError:  # pragma: no cover
    sys.stderr.write("xgboost not installed — pip install -r requirements.txt\n")
    sys.exit(1)

try:
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType
except ImportError:  # pragma: no cover
    sys.stderr.write("skl2onnx not installed — pip install -r requirements.txt\n")
    sys.exit(1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train per-symbol XGBoost classifier")
    parser.add_argument("--symbol", required=True, help="BTCUSDT | ETHUSDT | SOLUSDT")
    parser.add_argument(
        "--candles",
        required=True,
        help="JSON file with [{openTimeMs, open, high, low, close, volume}, ...]",
    )
    parser.add_argument(
        "--trades",
        required=False,
        help="(optional) SQLite path; not used by the scaffold but reserved for "
        "label engineering against your actual entries/exits.",
    )
    parser.add_argument(
        "--out-dir",
        default="../models",
        help="Where to write <symbol-lower>-15m.onnx + meta.json",
    )
    parser.add_argument(
        "--target-move-pct",
        type=float,
        default=0.003,
        help="Label threshold: 1 if next-candle return >= this. Default 0.3%%.",
    )
    parser.add_argument(
        "--min-samples",
        type=int,
        default=200,
        help="Refuse to train below this candle count (model won't generalize).",
    )
    return parser.parse_args()


def load_candles(path: str) -> pd.DataFrame:
    with open(path, "r", encoding="utf-8") as fh:
        rows = json.load(fh)
    df = pd.DataFrame(rows)
    expected = {"openTimeMs", "open", "high", "low", "close", "volume"}
    missing = expected - set(df.columns)
    if missing:
        raise ValueError(f"candles file missing columns: {missing}")
    df = df.sort_values("openTimeMs").reset_index(drop=True)
    df["dt_utc"] = pd.to_datetime(df["openTimeMs"], unit="ms", utc=True)
    return df


def compute_rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(period, min_periods=period).mean()
    loss = (-delta.clip(upper=0)).rolling(period, min_periods=period).mean()
    rs = gain / loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return rsi.fillna(50)


def compute_macd_hist(close: pd.Series) -> pd.Series:
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    macd = ema12 - ema26
    signal = macd.ewm(span=9, adjust=False).mean()
    return (macd - signal).fillna(0)


def compute_atr_pct(df: pd.DataFrame, period: int = 14) -> pd.Series:
    high = df["high"]
    low = df["low"]
    close_prev = df["close"].shift(1)
    tr = pd.concat(
        [
            high - low,
            (high - close_prev).abs(),
            (low - close_prev).abs(),
        ],
        axis=1,
    ).max(axis=1)
    atr = tr.rolling(period, min_periods=period).mean()
    return (atr / df["close"]).fillna(0)


def build_features(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    out = pd.DataFrame(index=df.index)
    out["ret_1"] = df["close"].pct_change(1).fillna(0)
    out["ret_5"] = df["close"].pct_change(5).fillna(0)
    out["ret_20"] = df["close"].pct_change(20).fillna(0)
    out["rsi_14"] = compute_rsi(df["close"], 14)
    out["macd_hist"] = compute_macd_hist(df["close"])
    out["atr_14_pct"] = compute_atr_pct(df, 14)
    vol_ma = df["volume"].rolling(20, min_periods=20).mean().replace(0, np.nan)
    out["vol_ratio_20"] = (df["volume"] / vol_ma).fillna(1)
    hours = df["dt_utc"].dt.hour
    for h in range(24):
        out[f"hour_{h:02d}"] = (hours == h).astype(int)
    feature_names = list(out.columns)
    return out, feature_names


def build_labels(close: pd.Series, target_move_pct: float) -> pd.Series:
    forward_return = close.shift(-1).pct_change(1)
    return (forward_return >= target_move_pct).astype(int)


def main() -> int:
    args = parse_args()
    candles = load_candles(args.candles)
    if len(candles) < args.min_samples:
        sys.stderr.write(
            f"only {len(candles)} candles — need at least {args.min_samples}\n"
        )
        return 2

    features, feature_names = build_features(candles)
    labels = build_labels(candles["close"], args.target_move_pct)
    # Drop the last row (no forward label) and the warmup rows where MAs are NaN
    valid = features.notna().all(axis=1) & labels.shift(0).notna()
    features = features[valid].iloc[:-1]
    labels = labels[valid].iloc[:-1]
    if len(features) < args.min_samples:
        sys.stderr.write(
            f"after dropping NaN warmup, only {len(features)} usable samples\n"
        )
        return 2

    X = features.to_numpy(dtype=np.float32)
    y = labels.to_numpy(dtype=np.int64)

    model = XGBClassifier(
        n_estimators=120,
        max_depth=4,
        learning_rate=0.05,
        objective="binary:logistic",
        eval_metric="logloss",
        tree_method="hist",
        n_jobs=2,
    )
    model.fit(X, y)
    pred = model.predict(X)
    win_rate = float((pred == y).mean())

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = out_dir / f"{args.symbol.lower()}-15m.onnx"
    meta_path = out_dir / f"{args.symbol.lower()}-15m.meta.json"

    initial_type = [("input", FloatTensorType([None, X.shape[1]]))]
    onnx_model = convert_sklearn(model, initial_types=initial_type)
    with open(onnx_path, "wb") as fh:
        fh.write(onnx_model.SerializeToString())

    meta = {
        "symbol": args.symbol,
        "trainedAtMs": int(time.time() * 1000),
        "samples": int(len(features)),
        "winRate": round(win_rate, 4),
        "featureNames": feature_names,
        "notes": (
            "scaffold model — features are generic; tune for your style "
            "after the first 30 closed trades show up in the cockpit"
        ),
    }
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)

    sys.stdout.write(
        f"trained {args.symbol}: {len(features)} samples, "
        f"win_rate={win_rate:.4f}, features={X.shape[1]}\n"
    )
    sys.stdout.write(f"wrote {onnx_path}\nwrote {meta_path}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
