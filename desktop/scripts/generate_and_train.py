"""
Entrena el clasificador de intents usando augmentación programática.
No necesita API externa ni red.

Uso:
    python desktop/scripts/generate_and_train.py

Output: desktop/src/lib/intent-router/model/intent_model.json
"""

import os, json, random, re
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.metrics import accuracy_score, classification_report

# ── Seed data ─────────────────────────────────────────────────────────────────

SEED: list[tuple[str, str]] = [
    # list_alerts
    ("list_alerts", "show me the alerts"),
    ("list_alerts", "muéstrame las alertas"),
    ("list_alerts", "dame las alertas"),
    ("list_alerts", "qué alertas hay"),
    ("list_alerts", "any alerts"),
    ("list_alerts", "what's broken"),
    ("list_alerts", "qué está fallando"),
    ("list_alerts", "errores recientes"),
    ("list_alerts", "hay alertas activas"),
    ("list_alerts", "qué reventó"),
    ("list_alerts", "show alerts"),
    ("list_alerts", "ver alertas"),
    ("list_alerts", "alertas críticas"),
    ("list_alerts", "critical alerts"),
    ("list_alerts", "any warnings"),
    ("list_alerts", "hay warnings"),
    ("list_alerts", "últimas alertas"),
    ("list_alerts", "last alerts"),
    ("list_alerts", "qué issues hay"),
    ("list_alerts", "what issues do I have"),
    ("list_alerts", "open alerts"),
    ("list_alerts", "alertas abiertas"),
    ("list_alerts", "active alerts"),
    ("list_alerts", "alertas activas"),
    ("list_alerts", "unresolved alerts"),
    ("list_alerts", "alertas sin resolver"),
    ("list_alerts", "check alerts"),
    ("list_alerts", "revisar alertas"),
    ("list_alerts", "any errors"),
    ("list_alerts", "hay errores"),
    ("list_alerts", "what went wrong"),
    ("list_alerts", "give me the errors"),
    ("list_alerts", "dame los errores"),
    ("list_alerts", "how many alerts"),
    ("list_alerts", "cuántas alertas"),
    ("list_alerts", "show me what's failing"),
    ("list_alerts", "qué se rompió"),
    ("list_alerts", "fallos actuales"),
    ("list_alerts", "pending alerts"),
    ("list_alerts", "alertas pendientes"),
    # status_summary
    ("status_summary", "cómo está el sistema"),
    ("status_summary", "how is the system"),
    ("status_summary", "everything ok"),
    ("status_summary", "todo bien"),
    ("status_summary", "system status"),
    ("status_summary", "estado del sistema"),
    ("status_summary", "is everything working"),
    ("status_summary", "está todo operacional"),
    ("status_summary", "system health"),
    ("status_summary", "salud del sistema"),
    ("status_summary", "how is everything"),
    ("status_summary", "cómo va todo"),
    ("status_summary", "service status"),
    ("status_summary", "what's the status"),
    ("status_summary", "cuál es el estado"),
    ("status_summary", "is the app ok"),
    ("status_summary", "está la app bien"),
    ("status_summary", "overall health"),
    ("status_summary", "salud general"),
    ("status_summary", "any degradation"),
    ("status_summary", "hay degradación"),
    ("status_summary", "system overview"),
    ("status_summary", "resumen del sistema"),
    ("status_summary", "all systems go"),
    ("status_summary", "todo operacional"),
    ("status_summary", "status check"),
    ("status_summary", "give me a summary"),
    ("status_summary", "dame un resumen"),
    # uptime_monitors
    ("uptime_monitors", "show uptime monitors"),
    ("uptime_monitors", "uptime status"),
    ("uptime_monitors", "estado de uptime"),
    ("uptime_monitors", "any monitors down"),
    ("uptime_monitors", "hay monitores caídos"),
    ("uptime_monitors", "latency check"),
    ("uptime_monitors", "revisar latencia"),
    ("uptime_monitors", "is the site down"),
    ("uptime_monitors", "está el sitio caído"),
    ("uptime_monitors", "response times"),
    ("uptime_monitors", "tiempos de respuesta"),
    ("uptime_monitors", "availability status"),
    ("uptime_monitors", "monitor status"),
    ("uptime_monitors", "estado de monitores"),
    ("uptime_monitors", "check monitors"),
    ("uptime_monitors", "revisar monitores"),
    ("uptime_monitors", "uptime check"),
    ("uptime_monitors", "what monitors are failing"),
    ("uptime_monitors", "offline monitors"),
    ("uptime_monitors", "ping endpoints"),
    ("uptime_monitors", "are endpoints up"),
    ("uptime_monitors", "están los endpoints activos"),
    # recent_deploys
    ("recent_deploys", "recent deployments"),
    ("recent_deploys", "despliegues recientes"),
    ("recent_deploys", "what was deployed"),
    ("recent_deploys", "qué se deployó"),
    ("recent_deploys", "last deploys"),
    ("recent_deploys", "últimos deploys"),
    ("recent_deploys", "latest releases"),
    ("recent_deploys", "últimos releases"),
    ("recent_deploys", "what was pushed"),
    ("recent_deploys", "qué se subió"),
    ("recent_deploys", "deployment history"),
    ("recent_deploys", "recent builds"),
    ("recent_deploys", "builds recientes"),
    ("recent_deploys", "what shipped"),
    ("recent_deploys", "qué salió"),
    ("recent_deploys", "vercel deploys"),
    ("recent_deploys", "what merged recently"),
    ("recent_deploys", "qué se mergeó"),
    ("recent_deploys", "show deployments"),
    ("recent_deploys", "latest deployment"),
    ("recent_deploys", "last build"),
    ("recent_deploys", "último build"),
    ("recent_deploys", "recent changes"),
    ("recent_deploys", "cambios recientes"),
    # oncall_status
    ("oncall_status", "who is on call"),
    ("oncall_status", "quién está de guardia"),
    ("oncall_status", "on call schedule"),
    ("oncall_status", "horario de guardia"),
    ("oncall_status", "who's on duty"),
    ("oncall_status", "quién está de turno"),
    ("oncall_status", "oncall rotation"),
    ("oncall_status", "who do I contact"),
    ("oncall_status", "a quién contacto"),
    ("oncall_status", "who should I escalate to"),
    ("oncall_status", "a quién escalo"),
    ("oncall_status", "current on-call"),
    ("oncall_status", "on-call actual"),
    ("oncall_status", "who handles alerts"),
    ("oncall_status", "quién es responsable"),
    ("oncall_status", "on call today"),
    ("oncall_status", "guardia hoy"),
    # help
    ("help", "help"),
    ("help", "ayuda"),
    ("help", "what can you do"),
    ("help", "qué puedes hacer"),
    ("help", "how do I use this"),
    ("help", "cómo te uso"),
    ("help", "show commands"),
    ("help", "available commands"),
    ("help", "comandos disponibles"),
    ("help", "what commands are there"),
    ("help", "how does this work"),
    ("help", "cómo funciona"),
    ("help", "instructions"),
    ("help", "instrucciones"),
    ("help", "i need help"),
    ("help", "necesito ayuda"),
    ("help", "what can I ask"),
    ("help", "tutorial"),
    # error_trends
    ("error_trends", "error trends"),
    ("error_trends", "tendencias de errores"),
    ("error_trends", "how many errors this week"),
    ("error_trends", "cuántos errores esta semana"),
    ("error_trends", "error frequency"),
    ("error_trends", "frecuencia de errores"),
    ("error_trends", "top errors"),
    ("error_trends", "errores más frecuentes"),
    ("error_trends", "weekly errors"),
    ("error_trends", "errores semanales"),
    ("error_trends", "daily error count"),
    ("error_trends", "recurring errors"),
    ("error_trends", "errores recurrentes"),
    ("error_trends", "show error trends"),
    ("error_trends", "errors this week"),
    ("error_trends", "most common errors"),
    ("error_trends", "error analytics"),
    ("error_trends", "errors last 7 days"),
    ("error_trends", "errores últimos 7 días"),
    ("error_trends", "error patterns"),
    ("error_trends", "alert volume"),
    ("error_trends", "how often do errors occur"),
    # root_cause
    ("root_cause", "why did this fail"),
    ("root_cause", "por qué falló"),
    ("root_cause", "root cause"),
    ("root_cause", "causa raíz"),
    ("root_cause", "what caused the error"),
    ("root_cause", "qué causó el error"),
    ("root_cause", "diagnose this"),
    ("root_cause", "diagnostica esto"),
    ("root_cause", "explain the error"),
    ("root_cause", "explica el error"),
    ("root_cause", "ai analysis"),
    ("root_cause", "análisis de ia"),
    ("root_cause", "what does inari think"),
    ("root_cause", "qué dice inari"),
    ("root_cause", "what's the diagnosis"),
    ("root_cause", "cuál es el diagnóstico"),
    ("root_cause", "why is it failing"),
    ("root_cause", "analyze this alert"),
    ("root_cause", "what went wrong and why"),
    ("root_cause", "error diagnosis"),
    ("root_cause", "what's causing this"),
    ("root_cause", "explain the failure"),
    ("root_cause", "why did it crash"),
    ("root_cause", "por qué crasheó"),
    ("root_cause", "get root cause"),
    # ack_alert
    ("ack_alert", "ack"),
    ("ack_alert", "acknowledge"),
    ("ack_alert", "acknowledge alert"),
    ("ack_alert", "acusar recibo"),
    ("ack_alert", "ya lo vi"),
    ("ack_alert", "got it"),
    ("ack_alert", "entendido"),
    ("ack_alert", "mark as seen"),
    ("ack_alert", "marcar como visto"),
    ("ack_alert", "noted"),
    ("ack_alert", "recibido"),
    ("ack_alert", "ack this alert"),
    ("ack_alert", "acknowledge this alert"),
    ("ack_alert", "mark as read"),
    ("ack_alert", "marcar como leído"),
    ("ack_alert", "I saw it"),
    ("ack_alert", "acknowledged"),
    ("ack_alert", "seen"),
    ("ack_alert", "visto"),
    ("ack_alert", "ya sé"),
    ("ack_alert", "I know"),
    # silence_alert
    ("silence_alert", "silence this alert"),
    ("silence_alert", "silencia esta alerta"),
    ("silence_alert", "dismiss"),
    ("silence_alert", "dismiss alert"),
    ("silence_alert", "descartar alerta"),
    ("silence_alert", "close this alert"),
    ("silence_alert", "cerrar esta alerta"),
    ("silence_alert", "mark as resolved"),
    ("silence_alert", "marcar como resuelto"),
    ("silence_alert", "resolve alert"),
    ("silence_alert", "resolver alerta"),
    ("silence_alert", "mute alert"),
    ("silence_alert", "mutear alerta"),
    ("silence_alert", "ignore this"),
    ("silence_alert", "ignorar esto"),
    ("silence_alert", "it's fixed"),
    ("silence_alert", "ya está arreglado"),
    ("silence_alert", "already resolved"),
    ("silence_alert", "ya está resuelto"),
    ("silence_alert", "silence"),
    ("silence_alert", "silenciar"),
    ("silence_alert", "close alert"),
    ("silence_alert", "dismiss this"),
    ("silence_alert", "mark resolved"),
    ("silence_alert", "clear alert"),
    ("silence_alert", "this is fine"),
]

# ── Augmentation ──────────────────────────────────────────────────────────────

EN_PREFIXES = ["", "hey ", "please ", "can you ", "could you ", "i need to ", "just "]
ES_PREFIXES = ["", "oye ", "por favor ", "puedes ", "necesito ", "solo "]
SUFFIXES    = ["", "?", " please", " now", " quick", " ahora", " rápido"]

SYNONYMS: dict[str, list[str]] = {
    "show":      ["display", "list", "give me", "pull up"],
    "check":     ["review", "look at", "see"],
    "alerts":    ["warnings", "issues", "errors", "notifications"],
    "alertas":   ["avisos", "errores", "problemas"],
    "system":    ["app", "service", "platform"],
    "sistema":   ["app", "servicio", "plataforma"],
    "failing":   ["broken", "down", "erroring"],
    "falló":     ["rompió", "crasheó", "se cayó"],
}

def augment(text: str, n: int) -> list[str]:
    results = set()
    is_es = any(c in text for c in "áéíóúñü¿¡")
    prefixes = ES_PREFIXES if is_es else EN_PREFIXES

    for _ in range(n * 6):
        t = text
        # Random prefix + suffix
        t = random.choice(prefixes) + t + random.choice(SUFFIXES)
        # Random synonym substitution
        for word, syns in SYNONYMS.items():
            if word in t.lower() and random.random() < 0.4:
                t = re.sub(re.escape(word), random.choice(syns), t, flags=re.IGNORECASE, count=1)
        t = t.strip()
        if t and t != text:
            results.add(t)

    return list(results)[:n]

def build_dataset(seed: list[tuple[str, str]], per_intent: int = 200) -> list[tuple[str, str]]:
    from collections import defaultdict
    by_intent: dict[str, list[str]] = defaultdict(list)
    for label, text in seed:
        by_intent[label].append(text)

    augmented: list[tuple[str, str]] = list(seed)
    for label, texts in by_intent.items():
        needed = max(0, per_intent - len(texts))
        pool: list[str] = []
        for text in texts:
            pool.extend(augment(text, 8))
        random.shuffle(pool)
        for text in pool[:needed]:
            augmented.append((label, text))

    return augmented

# ── Export ────────────────────────────────────────────────────────────────────

def export_model(clf: Pipeline, labels: list[str], train_data: list[tuple[str, str]], out_path: str):
    vectorizer: TfidfVectorizer = clf.named_steps["tfidf"]
    lr: LogisticRegression      = clf.named_steps["lr"]
    vocab     = vectorizer.vocabulary_
    coef      = lr.coef_
    label_idx = {l: i for i, l in enumerate(lr.classes_)}

    word_weights: dict = {}
    for word, col in vocab.items():
        scores = {}
        for label in labels:
            i = label_idx.get(label)
            if i is None: continue
            w = float(coef[i, col])
            if abs(w) > 0.005:
                scores[label] = round(w, 4)
        if scores:
            word_weights[word] = scores

    label_counts: dict = {}
    for label, _ in train_data:
        label_counts[label] = label_counts.get(label, 0) + 1
    total = sum(label_counts.values())
    bias  = {l: round(label_counts.get(l, 0) / total, 4) for l in labels}

    output = {"version": 2, "labels": labels, "bias": bias, "wordWeights": word_weights}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("Building dataset with augmentation...")
    all_data = build_dataset(SEED, per_intent=250)
    random.shuffle(all_data)

    split     = int(len(all_data) * 0.85)
    train_set = all_data[:split]
    val_set   = all_data[split:]

    from collections import Counter
    counts = Counter(l for l, _ in train_set)
    print(f"Train: {len(train_set)} | Val: {len(val_set)}")
    for label, n in sorted(counts.items()):
        print(f"  {label}: {n}")

    X_train = [t for _, t in train_set]
    y_train = [l for l, _ in train_set]
    X_val   = [t for _, t in val_set]
    y_val   = [l for l, _ in val_set]

    print("\nTraining TF-IDF + LogisticRegression...")
    clf = Pipeline([
        ("tfidf", TfidfVectorizer(
            analyzer="word",
            ngram_range=(1, 2),
            min_df=1,
            sublinear_tf=True,
        )),
        ("lr", LogisticRegression(
            max_iter=1000,
            C=5.0,
            solver="lbfgs",
        )),
    ])
    clf.fit(X_train, y_train)

    preds    = clf.predict(X_val)
    accuracy = accuracy_score(y_val, preds)
    print(f"\nValidation accuracy: {accuracy*100:.1f}%")
    print(classification_report(y_val, preds))

    labels   = sorted(set(y_train))
    out_path = os.path.normpath(
        os.path.join(os.path.dirname(__file__),
                     "..", "src", "lib", "intent-router", "model", "intent_model.json")
    )
    export_model(clf, labels, train_set, out_path)
    tf_step: TfidfVectorizer = clf.named_steps["tfidf"]
    print(f"[OK] Model exported -> {out_path}")
    print(f"   Vocab: {len(tf_step.vocabulary_)} words")

if __name__ == "__main__":
    main()
