# @inariwatch/capture-performance

Web Vitals integration for [`@inariwatch/capture`](https://www.npmjs.com/package/@inariwatch/capture). Measures Core Web Vitals (LCP, INP, CLS, FCP, TTFB) and streams them to your InariWatch dashboard alongside errors.

## Install

```bash
npm install @inariwatch/capture @inariwatch/capture-performance
```

## Usage

```ts
import { init } from "@inariwatch/capture"
import { performanceIntegration } from "@inariwatch/capture-performance"

init({
  dsn: process.env.NEXT_PUBLIC_INARIWATCH_DSN,
  integrations: [performanceIntegration()],
})
```

By default, only metrics rated `needs-improvement` or `poor` are reported — you won't be spammed with good-performance noise.

## Options

```ts
performanceIntegration({
  metrics: ["LCP", "INP", "CLS", "FCP", "TTFB"],  // default: all five
  minRating: "needs-improvement",                  // default
  onMetric: (metric) => {
    console.log(metric.name, metric.value, metric.rating)
  },
})
```

## What gets reported

Each metric lands in your dashboard as a structured log event:

```json
{
  "title": "vitals.lcp: 2847ms",
  "severity": "warning",
  "metadata": {
    "kind": "web_vitals",
    "metric": "LCP",
    "value": 2847,
    "rating": "needs-improvement",
    "pathname": "/checkout"
  }
}
```

Ratings map to levels:
- `good` → `info`
- `needs-improvement` → `warning`
- `poor` → `error` (shows up in alerts)

## Bundle impact

- `web-vitals` (dep, dynamic-imported): ~3 KB gzipped
- This integration: ~1 KB gzipped

Only loaded in the browser — server rendering pays zero cost.

## License

MIT
