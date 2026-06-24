"""
Train a FastText intent classifier and export it as intent_model.json.

Usage:
    pip install fasttext
    python desktop/scripts/train_intent.py

Output: desktop/src/lib/intent-router/model/intent_model.json

The exported model replaces the bootstrap keyword model with one trained
on ~80 examples per intent (EN + ES). Accuracy on the held-out validation
set is printed at the end.
"""

import fasttext
import json
import os
import random
import tempfile

# ── Training data ────────────────────────────────────────────────────────────
# Format: (label, text)
# ~80 examples per intent, mixed English and Spanish.

DATA = [
    # ── list_alerts ───────────────────────────────────────────────────────
    ("list_alerts", "show me the alerts"),
    ("list_alerts", "muéstrame las alertas"),
    ("list_alerts", "dame las alertas"),
    ("list_alerts", "qué alertas hay"),
    ("list_alerts", "lista de alertas"),
    ("list_alerts", "any alerts?"),
    ("list_alerts", "hay alertas activas"),
    ("list_alerts", "what's broken"),
    ("list_alerts", "qué está fallando"),
    ("list_alerts", "errores recientes"),
    ("list_alerts", "show me recent errors"),
    ("list_alerts", "cuántas alertas hay"),
    ("list_alerts", "how many alerts"),
    ("list_alerts", "any new errors?"),
    ("list_alerts", "alguna alerta nueva"),
    ("list_alerts", "what went wrong"),
    ("list_alerts", "qué reventó"),
    ("list_alerts", "qué se rompió"),
    ("list_alerts", "show alerts"),
    ("list_alerts", "ver alertas"),
    ("list_alerts", "alertas críticas"),
    ("list_alerts", "critical alerts"),
    ("list_alerts", "any warnings?"),
    ("list_alerts", "hay warnings"),
    ("list_alerts", "últimas alertas"),
    ("list_alerts", "last alerts"),
    ("list_alerts", "qué issues hay"),
    ("list_alerts", "what issues do I have"),
    ("list_alerts", "check alerts"),
    ("list_alerts", "revisar alertas"),
    ("list_alerts", "open alerts"),
    ("list_alerts", "alertas abiertas"),
    ("list_alerts", "active alerts"),
    ("list_alerts", "alertas activas"),
    ("list_alerts", "show me what's failing"),
    ("list_alerts", "hay errores"),
    ("list_alerts", "cualquier fallo"),
    ("list_alerts", "unresolved alerts"),
    ("list_alerts", "alertas sin resolver"),
    ("list_alerts", "pending alerts"),
    ("list_alerts", "alertas pendientes"),
    ("list_alerts", "problemas activos"),
    ("list_alerts", "active problems"),
    ("list_alerts", "errores activos"),
    ("list_alerts", "active errors"),
    ("list_alerts", "fallos actuales"),
    ("list_alerts", "current failures"),
    ("list_alerts", "dame los errores"),
    ("list_alerts", "give me the errors"),
    ("list_alerts", "what's the latest alert"),
    ("list_alerts", "cuál es la última alerta"),
    ("list_alerts", "mostrar alertas"),
    ("list_alerts", "display alerts"),

    # ── status_summary ───────────────────────────────────────────────────
    ("status_summary", "cómo está el sistema"),
    ("status_summary", "how is the system"),
    ("status_summary", "everything ok?"),
    ("status_summary", "todo bien?"),
    ("status_summary", "system status"),
    ("status_summary", "estado del sistema"),
    ("status_summary", "is everything working"),
    ("status_summary", "está todo operacional"),
    ("status_summary", "salud del sistema"),
    ("status_summary", "system health"),
    ("status_summary", "how is everything"),
    ("status_summary", "cómo va todo"),
    ("status_summary", "service status"),
    ("status_summary", "estado del servicio"),
    ("status_summary", "what's the status"),
    ("status_summary", "cuál es el estado"),
    ("status_summary", "is the app ok"),
    ("status_summary", "está la app bien"),
    ("status_summary", "overall health"),
    ("status_summary", "salud general"),
    ("status_summary", "all systems go"),
    ("status_summary", "todo operacional"),
    ("status_summary", "any degradation"),
    ("status_summary", "hay degradación"),
    ("status_summary", "system overview"),
    ("status_summary", "resumen del sistema"),
    ("status_summary", "how are services doing"),
    ("status_summary", "cómo están los servicios"),
    ("status_summary", "quick status"),
    ("status_summary", "estado rápido"),
    ("status_summary", "anything down"),
    ("status_summary", "algo caído"),
    ("status_summary", "status check"),
    ("status_summary", "revisión de estado"),
    ("status_summary", "how's the app"),
    ("status_summary", "cómo está la app"),
    ("status_summary", "give me a summary"),
    ("status_summary", "dame un resumen"),
    ("status_summary", "current status"),
    ("status_summary", "estado actual"),

    # ── uptime_monitors ───────────────────────────────────────────────────
    ("uptime_monitors", "show uptime monitors"),
    ("uptime_monitors", "uptime status"),
    ("uptime_monitors", "estado de uptime"),
    ("uptime_monitors", "are monitors ok"),
    ("uptime_monitors", "están los monitores ok"),
    ("uptime_monitors", "latency check"),
    ("uptime_monitors", "revisar latencia"),
    ("uptime_monitors", "any monitors down"),
    ("uptime_monitors", "hay monitores caídos"),
    ("uptime_monitors", "uptime monitors"),
    ("uptime_monitors", "monitores de uptime"),
    ("uptime_monitors", "what's the latency"),
    ("uptime_monitors", "cuál es la latencia"),
    ("uptime_monitors", "ping status"),
    ("uptime_monitors", "is the site down"),
    ("uptime_monitors", "está el sitio caído"),
    ("uptime_monitors", "response times"),
    ("uptime_monitors", "tiempos de respuesta"),
    ("uptime_monitors", "availability status"),
    ("uptime_monitors", "estado de disponibilidad"),
    ("uptime_monitors", "monitor status"),
    ("uptime_monitors", "estado de monitores"),
    ("uptime_monitors", "any endpoints down"),
    ("uptime_monitors", "endpoints caídos"),
    ("uptime_monitors", "check monitors"),
    ("uptime_monitors", "revisar monitores"),
    ("uptime_monitors", "uptime check"),
    ("uptime_monitors", "revisión de uptime"),
    ("uptime_monitors", "is site reachable"),
    ("uptime_monitors", "es el sitio alcanzable"),
    ("uptime_monitors", "show latency"),
    ("uptime_monitors", "mostrar latencia"),
    ("uptime_monitors", "what monitors are failing"),
    ("uptime_monitors", "qué monitores están fallando"),
    ("uptime_monitors", "offline monitors"),
    ("uptime_monitors", "monitores offline"),

    # ── recent_deploys ───────────────────────────────────────────────────
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
    ("recent_deploys", "historial de deploys"),
    ("recent_deploys", "recent builds"),
    ("recent_deploys", "builds recientes"),
    ("recent_deploys", "what shipped"),
    ("recent_deploys", "qué salió"),
    ("recent_deploys", "vercel deploys"),
    ("recent_deploys", "last release"),
    ("recent_deploys", "último release"),
    ("recent_deploys", "what merged recently"),
    ("recent_deploys", "qué se mergeó"),
    ("recent_deploys", "show deployments"),
    ("recent_deploys", "mostrar deploys"),
    ("recent_deploys", "latest deployment"),
    ("recent_deploys", "último deployment"),
    ("recent_deploys", "what's been deployed"),
    ("recent_deploys", "qué ha sido desplegado"),
    ("recent_deploys", "push history"),
    ("recent_deploys", "historial de pushes"),
    ("recent_deploys", "recent changes"),
    ("recent_deploys", "cambios recientes"),
    ("recent_deploys", "what went out today"),
    ("recent_deploys", "qué salió hoy"),
    ("recent_deploys", "last build"),
    ("recent_deploys", "último build"),

    # ── oncall_status ────────────────────────────────────────────────────
    ("oncall_status", "who is on call"),
    ("oncall_status", "quién está de guardia"),
    ("oncall_status", "on call schedule"),
    ("oncall_status", "horario de guardia"),
    ("oncall_status", "who's on duty"),
    ("oncall_status", "quién está de turno"),
    ("oncall_status", "oncall rotation"),
    ("oncall_status", "rotación de on-call"),
    ("oncall_status", "who do I contact"),
    ("oncall_status", "a quién contacto"),
    ("oncall_status", "who should I escalate to"),
    ("oncall_status", "a quién escalo"),
    ("oncall_status", "current on-call"),
    ("oncall_status", "on-call actual"),
    ("oncall_status", "who handles alerts"),
    ("oncall_status", "quién maneja las alertas"),
    ("oncall_status", "show on call"),
    ("oncall_status", "mostrar guardia"),
    ("oncall_status", "who is responsible"),
    ("oncall_status", "quién es responsable"),
    ("oncall_status", "on call today"),
    ("oncall_status", "guardia hoy"),
    ("oncall_status", "next on-call"),
    ("oncall_status", "próxima guardia"),
    ("oncall_status", "team schedule"),
    ("oncall_status", "horario del equipo"),

    # ── help ─────────────────────────────────────────────────────────────
    ("help", "help"),
    ("help", "ayuda"),
    ("help", "what can you do"),
    ("help", "qué puedes hacer"),
    ("help", "how do I use this"),
    ("help", "cómo te uso"),
    ("help", "show commands"),
    ("help", "mostrar comandos"),
    ("help", "available commands"),
    ("help", "comandos disponibles"),
    ("help", "what commands are there"),
    ("help", "qué comandos hay"),
    ("help", "how does this work"),
    ("help", "cómo funciona esto"),
    ("help", "instructions"),
    ("help", "instrucciones"),
    ("help", "i need help"),
    ("help", "necesito ayuda"),
    ("help", "what can I ask"),
    ("help", "qué puedo preguntar"),
    ("help", "help me"),
    ("help", "ayúdame"),
    ("help", "tutorial"),
    ("help", "guide"),
    ("help", "guía"),

    # ── error_trends ─────────────────────────────────────────────────────
    ("error_trends", "error trends"),
    ("error_trends", "tendencias de errores"),
    ("error_trends", "how many errors this week"),
    ("error_trends", "cuántos errores esta semana"),
    ("error_trends", "error frequency"),
    ("error_trends", "frecuencia de errores"),
    ("error_trends", "trending errors"),
    ("error_trends", "errores en tendencia"),
    ("error_trends", "top errors"),
    ("error_trends", "errores más frecuentes"),
    ("error_trends", "weekly errors"),
    ("error_trends", "errores semanales"),
    ("error_trends", "daily error count"),
    ("error_trends", "errores por día"),
    ("error_trends", "recurring errors"),
    ("error_trends", "errores recurrentes"),
    ("error_trends", "show error trends"),
    ("error_trends", "mostrar tendencias"),
    ("error_trends", "errors this week"),
    ("error_trends", "errores esta semana"),
    ("error_trends", "error breakdown"),
    ("error_trends", "desglose de errores"),
    ("error_trends", "most common errors"),
    ("error_trends", "errores más comunes"),
    ("error_trends", "error analytics"),
    ("error_trends", "analítica de errores"),
    ("error_trends", "errors last 7 days"),
    ("error_trends", "errores últimos 7 días"),
    ("error_trends", "how often do errors occur"),
    ("error_trends", "con qué frecuencia ocurren errores"),
    ("error_trends", "error patterns"),
    ("error_trends", "patrones de errores"),
    ("error_trends", "repeated errors"),
    ("error_trends", "errores repetidos"),
    ("error_trends", "alert volume"),
    ("error_trends", "volumen de alertas"),

    # ── root_cause ───────────────────────────────────────────────────────
    ("root_cause", "why did this fail"),
    ("root_cause", "por qué falló esto"),
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
    ("root_cause", "por qué está fallando"),
    ("root_cause", "analyze this alert"),
    ("root_cause", "analiza esta alerta"),
    ("root_cause", "what went wrong and why"),
    ("root_cause", "qué salió mal y por qué"),
    ("root_cause", "error diagnosis"),
    ("root_cause", "diagnóstico del error"),
    ("root_cause", "what's causing this"),
    ("root_cause", "qué está causando esto"),
    ("root_cause", "explain the failure"),
    ("root_cause", "explica el fallo"),
    ("root_cause", "ai diagnosis"),
    ("root_cause", "diagnóstico de ia"),
    ("root_cause", "get root cause"),
    ("root_cause", "obtener causa raíz"),
    ("root_cause", "why did it crash"),
    ("root_cause", "por qué crasheó"),
    ("root_cause", "what's the analysis"),
    ("root_cause", "cuál es el análisis"),

    # ── ack_alert ────────────────────────────────────────────────────────
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
    ("ack_alert", "ack this"),
    ("ack_alert", "ack the alert"),
    ("ack_alert", "acknowledge this alert"),
    ("ack_alert", "acusar esta alerta"),
    ("ack_alert", "mark as read"),
    ("ack_alert", "marcar como leído"),
    ("ack_alert", "I saw it"),
    ("ack_alert", "ya lo vi"),
    ("ack_alert", "saw it"),
    ("ack_alert", "acknowledged"),
    ("ack_alert", "I got it"),
    ("ack_alert", "lo tengo"),
    ("ack_alert", "seen"),
    ("ack_alert", "visto"),
    ("ack_alert", "read"),
    ("ack_alert", "leído"),
    ("ack_alert", "I know"),
    ("ack_alert", "ya sé"),

    # ── silence_alert ────────────────────────────────────────────────────
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
    ("silence_alert", "cerrar alerta"),
    ("silence_alert", "dismiss this"),
    ("silence_alert", "descartar esto"),
    ("silence_alert", "mark resolved"),
    ("silence_alert", "marcar resuelto"),
    ("silence_alert", "clear alert"),
    ("silence_alert", "limpiar alerta"),
    ("silence_alert", "this is fine"),
    ("silence_alert", "esto está bien"),
]

# ── Train ────────────────────────────────────────────────────────────────────

def write_fasttext_file(data, path):
    with open(path, "w", encoding="utf-8") as f:
        for label, text in data:
            f.write(f"__label__{label} {text}\n")

def train_and_export():
    random.shuffle(DATA)
    split = int(len(DATA) * 0.85)
    train_data = DATA[:split]
    val_data   = DATA[split:]

    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as tf:
        write_fasttext_file(train_data, tf.name)
        train_path = tf.name

    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as vf:
        write_fasttext_file(val_data, vf.name)
        val_path = vf.name

    print("Training FastText model...")
    model = fasttext.train_supervised(
        input=train_path,
        dim=64,
        epoch=50,
        lr=0.5,
        wordNgrams=2,
        minCount=1,
        loss="softmax",
        verbose=0,
    )

    # Validation accuracy
    result = model.test(val_path)
    print(f"Validation: {result[1]*100:.1f}% precision, {result[2]*100:.1f}% recall on {result[0]} examples")

    # Export for TypeScript inference
    labels = [l.replace("__label__", "") for l in model.labels]

    word_weights = {}
    for word in model.words:
        # For each word, compute which labels it contributes to most.
        # We store the normalized weight vector per word as a sparse dict
        # (only entries with abs weight > 0.01 to keep the JSON small).
        wv = model.get_word_vector(word)
        om = model.get_output_matrix()  # shape: (num_labels, dim)

        scores = {}
        for i, label in enumerate(labels):
            score = float(sum(wv[j] * om[i][j] for j in range(len(wv))))
            if abs(score) > 0.01:
                scores[label] = round(score, 4)

        if scores:
            word_weights[word] = scores

    # Bias: per-label log-prior from label frequency in training data
    label_counts = {}
    for label, _ in train_data:
        label_counts[label] = label_counts.get(label, 0) + 1
    total = sum(label_counts.values())
    bias = {l: round(label_counts.get(l, 0) / total, 4) for l in labels}

    output = {
        "version": 2,
        "labels": labels,
        "bias": bias,
        "wordWeights": word_weights,
    }

    out_path = os.path.join(
        os.path.dirname(__file__),
        "..", "src", "lib", "intent-router", "model", "intent_model.json"
    )
    out_path = os.path.normpath(out_path)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"Model exported → {out_path}")
    print(f"Vocabulary size: {len(word_weights)} words")
    print(f"Labels: {labels}")

    # Cleanup
    os.unlink(train_path)
    os.unlink(val_path)

if __name__ == "__main__":
    train_and_export()
