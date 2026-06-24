import os, json
try:
    import requests
except ImportError:
    import urllib.request as requests

key = None
for path in ["web/.env.local", ".env.local", ".env"]:
    if not os.path.exists(path): continue
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line.startswith("TOGETHER_API_KEY="):
            key = line.split("=", 1)[1].strip().strip('"').strip("'")
            break

# Quick test call with a known serverless model
import urllib.request, urllib.error
payload = json.dumps({
    "model": "mistralai/Mixtral-8x7B-Instruct-v0.1",
    "messages": [{"role": "user", "content": "say hi"}],
    "max_tokens": 10
}).encode()

req = urllib.request.Request(
    "https://api.together.xyz/v1/chat/completions",
    data=payload,
    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
)
try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())
        print("OK - Mixtral-8x7B works:", data["choices"][0]["message"]["content"])
except urllib.error.HTTPError as e:
    raw = e.read()
    print("HTTP", e.code, raw[:500])
