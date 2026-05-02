# Mirror sync notes — sync-on-merge

This monorepo is **PRIVATE** (`orbita-pos/inariwatch`). The Capture SDK is
mirrored to the **PUBLIC** repo `orbita-pos/inariwatch-capture` — that's
where `@inariwatch/capture` is published from on npm, and that's the
repo `package.json#repository` points at.

> Mirror discipline (per `feedback_publish_workflow.md`): never publish
> from the monorepo. Always sync to the public mirror first, run tests
> there, then `npm publish`.

## v0.3 S6 changes that need to land in the mirror

The 2026-05-02 v0.3 S6 session added in-process PII / secret redaction
to the Node SDK. Files to mirror:

```
capture/CHANGELOG.md                               (new)
capture/MIRROR_SYNC_NOTES.md                       (new — this file)
capture/README.md                                  (modified — PII section)
capture/package.json                               (version 0.10.2 → 0.11.0)
capture/src/redact/                                (new dir, 5 files)
capture/src/redact/index.ts
capture/src/redact/patterns.ts
capture/src/redact/keys.ts
capture/src/redact/luhn.ts
capture/src/redact/hash.ts
capture/src/auto.ts                                (modified — INARIWATCH_REDACT env var)
capture/src/client.ts                              (modified — redact in send pipeline)
capture/src/index.ts                               (modified — exports)
capture/src/types.ts                               (modified — CaptureConfig.redact)
capture/test/redact.test.mjs                       (new — 54 tests)
```

## Sync command (Jesus drives — NOT done in this session)

```bash
# From the monorepo root, with the public mirror cloned next to it:
#   ../inariwatch-capture-public  ← cloned from orbita-pos/inariwatch-capture
cd capture
rsync -av --delete \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=.git \
  --exclude=MIRROR_SYNC_NOTES.md \
  ./ ../../inariwatch-capture-public/

cd ../../inariwatch-capture-public
npm install
npm test                # full suite must pass on the mirror too
git checkout -b release/0.11.0
git add -A
git commit -m "feat: v0.11.0 — in-process PII / secret redaction (opt-in)"
git push -u origin release/0.11.0
# Open PR, review diff against last published, merge, then:
git checkout main && git pull
npm publish             # publishes @inariwatch/capture@0.11.0
git tag v0.11.0 && git push --tags
```

## What NOT to mirror

- `MIRROR_SYNC_NOTES.md` itself (this file is monorepo-internal).
- `node_modules/`, `dist/` — built fresh on the mirror.
- Anything outside `capture/` — the mirror is just the SDK directory.
