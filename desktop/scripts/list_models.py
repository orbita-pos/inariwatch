import os
from openai import OpenAI

key = None
for path in ["web/.env.local", ".env.local", ".env"]:
    if not os.path.exists(path):
        continue
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line.startswith("TOGETHER_API_KEY="):
            key = line.split("=", 1)[1].strip().strip('"').strip("'")
            break

client = OpenAI(api_key=key, base_url="https://api.together.xyz/v1")
models = client.models.list()
for m in models.data[:40]:
    print(m.id)
