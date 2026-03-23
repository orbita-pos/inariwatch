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
            and <a href="https://app.inariwatch.com" className="text-inari-accent hover:underline">app.inariwatch.com</a>,
            how we use it, and your rights regarding it.
          </p>
        </Section>

        <Section title="2. Data we collect">
          <ul className="list-disc pl-5 space-y-2">
            <li><strong>Account data:</strong> your name and email address when you register.</li>
            <li><strong>Alert and integration data:</strong> webhook payloads and API responses from services you connect (GitHub, Vercel, Sentry, Datadog, etc.).</li>
            <li><strong>AI API keys:</strong> keys you provide under Settings are stored encrypted and used only to make requests on your behalf. We never share them.</li>
            <li><strong>Usage data:</strong> basic logs (errors, request counts) for debugging and reliability. No behavioral tracking or analytics cookies.</li>
            <li><strong>Email subscription:</strong> if you subscribe to the blog newsletter, we store your email to send updates. You can unsubscribe at any time.</li>
          </ul>
        </Section>

        <Section title="3. How we use your data">
          <ul className="list-disc pl-5 space-y-2">
            <li>To provide and operate the InariWatch service.</li>
            <li>To send transactional emails (password reset, workspace invites).</li>
            <li>To send blog updates if you opted in.</li>
            <li>To debug errors and improve reliability.</li>
          </ul>
          <p className="mt-3">We do not sell your data. We do not use your data for advertising.</p>
        </Section>

        <Section title="4. Third-party services">
          <ul className="list-disc pl-5 space-y-2">
            <li><strong>Neon</strong> — PostgreSQL database hosting (your data is stored here).</li>
            <li><strong>Vercel</strong> — application hosting and edge functions.</li>
            <li><strong>Resend</strong> — transactional email delivery.</li>
            <li><strong>AI providers</strong> — requests are sent to the provider whose key you configured (Anthropic, OpenAI, Google, xAI, Mistral). We do not store AI responses beyond your session.</li>
          </ul>
        </Section>

        <Section title="5. Data retention">
          <p>
            We retain your account and alert data for as long as your account is active.
            If you delete your account, your data is deleted within 30 days.
            You can request deletion at any time by emailing{" "}
            <a href="mailto:info@jesusbr.com" className="text-inari-accent hover:underline">info@jesusbr.com</a>.
          </p>
        </Section>

        <Section title="6. Security">
          <p>
            We use HTTPS for all connections, bcrypt for password hashing, encrypted storage for API keys,
            and rate limiting on all authentication endpoints. No system is 100% secure — if you discover
            a vulnerability, please report it to{" "}
            <a href="mailto:info@jesusbr.com" className="text-inari-accent hover:underline">info@jesusbr.com</a>.
          </p>
        </Section>

        <Section title="7. Your rights">
          <p>
            You have the right to access, correct, or delete your personal data at any time.
            To exercise these rights, contact us at{" "}
            <a href="mailto:info@jesusbr.com" className="text-inari-accent hover:underline">info@jesusbr.com</a>.
          </p>
        </Section>

        <Section title="8. Changes to this policy">
          <p>
            We may update this policy occasionally. We will notify registered users by email of any
            material changes. Continued use of the service after changes constitutes acceptance.
          </p>
        </Section>

        <Section title="9. Contact">
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
