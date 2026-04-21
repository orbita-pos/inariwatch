# Golden Dataset Summary

Generated from golden-dataset-v2.jsonl (10 sessions)

## Outcomes

| Status | Count |
|---|---|
| failed | 7 |
| pushing | 1 |
| awaiting_ci | 1 |
| queued | 1 |

## Curated bugs (3)

| Bug | Confidence | Self-Review | Pattern Match | Outcome | Fix Summary |
|---|---|---|---|---|---|
| missing-await | 98% | 95 | ✅ | pushing | Fix: Fixing unhandled promise rejection by awaiting the database insert operation. |
| undefined-foreach | 92% | 90 | ✅ | awaiting_ci | Fix: Fixes TypeError by checking if 'data' is defined and initializing it to an empty array if not. |
| null-deref-user-profile | 98% | 95 | ✅ | failed | Fix: Updated getUserName to safely handle a missing profile instead of dereferencing undefined. The function now returns |

## Fix code (curated bugs)

### missing-await
**Alert:** `UnhandledPromiseRejection: database connection closed`  
**Confidence:** 98% · **Self-Review:** 95 · **Pattern Match:** YES

`__inari_bugs_fixtures__/bug-03-missing-await.js`:
```js
// Bug: forgot await, promise leaks, error unhandled
module.exports = async function saveUser(db, user) {
  await db.insert('users', user);
  return { ok: true };
};

```

### undefined-foreach
**Alert:** `TypeError: Cannot read properties of undefined (reading 'forEach')`  
**Confidence:** 92% · **Self-Review:** 90 · **Pattern Match:** YES

`__inari_bugs_fixtures__/bug-02-foreach-undefined.js`:
```js
// Bug: data may be undefined when API returns empty
module.exports = function sumItems(data) {
  let total = 0;
  data = data || [];
  data.forEach(item => { total += item.value; });
  return total;
}; 

```

### null-deref-user-profile
**Alert:** `TypeError: Cannot read property 'name' of undefined`  
**Confidence:** 98% · **Self-Review:** 95 · **Pattern Match:** YES

`__inari_bugs_fixtures__/bug-01-null-deref.js`:
```js
// Bug: user.profile can be undefined
module.exports = function getUserName(user) {
  return (user.profile?.name ?? "").toUpperCase();
};

```

## Failure modes

| Mode | Count | Meaning |
|---|---|---|
| github_permissions | 4 | GitHub token missing write scopes — reconnect integration |
| ci_failures | 3 | Fix generated + pushed, but CI doesn't pass (demo-store has no CI workflow) |

## Real production alerts (7)

| Session | Source | Repo | Outcome | Confidence | Summary |
|---|---|---|---|---|---|
| cc0f4ce9 | capture | — | failed | 68% | Fix: I removed the unreachable external `fetch` from the `unhandled-promise` chaos path in the produ |
| 4aa8afd1 | capture | — | failed | 44% | Fix: Disabled the broken unhandled-promise render path so product pages always use the existing grac |
| 82d228be | vercel | josebernal12/colorear-web | failed | —% | Your GitHub token doesn't have write access to josebernal12/colorear-web. AI remediation needs to pu |
| 2d3c43b9 | vercel | orbita-pos/inariwatch.com | failed | —% | Your GitHub token doesn't have write access to orbita-pos/inariwatch.com. AI remediation needs to pu |
| 6b7d10e6 | github | — | queued | —% | — |
| f22d5fff | vercel | josebernal12/colorear-web | failed | —% | Your GitHub token doesn't have write access to josebernal12/colorear-web. AI remediation needs to pu |
| 374f5a75 | vercel | josebernal12/colorear-web | failed | —% | Your GitHub token doesn't have write access to josebernal12/colorear-web. AI remediation needs to pu |

## Key metrics

- **Pattern match rate (curated)**: 3/3
- **Sessions that produced a fix**: 5/10
- **Avg diagnosis confidence**: 80.0% (across 5)
- **Avg self-review score**: 90.0/100 (across 5)
