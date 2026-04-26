# `ml/` — Python ML training pipeline (Phase 7 scaffold)

Cipher-quarantined per CLAUDE.md: **Python trains, Node serves.** This folder
holds the XGBoost training scripts that produce `.onnx` files which the Node
cockpit (`scripts/ml-inference.ts`) loads via `onnxruntime-node`.

Until you have ≥30 closed trades on a symbol, the model can't usefully train
on personal trading style. Run `pnpm history:ingest --days 60` first, then
come back here.

## One-time setup

```powershell
cd ml
python -m venv .venv
.\.venv\Scripts\Activate.ps1     # Windows; use "source .venv/bin/activate" on Linux
pip install -r requirements.txt
```

## Train BTC/ETH/SOL models

```powershell
# inside the venv
python train.py --symbol BTCUSDT --candles ../data/cache/btc-15m.json --trades ../data/core.sqlite
python train.py --symbol ETHUSDT --candles ../data/cache/eth-15m.json --trades ../data/core.sqlite
python train.py --symbol SOLUSDT --candles ../data/cache/sol-15m.json --trades ../data/core.sqlite
```

Each run produces:

- `../models/<symbol>-15m.onnx` — the XGBoost classifier exported via `skl2onnx`
- `../models/<symbol>-15m.meta.json` — `{ trainedAtMs, samples, winRate, featureNames }`

The Node cockpit picks them up automatically on the next `pnpm trade:app` boot
and shows "ML active for BTCUSDT, ETHUSDT, SOLUSDT" in the header pill.

## Install onnxruntime-node (Node side)

The Node side imports the runtime lazily so the cockpit boots without it.
When you're ready to use ML inference:

```powershell
pnpm add -w onnxruntime-node
```

Then restart `pnpm trade:app` and the ML pill flips from "disabled" to "active".

## Status

This is a scaffold — `train.py` is intentionally minimal so you can read it
end-to-end before letting it touch your data. Read it, tweak the feature
engineering for your style, then retrain.
