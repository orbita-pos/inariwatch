/**
 * Billing email templates — sent on Pro upgrade, renewal, payment failure.
 */

import { sendEmail } from "./email";

const APP_URL = process.env.NEXTAUTH_URL ?? process.env.APP_URL ?? "https://app.inariwatch.com";

// Defense-in-depth: all interpolated values come from Stripe / our DB, not
// raw user input, but an escape helper is cheap insurance against a future
// template or data-source change.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const wrapper = (title: string, body: string) => `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width" />
    <title>${title}</title>
  </head>
  <body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e5e5e5;">
    <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
      <div style="text-align:center;margin-bottom:32px;">
        <span style="font-family:monospace;font-size:14px;font-weight:600;letter-spacing:3px;color:#f59e0b;text-transform:uppercase;">INARIWATCH</span>
      </div>
      <div style="background:#171717;border:1px solid #262626;border-radius:12px;padding:32px;">
        ${body}
      </div>
      <div style="text-align:center;margin-top:24px;font-size:12px;color:#525252;">
        InariWatch — AI-powered monitoring &amp; remediation
      </div>
    </div>
  </body>
</html>
`;

/**
 * Welcome email when user upgrades to Pro.
 */
export async function sendProWelcomeEmail(
  email: string,
  options: {
    interval: "monthly" | "annual";
    nextBillingDate: Date;
  }
): Promise<void> {
  const intervalLabel = options.interval === "annual" ? "$120/year" : "$12/month";
  const renewalDate = options.nextBillingDate.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const body = `
    <h1 style="margin:0 0 16px;font-size:22px;color:#fafafa;">Welcome to Pro 🎉</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#a3a3a3;">
      Thanks for upgrading to InariWatch Pro. You now have <strong style="color:#fafafa;">10x more AI usage</strong>
      across all features.
    </p>

    <div style="background:#0a0a0a;border:1px solid #262626;border-radius:8px;padding:16px;margin:20px 0;">
      <div style="font-size:11px;color:#525252;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">
        Your new monthly quotas
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:6px 0;color:#a3a3a3;">Auto-analyses</td><td style="padding:6px 0;text-align:right;color:#fafafa;font-family:monospace;">3,000/mo</td></tr>
        <tr><td style="padding:6px 0;color:#a3a3a3;">AI Remediations</td><td style="padding:6px 0;text-align:right;color:#fafafa;font-family:monospace;">25/mo</td></tr>
        <tr><td style="padding:6px 0;color:#a3a3a3;">Ask Inari</td><td style="padding:6px 0;text-align:right;color:#fafafa;font-family:monospace;">500/mo</td></tr>
        <tr><td style="padding:6px 0;color:#a3a3a3;">PR Predictions</td><td style="padding:6px 0;text-align:right;color:#fafafa;font-family:monospace;">30/mo</td></tr>
        <tr><td style="padding:6px 0;color:#a3a3a3;">AI Postmortems</td><td style="padding:6px 0;text-align:right;color:#fafafa;font-family:monospace;">50/mo</td></tr>
      </table>
    </div>

    <div style="font-size:13px;color:#525252;margin:20px 0;line-height:1.6;">
      <strong style="color:#a3a3a3;">Plan:</strong> ${escapeHtml(intervalLabel)}<br/>
      <strong style="color:#a3a3a3;">Next billing date:</strong> ${escapeHtml(renewalDate)}
    </div>

    <div style="text-align:center;margin:24px 0;">
      <a href="${APP_URL}/analytics/ai-usage" style="display:inline-block;background:#f59e0b;color:#0a0a0a;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">
        View your AI usage →
      </a>
    </div>

    <p style="margin:20px 0 0;font-size:13px;color:#525252;line-height:1.6;">
      Questions? Reply to this email — I read every message.<br/>
      <span style="color:#737373;">— Jesus, founder of InariWatch</span>
    </p>
  `;

  await sendEmail({ email }, "Welcome to InariWatch Pro 🎉", wrapper("Welcome to Pro", body));
}

/**
 * Renewal confirmation — sent monthly/annually after successful payment.
 */
export async function sendRenewalEmail(
  email: string,
  options: {
    amount: number; // in cents
    nextBillingDate: Date;
    invoiceUrl?: string;
  }
): Promise<void> {
  const renewalDate = options.nextBillingDate.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const amountStr = `$${(options.amount / 100).toFixed(2)}`;

  const body = `
    <h1 style="margin:0 0 16px;font-size:20px;color:#fafafa;">Subscription renewed</h1>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#a3a3a3;">
      Your InariWatch Pro subscription was renewed for <strong style="color:#fafafa;">${escapeHtml(amountStr)}</strong>.
      Your next billing date is <strong style="color:#fafafa;">${escapeHtml(renewalDate)}</strong>.
    </p>

    ${options.invoiceUrl ? `
    <div style="text-align:center;margin:24px 0;">
      <a href="${escapeHtml(options.invoiceUrl)}" style="display:inline-block;background:transparent;color:#f59e0b;padding:10px 20px;border:1px solid #f59e0b;border-radius:8px;text-decoration:none;font-weight:500;font-size:13px;">
        Download invoice
      </a>
    </div>
    ` : ""}

    <p style="margin:20px 0 0;font-size:12px;color:#525252;line-height:1.6;">
      Manage your subscription at <a href="${APP_URL}/settings" style="color:#737373;">${APP_URL}/settings</a>
    </p>
  `;

  await sendEmail({ email }, "InariWatch Pro renewed", wrapper("Subscription renewed", body));
}

/**
 * Payment failed notification.
 */
export async function sendPaymentFailedEmail(
  email: string,
  options: { updateUrl?: string }
): Promise<void> {
  const body = `
    <h1 style="margin:0 0 16px;font-size:20px;color:#ef4444;">⚠️ Payment failed</h1>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#a3a3a3;">
      We couldn&apos;t process your latest InariWatch Pro payment. Your account is still active for now,
      but you&apos;ll be downgraded to Free if we can&apos;t collect payment in the next few days.
    </p>

    <div style="text-align:center;margin:24px 0;">
      <a href="${escapeHtml(options.updateUrl ?? `${APP_URL}/settings`)}" style="display:inline-block;background:#ef4444;color:#fafafa;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">
        Update payment method
      </a>
    </div>

    <p style="margin:20px 0 0;font-size:13px;color:#525252;line-height:1.6;">
      Need help? Reply to this email and we&apos;ll sort it out.
    </p>
  `;

  await sendEmail({ email }, "InariWatch — payment failed", wrapper("Payment failed", body));
}

/**
 * Subscription canceled (downgrade) confirmation.
 */
export async function sendSubscriptionCanceledEmail(
  email: string,
  options: { effectiveDate: Date }
): Promise<void> {
  const dateStr = options.effectiveDate.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const body = `
    <h1 style="margin:0 0 16px;font-size:20px;color:#fafafa;">Subscription canceled</h1>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#a3a3a3;">
      Your InariWatch Pro subscription has been canceled. You&apos;ll keep Pro access until
      <strong style="color:#fafafa;">${escapeHtml(dateStr)}</strong>, then your account will revert to the Free plan.
    </p>

    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#a3a3a3;">
      Your data and projects stay intact — only the AI quotas change. You can resubscribe anytime.
    </p>

    <div style="text-align:center;margin:24px 0;">
      <a href="${APP_URL}/pricing" style="display:inline-block;background:transparent;color:#f59e0b;padding:10px 20px;border:1px solid #f59e0b;border-radius:8px;text-decoration:none;font-weight:500;font-size:13px;">
        Resubscribe
      </a>
    </div>

    <p style="margin:20px 0 0;font-size:13px;color:#525252;line-height:1.6;">
      We&apos;d love to know what we could do better. Reply to this email — every message reaches me directly.<br/>
      <span style="color:#737373;">— Jesus</span>
    </p>
  `;

  await sendEmail({ email }, "InariWatch Pro canceled", wrapper("Subscription canceled", body));
}
