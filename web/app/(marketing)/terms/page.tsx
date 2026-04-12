import { MarketingNav } from "../marketing-nav";
import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";

const PAGE_TITLE       = "Terms of Service — InariWatch";
const PAGE_DESCRIPTION = "Terms and conditions for using InariWatch.";
const PAGE_URL         = "https://inariwatch.com/terms";
const LAST_UPDATED     = "April 11, 2026";

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

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-inari-bg text-fg-base">
      <MarketingNav opaque />
      <main className="mx-auto max-w-3xl px-6 pt-28 pb-24">
        <h1 className="text-3xl font-bold text-fg-strong mb-2">Terms of Service</h1>
        <p className="text-sm text-fg-base mb-10">Last updated: {LAST_UPDATED}</p>

        <Section title="1. Acceptance">
          <p>
            By creating an account or using InariWatch (&quot;the Service&quot;), you agree to these Terms.
            If you do not agree, do not use the Service. The Service is operated by Jesus Bernal (&quot;we&quot;, &quot;us&quot;).
          </p>
        </Section>

        <Section title="2. The Service">
          <p>
            InariWatch is a developer monitoring platform available at{" "}
            <a href="https://inariwatch.com" className="text-inari-accent hover:underline">inariwatch.com</a>.
            We offer a free tier and a paid Pro tier (see <Link href="/pricing" className="text-inari-accent hover:underline">Pricing</Link> for current plans).
            We provide the Service as-is and may change, suspend, or discontinue any part of it at any time with reasonable notice.
          </p>
          <p>
            InariWatch follows an <strong>open-core</strong> model. The user-facing components — the Capture SDK,
            MCP init tool, VS Code extension, and GitHub Action — are released under the MIT License. The hosted
            web application is proprietary.
          </p>
        </Section>

        <Section title="3. Your account">
          <ul className="list-disc pl-5 space-y-2">
            <li>You are responsible for keeping your credentials secure.</li>
            <li>You must be at least 16 years old to use the Service.</li>
            <li>One person or legal entity may not maintain more than one free account.</li>
            <li>You are responsible for all activity that occurs under your account.</li>
          </ul>
        </Section>

        <Section title="4. Acceptable use">
          <p>You agree not to:</p>
          <ul className="list-disc pl-5 space-y-2 mt-2">
            <li>Use the Service for illegal purposes or to violate any applicable laws.</li>
            <li>Attempt to gain unauthorized access to any systems or accounts.</li>
            <li>Use the Service to send spam or unsolicited messages.</li>
            <li>Abuse the Service in a way that degrades performance for other users (e.g., excessive API calls).</li>
            <li>Circumvent rate limits, quota limits, or security measures.</li>
          </ul>
        </Section>

        <Section title="5. Your data and integrations">
          <p>
            You retain ownership of all data you bring into InariWatch — alert payloads, integration tokens,
            and AI keys are yours. By using the Service, you grant us a limited license to store and process
            that data solely to provide the Service to you.
          </p>
          <p className="mt-2">
            You are responsible for ensuring you have the right to connect any third-party service
            (GitHub, Vercel, Sentry, Datadog, Expo, etc.) to InariWatch. Alert data may include stack traces,
            error messages, and deployment logs — ensure you are authorized to share this data with our service.
          </p>
        </Section>

        <Section title="6. AI features">
          <p>
            InariWatch uses AI models to analyze alerts and suggest remediations. Alert auto-analyses are
            platform-funded using GPT-4o-mini for users on both Free and Pro tiers. Advanced features —
            AI remediations, Ask Inari chat, and postmortems — require you to connect your own API key from
            a supported provider (Anthropic, OpenAI, Groq, xAI/Grok, DeepSeek, or Google Gemini). You are
            responsible for complying with the terms of service of your chosen AI provider, and your provider
            bills you directly for usage.
          </p>
          <p className="mt-2">
            AI-generated content may be inaccurate or incomplete. You are solely responsible for any action
            you take based on AI suggestions, including code changes, merges, deployments, or infrastructure
            modifications. We are not liable for any damage caused by acting on AI-generated recommendations.
          </p>
        </Section>

        <Section title="7. Billing and subscriptions">
          <p>
            The Free tier is free forever and does not require a credit card. InariWatch Pro is a paid
            subscription billed monthly or annually via <a href="https://stripe.com" target="_blank" rel="noreferrer" className="text-inari-accent hover:underline">Stripe</a>.
            Current prices are listed at <Link href="/pricing" className="text-inari-accent hover:underline">inariwatch.com/pricing</Link>.
          </p>
          <p className="mt-2">
            <strong>Auto-renewal.</strong> Pro subscriptions renew automatically at the end of each billing
            period (monthly or annually) at the then-current price. You can cancel anytime from your billing
            portal; your Pro features remain active until the end of the current period, then your account
            reverts to the Free tier.
          </p>
          <p className="mt-2">
            <strong>Refunds.</strong> We do not offer refunds for partial billing periods. If you cancel
            mid-period, you keep Pro access until the period ends. If you believe you were charged in error,
            contact us at <a href="mailto:info@jesusbr.com" className="text-inari-accent hover:underline">info@jesusbr.com</a> within 14 days of the charge.
          </p>
          <p className="mt-2">
            <strong>Price changes.</strong> We may update subscription prices. Existing subscribers will be
            notified by email at least 30 days before any price change takes effect on their account. Continued
            use after the notice period constitutes acceptance of the new price.
          </p>
          <p className="mt-2">
            <strong>Failed payments.</strong> If payment fails, Stripe will retry automatically. If retries
            fail, your account will be downgraded to the Free tier until the outstanding balance is resolved.
            Your data is preserved for 30 days before deletion.
          </p>
        </Section>

        <Section title="8. Open source and self-hosting">
          <p>
            The Capture SDK, MCP init tool, VS Code extension, and GitHub Action are released under the MIT
            License. You are free to self-host, modify, and distribute those components under that license.
            The hosted web application, backend, and CLI are proprietary and are not available for self-hosting.
            These Terms of Service apply only to the hosted service at inariwatch.com.
          </p>
        </Section>

        <Section title="9. Notifications">
          <p>
            By configuring notification channels (email, Telegram, Slack, browser push), you consent to receiving
            alert notifications through those channels. You can disable or remove any channel at any time
            from Settings. Email notifications include an unsubscribe option in every message.
          </p>
        </Section>

        <Section title="10. Disclaimer of warranties">
          <p>
            The Service is provided &quot;as is&quot; without warranty of any kind. We do not guarantee uptime,
            accuracy of alerts, correctness of AI-generated content, or fitness for any particular purpose —
            including production monitoring. Use it at your own risk and maintain your own independent
            monitoring for critical systems.
          </p>
        </Section>

        <Section title="11. Limitation of liability">
          <p>
            To the maximum extent permitted by law, we are not liable for any indirect, incidental, special,
            or consequential damages arising from your use of the Service, including data loss, production
            incidents, missed alerts, or decisions made based on AI-generated content. Our total aggregate
            liability under these Terms shall not exceed the amount you paid us in the 12 months preceding
            the claim, or $100 USD, whichever is greater.
          </p>
        </Section>

        <Section title="12. Termination">
          <p>
            You can delete your account at any time from Settings. We may suspend or terminate accounts
            that violate these Terms. Upon termination, your data will be deleted within 30 days. If you
            have an active Pro subscription, termination will cancel the subscription — see Section 7 for
            refund policy.
          </p>
        </Section>

        <Section title="13. Changes to these terms">
          <p>
            We may update these Terms. We will notify users by email of material changes at least 14 days
            in advance. Continued use after changes take effect constitutes acceptance.
          </p>
        </Section>

        <Section title="14. Governing law">
          <p>
            These Terms are governed by the laws of Mexico. Any disputes shall be resolved in the courts
            of Mexico City, Mexico.
          </p>
        </Section>

        <Section title="15. Contact">
          <p>
            Questions about these Terms?{" "}
            <a href="mailto:info@jesusbr.com" className="text-inari-accent hover:underline">info@jesusbr.com</a>
          </p>
        </Section>

        <div className="mt-12 pt-8 border-t border-line flex gap-6 text-sm text-fg-base">
          <Link href="/privacy" className="hover:text-fg-strong transition-colors">Privacy Policy</Link>
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
