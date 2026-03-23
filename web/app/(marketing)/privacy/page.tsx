import { MarketingNav } from "../marketing-nav";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — InariWatch",
  description: "How InariWatch collects, uses, and protects your data.",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-inari-bg text-fg-base">
      <MarketingNav opaque />
      <main className="mx-auto max-w-3xl px-6 pt-28 pb-24">
        <h1 className="text-3xl font-bold text-fg-strong mb-2">Privacy Policy</h1>
        <p className="text-sm text-zinc-500 mb-10">Last updated: March 23, 2025</p>

        <Section title="1. Overview">
          <p>
            InariWatch (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;) is operated by Jesus Bernal. This policy explains
            what data we collect when you use InariWatch at{" "}
            <a href="https://inariwatch.com" className="text-inari-accent hover:underline">inariwatch.com</a>{" "}
            and{" "}
            <a href="https://app.inariwatch.com" className="text-inari-accent hover:underline">app.inariwatch.com</a>,
            how we use it, and your rights regarding it.
          </p>
          <p>
            InariWatch is fully open source under the MIT License. You can review all data handling code at{" "}
            <a href="https://github.com/orbita-pos/inariwatch" target="_blank" rel="noreferrer" className="text-inari-accent hover:underline">
              github.com/orbita-pos/inariwatch
            </a>.
          </p>
        </Section>

        <Section title="2. Data we collect">
          <p><strong>Account data:</strong> your name and email address when you register, and OAuth profile info (name, email, avatar) if you sign in with GitHub, Google, or GitLab.</p>
          <p><strong>Authentication data:</strong> hashed passwords, 2FA secrets (encrypted), session tokens, and password reset tokens. Session cookies (<code className="text-xs bg-zinc-800 px-1 py-0.5 rounded">next-auth.session-token</code>) are set with a 30-day expiry and are required for the app to function.</p>
          <p><strong>Integration data:</strong> webhook payloads and API responses from services you connect (GitHub, Vercel, Sentry, Datadog). This may include stack traces, deployment logs, and error messages from your systems. All integration credentials are stored encrypted.</p>
          <p><strong>AI API keys:</strong> keys you provide under Settings (Anthropic, OpenAI, Google, Grok, DeepSeek) are stored encrypted and used only to make requests on your behalf. We never share them or use them for any other purpose.</p>
          <p><strong>Notification data:</strong> configuration for your notification channels (email, Telegram, Slack, browser push). Webhook endpoints and secrets are stored encrypted.</p>
          <p><strong>Email interaction data:</strong> alert notification emails include an open-tracking pixel and click-tracking links so we can show you whether notifications were received. This data is stored in your account and visible to you in the app.</p>
          <p><strong>Audit logs:</strong> we log certain account actions (login, settings changes) along with IP addresses for security purposes.</p>
          <p><strong>Blog newsletter:</strong> if you subscribe to the blog newsletter, we store your email. You can unsubscribe at any time via the link in any email.</p>
        </Section>

        <Section title="3. How we use your data">
          <ul className="list-disc pl-5 space-y-2">
            <li>To provide and operate the InariWatch service.</li>
            <li>To send transactional emails (password reset, workspace invites, alert notifications).</li>
            <li>To send blog updates if you opted in.</li>
            <li>To debug errors and improve reliability.</li>
            <li>To detect and prevent abuse (rate limiting, audit logs).</li>
          </ul>
          <p className="mt-3">We do not sell your data. We do not use your data for advertising. We have no analytics or behavioral tracking on our website.</p>
        </Section>

        <Section title="4. Third-party services">
          <ul className="list-disc pl-5 space-y-2">
            <li><strong>Neon</strong> — PostgreSQL database hosting. All your data is stored here.</li>
            <li><strong>Vercel</strong> — application hosting and edge functions.</li>
            <li><strong>Resend</strong> — transactional email delivery.</li>
            <li><strong>AI providers</strong> — when you use AI features, requests are sent to the provider whose key you configured (Anthropic, OpenAI, Google, xAI/Grok, DeepSeek). We do not store AI responses beyond what is shown in the app.</li>
            <li><strong>GitHub / Google / GitLab</strong> — optional OAuth sign-in. We only store the provider account ID, email, and name returned by the provider.</li>
            <li><strong>Telegram / Slack</strong> — if you configure these as notification channels, alert data is sent to your Telegram bot or Slack webhook.</li>
          </ul>
        </Section>

        <Section title="5. Cookies">
          <p>
            We use one session cookie (<code className="text-xs bg-zinc-800 px-1 py-0.5 rounded">next-auth.session-token</code>) to keep you logged in. It expires after 30 days. We do not use advertising cookies, tracking cookies, or third-party analytics cookies.
          </p>
        </Section>

        <Section title="6. Data retention">
          <p>
            We retain your account and alert data for as long as your account is active.
            If you delete your account, your data is deleted within 30 days.
            You can request deletion at any time by emailing{" "}
            <a href="mailto:info@jesusbr.com" className="text-inari-accent hover:underline">info@jesusbr.com</a>.
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

        <Section title="8. Self-hosting">
          <p>
            InariWatch is MIT-licensed open source software. If you self-host InariWatch, you are responsible
            for your own data handling and privacy compliance. This policy applies only to the hosted service at inariwatch.com.
          </p>
        </Section>

        <Section title="9. Your rights">
          <p>
            You have the right to access, correct, export, or delete your personal data at any time.
            To exercise these rights, contact us at{" "}
            <a href="mailto:info@jesusbr.com" className="text-inari-accent hover:underline">info@jesusbr.com</a>{" "}
            or delete your account directly from Settings.
          </p>
        </Section>

        <Section title="10. Changes to this policy">
          <p>
            We may update this policy occasionally. We will notify registered users by email of any
            material changes. Continued use of the service after changes constitutes acceptance.
          </p>
        </Section>

        <Section title="11. Contact">
          <p>
            Questions? Email us at{" "}
            <a href="mailto:info@jesusbr.com" className="text-inari-accent hover:underline">info@jesusbr.com</a>.
          </p>
        </Section>

        <div className="mt-12 pt-8 border-t border-line flex gap-6 text-sm text-zinc-500">
          <Link href="/terms" className="hover:text-fg-base transition-colors">Terms of Service</Link>
          <Link href="/" className="hover:text-fg-base transition-colors">Home</Link>
        </div>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold text-fg-strong mb-3">{title}</h2>
      <div className="text-zinc-400 leading-relaxed space-y-2">{children}</div>
    </section>
  );
}
