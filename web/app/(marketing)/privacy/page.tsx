import { MarketingNav } from "../marketing-nav";
import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";

const PAGE_TITLE       = "Privacy Policy — InariWatch";
const PAGE_DESCRIPTION = "How InariWatch collects, uses, and protects your data.";
const PAGE_URL         = "https://inariwatch.com/privacy";
const LAST_UPDATED     = "April 16, 2026";

export const metadata: Metadata = {
  title:       PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates:  { canonical: PAGE_URL },
  openGraph: {
    type:        "website",
    url:         PAGE_URL,
    siteName:    "InariWatch",
    title:       PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    // images auto-resolved from app/opengraph-image.tsx
  },
  twitter: {
    card:        "summary_large_image",
    site:        "@inariwatch",
    title:       PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-inari-bg text-fg-base">
      <MarketingNav opaque />
      <main className="mx-auto max-w-3xl px-6 pt-28 pb-24">
        <h1 className="text-3xl font-bold text-fg-strong mb-2">Privacy Policy</h1>
        <p className="text-sm text-fg-base mb-10">Last updated: {LAST_UPDATED}</p>

        <Section title="1. Overview">
          <p>
            InariWatch (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;) is operated by Jesus Bernal, based in Mexico. This policy explains
            what data we collect when you use InariWatch at{" "}
            <a href="https://inariwatch.com" className="text-inari-accent hover:underline">inariwatch.com</a>{" "}
            and{" "}
            <a href="https://app.inariwatch.com" className="text-inari-accent hover:underline">app.inariwatch.com</a>,
            how we use it, and your rights regarding it.
          </p>
          <p>
            InariWatch follows an <strong>open-core</strong> model. The user-facing components — the{" "}
            <a href="https://github.com/orbita-pos/inariwatch-capture" target="_blank" rel="noreferrer" className="text-inari-accent hover:underline">Capture SDK</a>,{" "}
            <a href="https://github.com/orbita-pos/inariwatch-mcp" target="_blank" rel="noreferrer" className="text-inari-accent hover:underline">MCP init tool</a>,{" "}
            <a href="https://github.com/orbita-pos/inariwatch-vscode" target="_blank" rel="noreferrer" className="text-inari-accent hover:underline">VS Code extension</a>, and{" "}
            <a href="https://github.com/orbita-pos/inariwatch-action" target="_blank" rel="noreferrer" className="text-inari-accent hover:underline">GitHub Action</a>{" "}
            — are released under the MIT License and publicly auditable. The hosted web application is proprietary.
          </p>
        </Section>

        <Section title="2. Data we collect">
          <p><strong>Account data:</strong> your name and email address when you register, and OAuth profile info (name, email, avatar) if you sign in with GitHub, Google, or GitLab.</p>
          <p><strong>Authentication data:</strong> hashed passwords, 2FA secrets (encrypted), session tokens, and password reset tokens. Session cookies (<InlineCode>next-auth.session-token</InlineCode>) are set with a 30-day expiry and are required for the app to function.</p>
          <p><strong>Integration data:</strong> webhook payloads and API responses from services you connect (GitHub, Vercel, Sentry, Datadog, Expo, and others). This may include stack traces, deployment logs, and error messages from your systems. All integration credentials are stored encrypted.</p>
          <p><strong>AI API keys (optional):</strong> all AI features work without your own key — we use our platform API key (OpenAI) to power them. If you optionally provide your own key under Settings (Anthropic, OpenAI, Groq, Grok, DeepSeek, Google Gemini), it is stored encrypted and used only to make requests on your behalf. We never share keys or use them for any other purpose.</p>
          <p><strong>Billing data:</strong> if you subscribe to InariWatch Pro, payment is processed by <a href="https://stripe.com" target="_blank" rel="noreferrer" className="text-inari-accent hover:underline">Stripe</a>. We store your Stripe customer ID, subscription status, and plan tier — we never see or store your payment card details.</p>
          <p><strong>Notification data:</strong> configuration for your notification channels (email, Telegram, Slack, browser push). Webhook endpoints and secrets are stored encrypted.</p>
          <p><strong>Email interaction data:</strong> alert notification emails include an open-tracking pixel and click-tracking links so we can show you whether notifications were received. This data is stored in your account and visible to you in the app.</p>
          <p><strong>Audit logs:</strong> we log certain account actions (login, settings changes) along with IP addresses for security purposes.</p>
          <p><strong>AI interaction logs:</strong> to diagnose issues and improve the quality of our AI analysis, we log prompts sent to AI models and their responses in our own database. Known sensitive patterns (emails, API keys, JWTs, credit card numbers, Bearer tokens) are automatically redacted before storage. These logs are stored exclusively within our own infrastructure — they are never shared with third-party AI observability services such as Helicone, LangSmith, or similar. Retention: up to 30 days. Access is restricted to administrative staff.</p>
          <p><strong>Blog newsletter:</strong> if you subscribe to the blog newsletter, we store your email. You can unsubscribe at any time via the link in any email.</p>
        </Section>

        <Section title="3. How we use your data">
          <ul className="list-disc pl-5 space-y-2">
            <li>To provide and operate the InariWatch service.</li>
            <li>To send transactional emails (password reset, workspace invites, alert notifications).</li>
            <li>To process subscription payments and manage billing.</li>
            <li>To send blog updates if you opted in.</li>
            <li>To debug errors and improve reliability.</li>
            <li>To detect and prevent abuse (rate limiting, audit logs).</li>
          </ul>
          <p className="mt-3">We do not sell your data. We do not use your data for advertising. We have no behavioral tracking on our website — only privacy-friendly, cookieless analytics (see Section 4).</p>
        </Section>

        <Section title="4. Third-party services">
          <ul className="list-disc pl-5 space-y-2">
            <li><strong>Neon</strong> — PostgreSQL database hosting. All your data is stored here.</li>
            <li><strong>Vercel</strong> — application hosting and edge functions.</li>
            <li><strong>Resend</strong> — transactional email delivery.</li>
            <li><strong>Stripe</strong> — subscription billing for InariWatch Pro. Card details are handled exclusively by Stripe; we never see or store them.</li>
            <li><strong>Upstash</strong> — Redis caching for rate limiting, AI response caching, and deduplication. No personal data is stored — only counters, fingerprints, and cached AI analysis text.</li>
            <li><strong>AI providers</strong> — AI features use our platform OpenAI key by default. If you provide your own key, requests are sent to that provider instead (Anthropic, OpenAI, Groq, xAI/Grok, DeepSeek, Google Gemini). Alert data (error messages, stack traces) is sent to the AI provider for analysis. We store AI responses only as shown in the app (e.g., alert diagnosis, postmortems). We do <strong>not</strong> route AI calls through any third-party observability proxy — our own internal logging (see &quot;AI interaction logs&quot; in Section 2) keeps this data within our systems.</li>
            <li><strong>GitHub / Google / GitLab</strong> — optional OAuth sign-in. We only store the provider account ID, email, and name returned by the provider.</li>
            <li><strong>Plausible Analytics</strong> — privacy-friendly, cookieless analytics. No personal data is collected. See <a href="https://plausible.io/privacy" target="_blank" rel="noreferrer" className="text-inari-accent hover:underline">plausible.io/privacy</a>.</li>
            <li><strong>Telegram / Slack</strong> — if you configure these as notification channels, alert data is sent to your Telegram bot or Slack webhook.</li>
          </ul>
        </Section>

        <Section title="5. Cookies">
          <p>
            We use one session cookie (<InlineCode>next-auth.session-token</InlineCode>) to keep you logged in. It expires after 30 days.
            We do not use advertising cookies, tracking cookies, or third-party analytics cookies.
          </p>
        </Section>

        <Section title="6. Data retention">
          <p>
            We retain your account and alert data for as long as your account is active.
            If you delete your account, your data is deleted within 30 days.
            You can request deletion at any time by emailing{" "}
            <a href="mailto:info@jesusbr.com" className="text-inari-accent hover:underline">info@jesusbr.com</a>.
          </p>
          <p className="mt-2">
            <strong>AI interaction logs</strong> (prompts and responses — see Section 2) are retained for up to
            30 days and then automatically deleted.
          </p>
        </Section>

        <Section title="7. Security">
          <p>
            We use HTTPS for all connections, bcrypt for password hashing, encrypted storage for API keys
            and integration secrets, HMAC signature verification on all incoming webhooks, and rate limiting
            on all authentication endpoints. If you discover a vulnerability, please report it to{" "}
            <a href="mailto:info@jesusbr.com" className="text-inari-accent hover:underline">info@jesusbr.com</a>.
          </p>
        </Section>

        <Section title="8. Open-source components">
          <p>
            The open-source components of InariWatch — the Capture SDK, MCP init tool, VS Code extension, and
            GitHub Action — are released under the MIT License. If you deploy those components yourself, you
            are responsible for the data they handle in your own environment. This policy applies only to the
            hosted service at inariwatch.com.
          </p>
        </Section>

        <Section title="9. Your rights">
          <p>
            You have the right to access, correct, export, or delete your personal data at any time.
            To exercise these rights, contact us at{" "}
            <a href="mailto:info@jesusbr.com" className="text-inari-accent hover:underline">info@jesusbr.com</a>{" "}
            or delete your account directly from Settings.
          </p>
          <p className="mt-2">
            <strong>For EU/EEA residents (GDPR):</strong> we process your data based on contractual necessity
            (providing the Service) and legitimate interest (security, abuse prevention). You have the right to
            data portability, the right to restrict processing, and the right to lodge a complaint with your
            local supervisory authority. We do not make automated decisions that produce legal effects concerning
            you — AI features generate suggestions, not binding actions.
          </p>
          <p className="mt-2">
            <strong>For California residents (CCPA):</strong> we do not sell your personal information. You have
            the right to know what data we collect, request deletion, and opt out of any future sale of personal
            information. To exercise these rights, email{" "}
            <a href="mailto:info@jesusbr.com" className="text-inari-accent hover:underline">info@jesusbr.com</a>.
          </p>
        </Section>

        <Section title="10. International data transfers">
          <p>
            Your data may be processed in different countries depending on which services are involved: the United
            States (Vercel, Neon, OpenAI, Stripe, Resend, Upstash), Germany (Hetzner), and other locations where
            our third-party providers operate. By using the Service, you consent to these transfers. We rely on
            each provider&apos;s own data protection measures and, where applicable, Standard Contractual Clauses.
          </p>
        </Section>

        <Section title="11. Changes to this policy">
          <p>
            We may update this policy occasionally. We will notify registered users by email of any
            material changes. Continued use of the service after changes constitutes acceptance.
          </p>
        </Section>

        <Section title="12. Contact">
          <p>
            Questions? Email us at{" "}
            <a href="mailto:info@jesusbr.com" className="text-inari-accent hover:underline">info@jesusbr.com</a>.
          </p>
        </Section>

        <div className="mt-12 pt-8 border-t border-line flex gap-6 text-sm text-fg-base">
          <Link href="/terms" className="hover:text-fg-strong transition-colors">Terms of Service</Link>
          <Link href="/" className="hover:text-fg-strong transition-colors">Home</Link>
        </div>
      </main>

      {/* Footer — matches landing page */}
      <footer className="border-t border-inari-border py-12">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2.5">
              <Image
                src="/logo-inari/favicon-96x96.png"
                alt=""
                width={24}
                height={24}
              />
              <span className="font-mono text-sm text-fg-base">
                inariwatch · built in MX
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-fg-base">
              <Link href="/docs"    className="hover:text-fg-strong transition-colors">Docs</Link>
              <Link href="/pricing" className="hover:text-fg-strong transition-colors">Pricing</Link>
              <Link href="/download" className="hover:text-fg-strong transition-colors">Mobile</Link>
              <Link href="/trust"   className="hover:text-fg-strong transition-colors">Trust</Link>
              <Link href="/status"  className="hover:text-fg-strong transition-colors">Status</Link>
              <Link href="/blog"    className="hover:text-fg-strong transition-colors">Blog</Link>
              <a
                href="https://github.com/orbita-pos/inariwatch-capture"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-fg-strong transition-colors"
              >
                GitHub
              </a>
              <Link href="/privacy" className="hover:text-fg-strong transition-colors">Privacy</Link>
              <Link href="/terms"   className="hover:text-fg-strong transition-colors">Terms</Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold text-fg-strong mb-3">{title}</h2>
      <div className="text-fg-base leading-relaxed space-y-2">{children}</div>
    </section>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="text-xs bg-surface-inner border border-line-subtle px-1.5 py-0.5 rounded font-mono text-fg-strong">
      {children}
    </code>
  );
}
