import { MarketingNav } from "../marketing-nav";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service — InariWatch",
  description: "Terms and conditions for using InariWatch.",
};

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-inari-bg text-fg-base">
      <MarketingNav opaque />
      <main className="mx-auto max-w-3xl px-6 pt-28 pb-24">
        <h1 className="text-3xl font-bold text-fg-strong mb-2">Terms of Service</h1>
        <p className="text-sm text-zinc-500 mb-10">Last updated: March 23, 2025</p>

        <Section title="1. Acceptance">
          <p>
            By creating an account or using InariWatch (&quot;the Service&quot;), you agree to these Terms.
            If you do not agree, do not use the Service. The Service is operated by Jesus Bernal (&quot;we&quot;, &quot;us&quot;).
          </p>
        </Section>

        <Section title="2. The Service">
          <p>
            InariWatch is a free, open source developer monitoring platform available at inariwatch.com.
            We provide it as-is and may change, suspend, or discontinue any part of it at any time
            with reasonable notice. The source code is available at{" "}
            <a href="https://github.com/orbita-pos/inariwatch" target="_blank" rel="noreferrer" className="text-inari-accent hover:underline">
              github.com/orbita-pos/inariwatch
            </a>{" "}
            under the MIT License.
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
            <li>Circumvent rate limits or security measures.</li>
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
            (GitHub, Vercel, Sentry, Datadog, etc.) to InariWatch. Alert data may include stack traces,
            error messages, and deployment logs — ensure you are authorized to share this data with our service.
          </p>
        </Section>

        <Section title="6. AI features">
          <p>
            InariWatch uses AI models via API keys you provide (Anthropic, OpenAI, Google, xAI/Grok, DeepSeek)
            to analyze alerts and suggest remediations. You are responsible for complying with the terms of
            service of your chosen AI provider.
          </p>
          <p className="mt-2">
            AI-generated content may be inaccurate or incomplete. You are solely responsible for any action
            you take based on AI suggestions, including code changes, merges, deployments, or infrastructure
            modifications. We are not liable for any damage caused by acting on AI-generated recommendations.
          </p>
        </Section>

        <Section title="7. Open source and self-hosting">
          <p>
            The InariWatch web app, CLI, and desktop app are released under the MIT License. You are free
            to self-host, modify, and distribute the software under that license. Your use of the self-hosted
            version is governed by the MIT License. This Terms of Service applies only to the hosted service
            at inariwatch.com.
          </p>
        </Section>

        <Section title="8. Notifications">
          <p>
            By configuring notification channels (email, Telegram, Slack, push), you consent to receiving
            alert notifications through those channels. You can disable or remove any channel at any time
            from Settings. Email notifications include an unsubscribe option in every message.
          </p>
        </Section>

        <Section title="9. Disclaimer of warranties">
          <p>
            The Service is provided &quot;as is&quot; without warranty of any kind. We do not guarantee uptime,
            accuracy of alerts, correctness of AI-generated content, or fitness for any particular purpose —
            including production monitoring. Use it at your own risk and maintain your own independent
            monitoring for critical systems.
          </p>
        </Section>

        <Section title="10. Limitation of liability">
          <p>
            To the maximum extent permitted by law, we are not liable for any indirect, incidental, special,
            or consequential damages arising from your use of the Service, including data loss, production
            incidents, missed alerts, or decisions made based on AI-generated content.
          </p>
        </Section>

        <Section title="11. Termination">
          <p>
            You can delete your account at any time from Settings. We may suspend or terminate accounts
            that violate these Terms. Upon termination, your data will be deleted within 30 days.
          </p>
        </Section>

        <Section title="12. Changes to these terms">
          <p>
            We may update these Terms. We will notify users by email of material changes at least 14 days
            in advance. Continued use after changes take effect constitutes acceptance.
          </p>
        </Section>

        <Section title="13. Governing law">
          <p>
            These Terms are governed by the laws of Mexico. Any disputes shall be resolved in the courts
            of Mexico City, Mexico.
          </p>
        </Section>

        <Section title="14. Contact">
          <p>
            Questions about these Terms?{" "}
            <a href="mailto:info@jesusbr.com" className="text-inari-accent hover:underline">info@jesusbr.com</a>
          </p>
        </Section>

        <div className="mt-12 pt-8 border-t border-line flex gap-6 text-sm text-zinc-500">
          <Link href="/privacy" className="hover:text-fg-base transition-colors">Privacy Policy</Link>
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
