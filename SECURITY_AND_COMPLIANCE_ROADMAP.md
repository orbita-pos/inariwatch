# InariWatch Security & Compliance Roadmap

> **Handoff document.** Security posture and compliance roadmap for a company that runs a **remote code execution framework** (SDK peer mode) inside customers' production runtimes. This is a higher bar than traditional SaaS.
>
> **Read with:** `REMEDIATION_SYSTEM_ARCHITECTURE.md`, `SDK_PEER_ARCHITECTURE.md`, `PROTOCOL_SPEC.md`.
>
> **Date:** 2026-04-22
> **Owner:** Jesus Bernal (@JesusBrDev)
> **Current compliance state:** Pre-SOC2, pre-audit. Stack built for trust without certification (yet).

---

## 0. Thesis

Security certification (SOC2, ISO27001) **is not required to launch**. Big companies without it run for years. What is required is a **credible security posture** — defensible practices, documented procedures, transparency, responsive incident handling. Certification is the last step, not the first.

This roadmap has three horizons:

1. **Pre-launch / Year 1 (today):** minimum viable security stack, public-facing trust signals, Incident Response Plan, transparent disclosure. No certifications. Cost: ~$5-15k one-time + ~$2-5k/year.
2. **Year 2-3:** SOC2 Type I → Type II. External code audit. Pen testing. Cyber insurance. Cost: ~$50-100k/year.
3. **Year 4+:** ISO 27001, vertical-specific compliance (HIPAA if healthcare ICP develops), international certifications (UK Cyber Essentials, Germany BSI).

---

## 1. Threat model (synthesized across cloud + SDK + protocol)

### 1.1 Assets to protect

| Asset | Value |
|---|---|
| Customer source code (accessed during remediation) | Very high — trade secret, legal exposure if leaked |
| Customer runtime state (env vars, request bodies) | Very high — contains secrets, PII |
| Customer production systems (reachable via SDK peer) | Highest — direct compromise = extinction-level for product |
| Cloud signing key (authorizes peer commands) | Highest — compromise = all customers compromised |
| Pattern memory + community fixes database | High — competitive IP, could be exfiltrated |
| Fine-tune training dataset | High — competitive IP |
| EAP attestation chain | Medium — cryptographic integrity more than confidentiality |
| User account credentials (hashes) | High — account takeover exposure |

### 1.2 Adversaries

| Adversary | Capability | Likelihood | Impact |
|---|---|---|---|
| Opportunistic attacker (script kiddie) | Low | High | Low — stopped by basic hygiene |
| Targeted criminal (ransomware group) | Medium | Medium | High — could exfiltrate + extort |
| Competitor industrial espionage | Medium-high | Low-medium | High — model weights + customer list + moat patterns |
| Nation-state | Very high | Very low | Extinction-level — likely unstoppable, out of scope |
| Malicious insider | High (privileged access) | Low | Extinction-level — company-ending |
| Compromised customer (their machine pwned, their token stolen) | Medium | Medium | Bounded — signed-by-us commands still refused unless policy allows |
| Researcher (ethical) | High | Medium | Positive — bug bounty / disclosure |

### 1.3 Attack scenarios

**Scenario A — Cloud signing key compromise.**
- Impact: attacker can issue arbitrary peer commands to any SDK.
- Mitigation: key stored in HSM / KMS (AWS KMS, GCP KMS, or Hetzner-compatible Hashicorp Vault), never on disk unencrypted. Key rotation quarterly + on-suspicion. Emergency revocation via new pubkey chained from last good key.
- **Incident Response Plan needed:** documented, tested.

**Scenario B — SDK zero-day (sandbox escape in peer execution).**
- Impact: malicious cloud operator (us, if compromised) could escape policy and arbitrary-exec on customer machine.
- Mitigation: user policy `default: deny`; transparent audit log customer can inspect; kill switch env var; open-source SDK (anyone can audit).
- IRP: coordinated disclosure, emergency patch, revocation broadcast.

**Scenario C — Deno / Pyodide CVE (cloud CodeAct sandbox).**
- Impact: model-written code escapes sandbox, reaches cloud container.
- Mitigation: triple-layer isolation (Deno + Pyodide + gVisor); adversarial test suite on every PR; monthly CVE review.
- IRP: disable CodeAct via `CODEACT_ENABLED=false`; patch + re-enable.

**Scenario D — Supply chain (malicious npm package injected into `@inariwatch/capture`).**
- Impact: every SDK install pulls attacker code.
- Mitigation: npm 2FA on publish; `provenance` attestations (Sigstore); every release signed; monitoring for anomalous downloads/installs.
- IRP: publish clean version ASAP; deprecate malicious version; notify all users.

**Scenario E — Community fix poisoning.**
- Impact: attacker contributes patterns that look benign but introduce backdoors when auto-applied.
- Mitigation: first 200 auto-contributions manual review; anomaly detection on pattern shape (does it introduce `eval()`? network calls? etc.); 7-day cooling before auto-apply; post-apply monitoring for regressions.

**Scenario F — Prompt injection via error messages.**
- Impact: attacker crafts error message that subverts model's instructions.
- Mitigation: all untrusted input wrapped in `<alert_body>` XML tags; system prompt contains anti-injection directive; prompt cache validation; model fine-tuned on adversarial examples.

**Scenario G — Token replay / session hijacking.**
- Impact: stolen subscription token replayed from attacker machine.
- Mitigation: tokens bound to machine_id on handshake; ephemeral session keypair; short-lived tokens (refresh every 15min).

**Scenario H — Insider exfiltrates pattern memory.**
- Impact: competitor gets our moat.
- Mitigation: audit logs on all admin queries; anomalous-volume alerting; background check on employees with admin access; principle-of-least-privilege access control.

---

## 2. Year 1 security stack (pre-SOC2, "minimum viable trust")

### 2.1 Technical controls

- **TLS everywhere.** No plaintext traffic anywhere on customer-facing or internal endpoints. HSTS preload.
- **Secrets management.** All secrets in Hashicorp Vault / AWS Secrets Manager. Never in code, never in env files in git. sops encryption on any file-level secrets.
- **Signing key in HSM / KMS.** Ed25519 signing never done in application memory. Sign operation called via KMS API.
- **Database encryption at rest.** Neon provides this; confirm enabled. Customer-data columns additionally encrypted at application layer with per-workspace DEK.
- **Access control.** Principle of least privilege. Admin panel gated behind email whitelist + MFA (already in place).
- **Audit logging.** Every admin action + every access to customer data logged to immutable audit trail.
- **Rate limiting.** Redis-based per-endpoint, already in place. Maintain.
- **Dependency auditing.** `npm audit` / `cargo audit` in CI; Dependabot for security updates; weekly review of open CVEs in stack.
- **Adversarial test suite in CI.** Sandbox escape attempts, policy bypass attempts, prompt injection attempts — all tested on every PR.
- **Logging + alerting.** Anomalous access patterns trigger on-call page.

### 2.2 Organizational controls

- **Incident Response Plan (written, tested).** See §3.
- **Security.md public.** Threat model summary, responsible disclosure policy, encryption at rest/transit, data retention, subprocessor list.
- **Responsible disclosure policy.** Public email `security@inariwatch.com` (or similar) + PGP key. 48h triage SLA, 7-day critical patch SLA.
- **Changelog public for security fixes.** Non-exploitable disclosure after patch widely deployed.
- **Annual tabletop exercise.** Founder + key engineers simulate incidents to test IRP.
- **Background checks.** For any employee or contractor with admin access.

### 2.3 Transparency as substitute for certification

Since no SOC2 yet, substitute with aggressive transparency:

- **Open-source SDK.** Under MIT on GitHub. Anyone can audit what the SDK does.
- **Open protocol spec.** This doc + `PROTOCOL_SPEC.md` public.
- **Public security changelog.** Every CVE in our stack, every fix, every near-miss.
- **Customer Security Addendum.** Standard rider to contract that explicitly states: what we access, how we protect it, SLA on incident notification, audit rights.
- **Subprocessor list.** Who has access to customer data (Hetzner, Neon, Cloudflare, OpenAI) and under what terms.

### 2.4 Approximate Year 1 cost

| Item | One-time | Annual |
|---|---|---|
| Vault / KMS setup | $0-500 | $200-1000 |
| Security.md + disclosure policy setup | $0 (founder time) | $0 |
| Dependabot / Snyk | $0 free tier | $0-2k if paid tier |
| Cloudflare WAF / Rate limit (already have) | — | ~$200 (already budgeted) |
| IRP write + tabletop | $0-2k (optional vCISO review) | $0-1k (annual exercise) |
| Background checks | — | ~$200/employee |
| External audit (deferred to Year 2) | — | — |
| Bug bounty (deferred to Year 2+) | — | — |
| Cyber insurance (deferred to Year 2) | — | — |
| **Total** | **~$500-3000** | **~$500-3000** |

**This is achievable for a solo founder pre-revenue and gives a credible security story to most customers except Fortune 500 enterprise.**

---

## 3. Incident Response Plan (template — MUST be finalized before Fase 5 ships)

### 3.1 Roles

- **Incident Commander (IC):** Jesus (or designated deputy). Decides severity, coordinates response, authorizes emergency actions.
- **Technical Lead:** owns remediation of the issue.
- **Communications Lead:** customer / user notification, public status page, press if needed.

Small team → one person may wear multiple hats. Plan must still be explicit about who holds the pager.

### 3.2 Severity levels

| Level | Definition | Response SLA | Example |
|---|---|---|---|
| **SEV-1 Extinction** | Signing key compromise, customer prod system destroyed | < 15 min detect, < 1h mitigate, < 24h communicate | Cloud pubkey exposed |
| **SEV-2 Critical** | Data breach, SDK sandbox escape, auth bypass | < 1h detect, < 4h mitigate, < 72h communicate | CVE in Pyodide confirmed exploitable |
| **SEV-3 High** | Availability degraded, non-sensitive data exposure | < 4h detect, < 24h mitigate, < 7d communicate | DDoS, DB down |
| **SEV-4 Elevated** | Security hygiene issue, theoretical risk | < 24h detect, < 1 week mitigate, optional comms | CVE in dep not yet exploited |

### 3.3 Response phases

#### Phase 1 — Detect (0-15min)
- Alerting triggers (InariLens, Cloudflare logs, Hetzner metrics, npm monitoring)
- IC confirms alert, assigns SEV
- Open incident channel (Slack + secondary non-hosted in case of compromise)

#### Phase 2 — Contain (15min - 1h)
- For signing key compromise: **broadcast revocation across all live SDK connections within 5min using emergency revocation channel** (pre-authorized, out-of-band key).
- For CodeAct escape: flip `CODEACT_ENABLED=false` across all workers.
- For auth bypass: force-logout all sessions, invalidate all JWTs.
- For data breach: cut affected customer access; preserve forensic state.

#### Phase 3 — Eradicate (1h - 72h)
- Identify root cause
- Deploy patch
- Verify patch via adversarial test + canary deploy
- Rollout gradually

#### Phase 4 — Recover (72h+)
- Restore normal operation
- Re-enable features that were disabled
- Issue new signing key(s) if compromised
- Re-authenticate affected customers

#### Phase 5 — Post-mortem (within 1 week of recovery)
- Written blameless postmortem
- Public summary (on status page) if SEV-1/2
- Action items: what prevents recurrence?
- Update runbooks + this document

### 3.4 Pre-authorized emergency actions (IC can execute without further approval)

- Rotate signing keys
- Disable any feature flag
- Kill any worker
- Invalidate any session
- Block any IP / user agent at edge
- Post public status update
- Notify customers of confirmed SEV-1/2 incidents

### 3.5 Communication templates

Pre-written templates for:
- Customer notification (SEV-1/2)
- Public status page update
- Post-incident summary
- Regulatory notification (if GDPR Article 33 notice required — 72h window)

Templates stored in `runbook/templates/incident-comms/`.

### 3.6 Tabletop schedule

- Annual full tabletop: simulate SEV-1, practice IRP end-to-end
- Quarterly partial tabletop: one scenario each quarter
- After-action report feeds back into IRP improvements

---

## 4. Year 2-3 compliance roadmap

### 4.1 Month 12-18 triggers

- $30k+ MRR or first enterprise pilot asking for SOC2
- At least 3 months of clean incident record
- Core team stable (hiring halted or controlled)

### 4.2 Path

**Step 1 (month 12-15) — Engage vCISO part-time.**
- Cost: ~$2-5k/month
- Role: guide SOC2 prep, review controls, scope audit
- Candidate firms: Fractional CISO, Scrut.io, Vanta vCISO marketplace

**Step 2 (month 15-18) — SOC2 Type I audit.**
- Cost: ~$15-30k one-time
- Firm examples: Prescient Assurance, Barr Advisory, A-LIGN, Strike Graph
- Deliverable: report attesting controls **are designed** correctly (snapshot in time)
- Usable for enterprise prospects as "we're on SOC2 track"

**Step 3 (month 18-30) — SOC2 Type II audit.**
- Cost: ~$25-50k for 12-month observation window
- Deliverable: report attesting controls **operated effectively** over the window
- This is what Fortune 500 procurement wants

**Step 4 (month 24+) — External code audit.**
- Cost: ~$20-40k one-time
- Firms: Trail of Bits, NCC Group, Cure53, Include Security
- Scope: SDK + protocol + policy engine + CodeAct sandbox
- Deliverable: audit report publishable (or summary publishable)

**Step 5 (month 30+) — Penetration testing.**
- Annual, ~$10-20k per engagement
- Scope: entire surface (cloud, SDK, mobile, admin)

**Step 6 (year 3+) — Bug bounty program.**
- Platform: HackerOne / Intigriti
- Reserved budget: $10-30k/year
- Public launch triggers automatic security reputation boost

### 4.3 ISO 27001 (year 3+)

Only if European or Asian enterprise is in ICP. US enterprise rarely asks for ISO if SOC2 exists. If pursued:
- Cost: ~$30-50k first year
- Lead time: 6-12 months prep, 3-6 month audit
- Scope overlaps significantly with SOC2; reuse evidence

---

## 5. Vertical-specific compliance (if / when ICP expands)

| Vertical | Required | Effort |
|---|---|---|
| Healthcare | HIPAA BAA + Type II | +$20-40k/year + legal |
| Finance | SOC2 Type II + additional controls | Usually sufficient; SOC for Cybersecurity optional |
| Government | FedRAMP Moderate (massive) | $500k-1M+ multi-year |
| Retail / payments | PCI-DSS (only if touching cards) | Avoid by never touching cards |
| Pharma / life sciences | 21 CFR Part 11 | Narrow scope; ~$50-100k |

**Recommendation:** do not pursue vertical compliance until there's specific paying-customer demand. Chasing compliance without demand is a distraction.

---

## 6. Cyber insurance strategy

**Year 1:** skip. Cost > benefit for pre-revenue startup. Your personal liability exposure is the real risk; LLC / Inc. structure is your main shield.

**Year 2 (as revenue grows):**
- **E&O (Errors & Omissions) / Tech E&O** — ~$3-8k/year for $1M coverage
- **Cyber liability** — ~$5-15k/year for $1M coverage (data breach response, forensic cost)
- **Total:** ~$10-20k/year

**Year 3+ (as enterprise customers sign):**
- Increase coverage to $5-10M
- Add D&O (Directors & Officers) if you have board / investors
- ~$30-50k/year total

**Without SOC2, insurance is more expensive.** With SOC2 Type II, premiums drop ~30-40%.

---

## 7. Customer Security Addendum template

When enterprise prospects ask "do you have SOC2?", and you don't yet, you send:

1. This roadmap doc
2. `security.md` public
3. Customer Security Addendum — a 3-5 page contract rider covering:
   - What data we access and why
   - How we protect it (technical controls list)
   - Where it's stored (Neon US-East, Hetzner Germany for compute — declare sub-processors)
   - Data retention + deletion policy
   - Incident notification SLA (72h for SEV-1/2)
   - Right-to-audit clause (customer can inspect our security practices, with NDA)
   - Liability cap aligned with contract value
   - GDPR / CCPA compliance attestations
   - Subprocessor list with change-notification clause

Template draft by lawyer one time (~$3-5k), reusable per customer.

**Many enterprise customers will accept this in lieu of SOC2 for the first 12-24 months, especially if they're signing a smaller pilot deal.**

---

## 8. Security responsibilities — who does what

Solo founder baseline. Expand as team grows.

| Role | Year 1 (solo) | Year 2 (small team) | Year 3+ |
|---|---|---|---|
| Security owner | Jesus | Jesus + vCISO | Full-time CISO? |
| IRP execution | Jesus as IC | IC + deputy | Dedicated on-call rotation |
| Vulnerability triage | Jesus | Security engineer | Security team |
| Audit prep | Jesus + vCISO | Compliance lead | Dedicated compliance function |
| Customer security questionnaires | Jesus | Security engineer | Customer security team |

---

## 9. Bug bounty — when and how

**Do not launch before:**
- SDK + cloud have been live 6+ months
- Incident Response Plan tested via tabletop
- Budget reserved ($10-30k/year minimum to pay researchers)

**Initial launch (year 2-3):**
- Platform: HackerOne or Intigriti
- Scope: SDK, protocol, cloud API. Exclude: rate limiting findings, self-XSS, social engineering.
- Rewards: $100 (low) to $5000 (critical) initially. Increase over time.
- SLA: 5 business days initial triage, 30 days pay-on-valid, public disclosure after patch.

---

## 10. Ongoing rhythm

**Daily:**
- Monitor dependency CVE feeds
- Review alerting output

**Weekly:**
- `npm audit` / `cargo audit` review
- Failed-login / anomalous-access report

**Monthly:**
- Deno + Pyodide CVE review (for CodeAct sandbox)
- Security changelog update
- Access control audit (who has admin access? still appropriate?)

**Quarterly:**
- Tabletop exercise (one scenario)
- Signing key rotation
- Subprocessor review (have any added/removed?)

**Annually:**
- Full tabletop IRP exercise
- Security posture review with vCISO
- Pen test (Year 2+)
- Insurance renewal
- Background checks renewal for privileged employees

---

## 11. What happens if something bad happens before SOC2

**Scenario:** SDK sandbox escape disclosed publicly; attacker demonstrates RCE on customer machine via malicious cloud command.

- **Legal exposure** higher than if SOC2 existed. Plaintiff counsel will argue negligence because "industry standard" (SOC2) not achieved.
- **Insurance denial risk** higher without Type II report.
- **Customer churn** immediate for affected customers, reputational for others.
- **Regulatory:** GDPR Article 33 may require 72h notification; no SOC2 affects materials but not the obligation.

**Mitigations:**
1. Written IRP that was tested
2. Demonstrable responsible disclosure policy
3. Audit logs showing what happened and when
4. Immediate patch + communication
5. External security audit report (if you commissioned one)
6. Transparency: public postmortem, not cover-up

**Best case:** survive with customer relationships intact through transparency + competence.
**Worst case:** existential damage if handled poorly.

This is why IRP + security stack matter **more** than SOC2 early — SOC2 is about signaling; IRP + stack is about actual survivability.

---

## 12. Key principle

> **SOC2 is a trailing indicator of security maturity. Build the maturity first; certify later.**

The checklist Fortune 500 hands you is not the goal. The goal is a business that can survive a bad day.

End of security and compliance roadmap.
