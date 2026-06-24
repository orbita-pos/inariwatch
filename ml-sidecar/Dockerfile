FROM python:3.11-slim

WORKDIR /app

# libgomp1 is required by PyTorch/GLiNER on the slim image (OpenMP threading)
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*

# Non-root user (uid 1000 matches the accessory user: "1000:1000" in deploy.yml)
RUN adduser --disabled-password --gecos "" --uid 1000 inari \
 && mkdir -p /data && chown inari:inari /data

COPY requirements.txt .

# Install CPU-only PyTorch first so gliner/moondream don't pull 2.5 GB of CUDA
# libraries. The --index-url here only applies to this single RUN layer.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

USER inari

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
