import nodemailer from "nodemailer";

interface EmailConfig {
  email: string;
}

// Lazy-initialized transporter — created once on first use
let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST ?? "smtp.gmail.com",
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === "true", // true for 465, false for 587
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return transporter;
}

const FROM_EMAIL = process.env.SMTP_FROM ?? "InariWatch <alerts@inariwatch.com>";

export async function sendEmail(
  config: EmailConfig,
  subject: string,
  html: string,
  options?: { unsubscribeUrl?: string }
): Promise<{ ok: boolean; error?: string }> {
  try {
    const headers: Record<string, string> = {};
    if (options?.unsubscribeUrl) {
      // RFC 8058 one-click unsubscribe header — respected by Gmail, Yahoo, etc.
      headers["List-Unsubscribe"] = `<${options.unsubscribeUrl}>`;
      headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    }

    await getTransporter().sendMail({
      from: FROM_EMAIL,
      to: config.email,
      subject,
      html,
      headers,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendVerificationEmail(
  email: string,
  code: string
): Promise<{ ok: boolean; error?: string }> {
  return sendEmail(
    { email },
    "InariWatch — Verify your email",
    `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="color: #fff; font-size: 18px; margin-bottom: 16px;">Verify your email for InariWatch</h2>
      <p style="color: #a1a1aa; font-size: 14px; line-height: 1.6;">
        Enter this code in your InariWatch settings to verify your email notifications:
      </p>
      <div style="background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 16px; text-align: center; margin: 24px 0;">
        <span style="font-family: monospace; font-size: 28px; font-weight: bold; letter-spacing: 6px; color: #7C3AED;">${code}</span>
      </div>
      <p style="color: #52525b; font-size: 12px;">
        If you didn't request this, you can safely ignore this email.
      </p>
    </div>
    `
  );
}
