"""
Inari ML sidecar v0.4.1 — stateful online ML for anomaly detection and log clustering.
Runs alongside the web container as a Kamal accessory (long-lived process).

Endpoints:
  POST /ml/anomaly-score      — HalfSpaceTrees anomaly scoring + ADWIN drift detection
  POST /ml/cluster-alert      — Drain3 log template clustering (cluster id + template only)
  POST /ml/forecast           — SNARIMAX per-workspace time-series forecasting
  POST /ml/extract-entities   — GLiNER NER on stack traces (~350 MB RAM)
  GET  /health                — liveness probe

v0.4.1 changelog (2026-05-13):
  - Removed dead-code variable-slot analytics from /ml/cluster-alert. The
    `variable_anomalies` field was returned but never consumed by any web
    caller (verified by repo-wide grep). Dropping it eliminates two
    growing dicts (_slot_var, _slot_str_counts) and the per-request
    z-score computation. ClusterAlertResponse keeps the same shape minus
    that field.
  - SNARIMAX configuration switched from (p=6, d=1, q=0) to (p=4, d=0, q=0).
    The input series is `alert_rate_ratio` (current_count / baseline) which
    has mean ~1 and is already stationary — first-differencing it produces
    a near-zero-mean noise series whose forecast is statistically suspect.
    p=4 keeps ~8 min of lookback at 2-min cron intervals.
  - Pickled state now carries a SCHEMA_VERSION sentinel. On version
    mismatch (river/drain3 upgrade, breaking schema change), the loader
    discards the old file and starts fresh instead of silently
    deserializing into wrong-shaped objects.
"""
from __future__ import annotations

import pickle
from pathlib import Path
from typing import Optional

from drain3 import TemplateMiner
from drain3.file_persistence import FilePersistence
from fastapi import FastAPI
from pydantic import BaseModel
from river import anomaly, drift, time_series

# ── Paths ─────────────────────────────────────────────────────────────────────

DATA_DIR = Path("/data")
DATA_DIR.mkdir(parents=True, exist_ok=True)

# All River model state persisted here across container restarts.
# Written atomically (tmp → rename) to prevent corruption on SIGTERM.
MODELS_FILE = DATA_DIR / "ml_models.pkl"

# Bump SCHEMA_VERSION whenever the pickled structure or any model's
# constructor args change in a way that would make older state
# undeserializable into newer code. Older pickles are dropped on load.
SCHEMA_VERSION = 2

# ── River model stores (populated from disk on startup) ───────────────────────

_hst_models: dict[str, anomaly.HalfSpaceTrees] = {}
_adwin_models: dict[str, drift.ADWIN] = {}
_snarimax_models: dict[str, time_series.SNARIMAX] = {}
_snarimax_obs: dict[str, int] = {}  # observation counts — need 8+ before forecasting

# In-memory only — previous ADWIN estimation per metric for magnitude calc
_adwin_prev_est: dict[str, float] = {}

# ── Drain3 (has its own file persistence, not in the pickle) ──────────────────

_drain_persistence = FilePersistence(str(DATA_DIR / "drain3_state.bin"))
_drain_miner = TemplateMiner(_drain_persistence)

# ── GLiNER (lazy, not pickled — loads from HuggingFace cache on first request) ─

_gliner_model = None


# ── Persistence helpers ───────────────────────────────────────────────────────

def _load_models() -> None:
    if not MODELS_FILE.exists():
        return
    try:
        with open(MODELS_FILE, "rb") as f:
            payload = pickle.load(f)
    except (pickle.UnpicklingError, EOFError, AttributeError, ImportError) as exc:
        # Corrupt or incompatible state — start fresh, log loudly.
        print(f"[ml-sidecar] pickle load failed ({type(exc).__name__}): "
              f"discarding {MODELS_FILE.name}, models will rebuild")
        try:
            MODELS_FILE.unlink()
        except OSError:
            pass
        return

    # Schema-version gate. Pre-v2 pickles have no version field and we
    # treat them as version 1.
    version = payload.get("__schema_version__", 1) if isinstance(payload, dict) else 0
    if version != SCHEMA_VERSION:
        print(f"[ml-sidecar] pickle schema mismatch (got v{version}, "
              f"expected v{SCHEMA_VERSION}): discarding {MODELS_FILE.name}")
        try:
            MODELS_FILE.unlink()
        except OSError:
            pass
        return

    _hst_models.update(payload.get("hst", {}))
    _adwin_models.update(payload.get("adwin", {}))
    _snarimax_models.update(payload.get("snarimax", {}))
    _snarimax_obs.update(payload.get("snarimax_obs", {}))


def _save_models() -> None:
    try:
        state = {
            "__schema_version__": SCHEMA_VERSION,
            "hst": dict(_hst_models),
            "adwin": dict(_adwin_models),
            "snarimax": dict(_snarimax_models),
            "snarimax_obs": dict(_snarimax_obs),
        }
        tmp = MODELS_FILE.with_suffix(".tmp")
        with open(tmp, "wb") as f:
            pickle.dump(state, f)
        tmp.replace(MODELS_FILE)
    except (OSError, pickle.PicklingError) as exc:
        # Non-blocking — worst case models reset on next restart. Log so
        # ops sees the trend instead of silent disk failures.
        print(f"[ml-sidecar] pickle save failed ({type(exc).__name__}): {exc}")


# ── Model factory helpers ─────────────────────────────────────────────────────

def _get_hst(metric: str) -> anomaly.HalfSpaceTrees:
    if metric not in _hst_models:
        _hst_models[metric] = anomaly.HalfSpaceTrees(
            n_trees=10, height=8, window_size=250, seed=42
        )
    return _hst_models[metric]


def _get_adwin(metric: str) -> drift.ADWIN:
    if metric not in _adwin_models:
        _adwin_models[metric] = drift.ADWIN()
    return _adwin_models[metric]


def _get_snarimax(key: str) -> time_series.SNARIMAX:
    if key not in _snarimax_models:
        # ARIMA(4,0,0) — the input series is alert_rate_ratio which is
        # already stationary (mean ~1, see anomaly.ts:138). Differencing
        # it (d=1, the previous setting) produces a near-zero-mean noise
        # series whose forecast is statistically suspect. p=4 keeps ~8
        # min of lookback at 2-min cron intervals; q=0 because residuals
        # on a ratio series rarely have strong moving-average structure.
        _snarimax_models[key] = time_series.SNARIMAX(p=4, d=0, q=0, m=1, sp=0, sd=0, sq=0)
        _snarimax_obs[key] = 0
    return _snarimax_models[key]


def get_gliner():
    global _gliner_model
    if _gliner_model is None:
        from gliner import GLiNER
        _gliner_model = GLiNER.from_pretrained("urchade/gliner_medium-v2.1")
    return _gliner_model


# Load persisted state immediately at import time
_load_models()

# ── App ────────────────────────────────────────────────────────────────────────

app = FastAPI(title="inari-ml", version="0.4.1")


# ── Schemas ────────────────────────────────────────────────────────────────────

class AnomalyScoreRequest(BaseModel):
    metric: str
    value: float
    timestamp: float
    workspace_id: Optional[str] = None  # if set, also trains the per-workspace SNARIMAX model


class AnomalyScoreResponse(BaseModel):
    score: float
    is_anomaly: bool
    drift_detected: bool
    drift_magnitude: Optional[float] = None  # absolute change in baseline mean when drift fires


class ClusterAlertRequest(BaseModel):
    message: str


class ClusterAlertResponse(BaseModel):
    cluster_id: str
    template: str
    is_new_cluster: bool


class ForecastRequest(BaseModel):
    workspace_id: str
    metric: str
    horizon_minutes: int = 30


class ForecastResponse(BaseModel):
    predicted_value: float
    upper_bound: float
    lower_bound: float
    horizon_minutes: int
    confidence: float      # 0–1, grows with number of observations
    insufficient_data: bool


class ExtractEntitiesRequest(BaseModel):
    text: str


class EntityResult(BaseModel):
    label: str
    text: str
    score: float


class ExtractEntitiesResponse(BaseModel):
    entities: list[EntityResult]


# ── Endpoints ──────────────────────────────────────────────────────────────────

@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "schema_version": SCHEMA_VERSION,
        "models": {
            "hst": len(_hst_models),
            "adwin": len(_adwin_models),
            "snarimax": len(_snarimax_models),
        },
    }


@app.post("/ml/anomaly-score", response_model=AnomalyScoreResponse)
def anomaly_score(req: AnomalyScoreRequest) -> AnomalyScoreResponse:
    # ── HalfSpaceTrees anomaly scoring ─────────────────────────────────────
    hst = _get_hst(req.metric)
    x = {"value": req.value}
    score = float(hst.score_one(x))
    hst.learn_one(x)

    # ── ADWIN drift detection ───────────────────────────────────────────────
    adwin = _get_adwin(req.metric)
    prev_est = _adwin_prev_est.get(req.metric)
    adwin.update(req.value)
    cur_est = float(adwin.estimation)
    _adwin_prev_est[req.metric] = cur_est

    drift_detected = bool(adwin.drift_detected)
    drift_magnitude: Optional[float] = None
    if drift_detected and prev_est is not None:
        drift_magnitude = round(abs(cur_est - prev_est), 4)

    # ── SNARIMAX training (per workspace, optional) ─────────────────────────
    if req.workspace_id:
        key = f"{req.workspace_id}:{req.metric}"
        _get_snarimax(key).learn_one(req.value)
        _snarimax_obs[key] = _snarimax_obs.get(key, 0) + 1

    _save_models()

    return AnomalyScoreResponse(
        score=score,
        is_anomaly=score > 0.5,
        drift_detected=drift_detected,
        drift_magnitude=drift_magnitude,
    )


@app.post("/ml/cluster-alert", response_model=ClusterAlertResponse)
def cluster_alert(req: ClusterAlertRequest) -> ClusterAlertResponse:
    cluster, change_type = _drain_miner.add_log_message(req.message)
    template = " ".join(cluster.log_template_tokens)
    return ClusterAlertResponse(
        cluster_id=str(cluster.cluster_id),
        template=template,
        is_new_cluster=change_type == "cluster_created",
    )


@app.post("/ml/forecast", response_model=ForecastResponse)
def forecast(req: ForecastRequest) -> ForecastResponse:
    key = f"{req.workspace_id}:{req.metric}"
    obs = _snarimax_obs.get(key, 0)

    # Need at least p+1 = 5 observations for a meaningful forecast under
    # the v0.4.1 ARIMA(4,0,0) config. Was p+d+1 = 8 with d=1.
    if obs < 5:
        return ForecastResponse(
            predicted_value=0.0,
            upper_bound=0.0,
            lower_bound=0.0,
            horizon_minutes=req.horizon_minutes,
            confidence=0.0,
            insufficient_data=True,
        )

    model = _get_snarimax(key)
    # At 2-min cron intervals: horizon_steps = horizon_minutes / 2
    horizon_steps = max(1, req.horizon_minutes // 2)

    try:
        preds = model.forecast(horizon=horizon_steps)
        predicted = float(preds[-1])  # furthest-ahead prediction
        # Confidence band tightens from ±20% at 5 obs → ±5% at 200+ obs
        margin = max(0.05, 0.20 - (obs / 200) * 0.15)
        confidence = round(min(0.95, obs / 200), 3)

        return ForecastResponse(
            predicted_value=round(max(0.0, predicted), 4),
            upper_bound=round(max(0.0, predicted * (1 + margin)), 4),
            lower_bound=round(max(0.0, predicted * max(0.0, 1 - margin)), 4),
            horizon_minutes=req.horizon_minutes,
            confidence=confidence,
            insufficient_data=False,
        )
    except (ValueError, ArithmeticError) as exc:
        # ValueError = bad input shape, ArithmeticError = numerical issues
        # (overflow / underflow / div-by-zero). Anything else propagates.
        print(f"[ml-sidecar] forecast failed for {key}: {type(exc).__name__}: {exc}")
        return ForecastResponse(
            predicted_value=0.0,
            upper_bound=0.0,
            lower_bound=0.0,
            horizon_minutes=req.horizon_minutes,
            confidence=0.0,
            insufficient_data=True,
        )


@app.post("/ml/extract-entities", response_model=ExtractEntitiesResponse)
def extract_entities(req: ExtractEntitiesRequest) -> ExtractEntitiesResponse:
    model = get_gliner()
    labels = ["filename", "function_name", "line_number", "error_type", "package_name"]
    raw = model.predict_entities(req.text[:2000], labels, threshold=0.5)
    entities = [
        EntityResult(label=e["label"], text=e["text"], score=round(float(e["score"]), 4))
        for e in raw
    ]
    return ExtractEntitiesResponse(entities=entities)
