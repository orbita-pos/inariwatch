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
            InariWatch is a free developer monitoring platform. We provide it as-is and may change,
            suspend, or discontinue any part of it at any time with reasonable notice.
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
            <li>Use the Service for illegal purposes or to violate any laws.</li>
            <li>Attempt to gain unauthorized access to any systems or accounts.</li>
            <li>Abuse, harass, or harm other users.</li>
            <li>Use the Service to send spam or unsolicited messages.</li>
            <li>Reverse engineer or attempt to extract the source code of the Service (the CLI is open source under MIT — that is explicitly permitted).</li>
          </ul>
        </Section>

        <Section title="5. Your data and integrations">
          <p>
            You retain ownership of all data you bring into InariWatch — alert payloads, integration tokens,
            and AI keys are yours. By using the Service, you grant us a limited license to store and process
            that data solely to provide the Service to you.
          </p>
          <p className="mt-2">
            You are responsible for ensuring you have the right to connect any third-party service (GitHub,
            Vercel, Sentry, etc.) to InariWatch.
          </p>
        </Section>

        <Section title="6. AI features">
          <p>
            InariWatch uses AI models (via your own API keys) to analyze alerts and suggest remediations.
            AI-generated content may be inaccurate. You are solely responsible for any action you take
            based on AI suggestions, including code changes, merges, or infrastructure modifications.
          </p>
        </Section>

        <Section title="7. Open source CLI">
          <p>
            The InariWatch CLI is released under the MIT License. Your use of the CLI is governed by that
            license in addition to these Terms where applicable.
          </p>
        </Section>

        <Section title="8. Disclaimer of warranties">
          <p>
            The Service is provided &quot;as is&quot; without warranty of any kind. We do not guarantee uptime,
            accuracy of alerts, or fitness for any particular purpose. Use it at your own risk.
          </p>
        </Section>

        <Section title="9. Limitation of liability">
          <p>
            To the maximum extent permitted by law, we are not liable for any indirect, incidental,
            special, or consequential damages arising from your use of the Service, including data loss,
            production incidents, or decisions made based on AI-generated content.
          </p>
        </Section>

        <Section title="10. Termination">
          <p>
            You can delete your account at any time from Settings. We may suspend or terminate accounts
            that violate these Terms. Upon termination, your data will be deleted within 30 days.
          </p>
        </Section>

        <Section title="11. Changes to these terms">
          <p>
            We may update these Terms. We will notify users by email of material changes at least 14 days
            in advance. Continued use after changes take effect constitutes acceptance.
          </p>
        </Section>

        <Section title="12. Governing law">
          <p>
            These Terms are governed by the laws of Mexico. Any disputes shall be resolved in the courts
            of Mexico City, Mexico.
          </p>
        </Section>

        <Section title="13. Contact">
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
