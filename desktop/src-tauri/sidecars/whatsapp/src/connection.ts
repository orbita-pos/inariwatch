// v0.3 S5 — exponential-backoff reconnect helper.
//
// Mirrors the Rust-side relay backoff in `desktop/src-tauri/src/relay_client.rs`:
// 1s → 2s → 4s → 8s → 16s, then capped at 30s, with ±20% jitter so a
// relay restart doesn't stampede every linked Inari Live at once. The
// account session in `session.ts` calls `next()` between reconnect
// attempts. After `maxAttempts` consecutive failures we surface
// `failed` and stop trying (the user has to manually click "Reconnect"
// in the Settings UI).

export class Backoff {
  private attempt = 0;
  constructor(private readonly maxAttempts: number = 5) {}

  next(): number {
    const baseSec = (() => {
      switch (this.attempt) {
        case 0:
          return 1;
        case 1:
          return 2;
        case 2:
          return 4;
        case 3:
          return 8;
        case 4:
          return 16;
        default:
          return 30;
      }
    })();
    this.attempt += 1;
    const jitter = (Math.random() * 0.4 - 0.2) * baseSec;
    return Math.max(0.5, baseSec + jitter) * 1000;
  }

  reset(): void {
    this.attempt = 0;
  }

  exhausted(): boolean {
    return this.attempt >= this.maxAttempts;
  }

  attempts(): number {
    return this.attempt;
  }
}
