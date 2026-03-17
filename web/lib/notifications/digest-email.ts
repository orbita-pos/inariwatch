const APP_URL = process.env.NEXTAUTH_URL ?? "https://inariwatch.com";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Batch digest (sent every ~5 min for non-critical email alerts) ───────────

interface BatchAlert {
  id: string;
  title: string;
  severity: string;
  project: string;
  createdAt: Date;
}

const SEVERITY_DOT: Record<string, string> = {
  critical: "#e63946",
  warning: "#eab308",
  info: "#3b82f6",
};

export function formatBatchDigestEmail(
  alerts: BatchAlert[],
  unsubscribeUrl: string,
  trackingLogId: string
): string {
  const openPixelUrl = `${APP_URL}/api/notifications/track/open?id=${trackingLogId}`;
  const dashboardUrl = `${APP_URL}/api/notifications/track/click?id=${trackingLogId}&url=${encodeURIComponent(`${APP_URL}/alerts`)}`;

  const alertRows = alerts
    .sort((a, b) => {
      const p: Record<string, number> = { critical: 0, warning: 1, info: 2 };
      return (p[a.severity] ?? 1) - (p[b.severity] ?? 1);
    })
    .map((a) => {
      const color = SEVERITY_DOT[a.severity] ?? "#71717a";
      const time = new Date(a.createdAt).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const alertUrl = `${APP_URL}/alerts/${a.id}`;
      return `
        <tr>
          <td style="padding: 10px 0; border-bottom: 1px solid #1e1e22;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="8" style="padding-right: 12px; vertical-align: top;">
                  <div style="width: 8px; height: 8px; border-radius: 50%; background-color: ${color}; margin-top: 6px;"></div>
                </td>
                <td style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
                  <a href="${alertUrl}" style="font-size: 13px; color: #d4d4d8; text-decoration: none; line-height: 1.4;">${escapeHtml(a.title)}</a>
                  <div style="font-size: 11px; color: #52525b; margin-top: 2px;">${escapeHtml(a.project)}</div>
                </td>
                <td width="50" align="right" style="font-size: 11px; color: #52525b; white-space: nowrap; vertical-align: top; padding-top: 2px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
                  ${time}
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
    })
    .join("");

  const critCount = alerts.filter((a) => a.severity === "critical").length;
  const warnCount = alerts.filter((a) => a.severity === "warning").length;
  const infoCount = alerts.filter((a) => a.severity === "info").length;

  const statParts: string[] = [];
  if (critCount > 0) statParts.push(`<span style="color: #e63946; font-weight: 600;">${critCount} critical</span>`);
  if (warnCount > 0) statParts.push(`<span style="color: #eab308;">${warnCount} warning</span>`);
  if (infoCount > 0) statParts.push(`<span style="color: #3b82f6;">${infoCount} info</span>`);
  const statsLine = statParts.join(" &nbsp;&middot;&nbsp; ");

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${alerts.length} new alerts</title>
</head>
<body style="margin: 0; padding: 0; background-color: #09090b; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #09090b;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width: 560px; width: 100%;">

          <!-- Header -->
          <tr>
            <td align="center" style="padding-bottom: 28px;">
              <span style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 22px; font-weight: 700; letter-spacing: 4px; color: #e63946;">INARIWATCH</span>
            </td>
          </tr>

          <!-- Title -->
          <tr>
            <td align="center" style="padding-bottom: 8px;">
              <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 18px; font-weight: 600; color: #fafafa; margin: 0;">${alerts.length} new alert${alerts.length > 1 ? "s" : ""}</p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-bottom: 24px;">
              <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; color: #71717a; margin: 0;">${statsLine}</p>
            </td>
          </tr>

          <!-- Alert list -->
          <tr>
            <td>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #18181b; border-radius: 12px;">
                <tr>
                  <td style="padding: 20px 24px 8px 24px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      ${alertRows}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA Button -->
          <tr>
            <td align="center" style="padding: 28px 0 0 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="background-color: #e63946; border-radius: 24px;">
                    <a href="${dashboardUrl}" target="_blank" style="display: inline-block; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 600; color: #ffffff; padding: 12px 32px; text-decoration: none;">View all alerts</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 36px 0 0 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="border-top: 1px solid #1e1e22; padding-top: 24px; text-align: center;">
                    <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; color: #3f3f46; margin: 0 0 6px 0;">
                      <span style="color: #e63946; font-weight: 600; letter-spacing: 1px;">INARIWATCH</span> &mdash; Proactive developer monitoring
                    </p>
                    <a href="${unsubscribeUrl}" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; color: #52525b; text-decoration: underline;">
                      Unsubscribe from email alerts
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
        <img src="${openPixelUrl}" width="1" height="1" alt="" style="display: block; width: 1px; height: 1px; border: 0;" />
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Weekly digest ────────────────────────────────────────────────────────────

interface DigestStats {
  total: number;
  critical: number;
  resolved: number;
  unresolved: number;
}

interface DigestAlert {
  title: string;
  severity: string;
  createdAt: Date;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: "#e63946",
  warning: "#eab308",
  info: "#3b82f6",
};

export function formatWeeklyDigestEmail(
  stats: DigestStats,
  topAlerts: DigestAlert[],
  unsubscribeUrl: string,
  aiSummary?: string
): string {
  const dashboardUrl = `${APP_URL}/dashboard`;

  const alertRows = topAlerts
    .map((a) => {
      const color = SEVERITY_COLOR[a.severity] ?? "#71717a";
      const time = new Date(a.createdAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      return `
        <tr>
          <td style="padding: 10px 0; border-bottom: 1px solid #1e1e22;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="8" style="padding-right: 12px; vertical-align: top;">
                  <div style="width: 8px; height: 8px; border-radius: 50%; background-color: ${color}; margin-top: 6px;"></div>
                </td>
                <td style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; color: #d4d4d8; line-height: 1.4;">
                  ${escapeHtml(a.title)}
                </td>
                <td width="70" align="right" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; color: #52525b; white-space: nowrap; vertical-align: top; padding-top: 2px;">
                  ${time}
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>Your weekly InariWatch digest</title>
  <!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
</head>
<body style="margin: 0; padding: 0; background-color: #09090b; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #09090b;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width: 560px; width: 100%;">

          <!-- Header -->
          <tr>
            <td align="center" style="padding-bottom: 32px;">
              <span style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 22px; font-weight: 700; letter-spacing: 4px; color: #e63946;">INARIWATCH</span>
            </td>
          </tr>

          <!-- Title -->
          <tr>
            <td align="center" style="padding-bottom: 28px;">
              <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 20px; font-weight: 600; color: #fafafa; margin: 0 0 6px 0;">Your weekly InariWatch digest</p>
              <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; color: #52525b; margin: 0;">Here&rsquo;s a summary of the past 7 days.</p>
            </td>
          </tr>

          <!-- AI Summary -->
          ${aiSummary ? `<tr>
            <td style="padding: 0 0 24px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #18181b; border-radius: 12px; border: 1px solid #3f2c6b;">
                <tr>
                  <td style="padding: 20px 24px;">
                    <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; font-weight: 600; color: #e63946; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 10px 0;">✦ AI Summary</p>
                    <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; color: #a1a1aa; line-height: 1.6; margin: 0;">${escapeHtml(aiSummary)}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>` : ""}

          <!-- Stats cards -->
          <tr>
            <td style="padding: 0 0 24px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td width="25%" style="padding: 0 4px 0 0;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #18181b; border-radius: 10px;">
                      <tr>
                        <td align="center" style="padding: 16px 8px;">
                          <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 24px; font-weight: 700; color: #fafafa; margin: 0;">${stats.total}</p>
                          <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; color: #52525b; margin: 4px 0 0 0; text-transform: uppercase; letter-spacing: 0.5px;">Total</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td width="25%" style="padding: 0 4px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #18181b; border-radius: 10px;">
                      <tr>
                        <td align="center" style="padding: 16px 8px;">
                          <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 24px; font-weight: 700; color: #e63946; margin: 0;">${stats.critical}</p>
                          <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; color: #52525b; margin: 4px 0 0 0; text-transform: uppercase; letter-spacing: 0.5px;">Critical</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td width="25%" style="padding: 0 4px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #18181b; border-radius: 10px;">
                      <tr>
                        <td align="center" style="padding: 16px 8px;">
                          <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 24px; font-weight: 700; color: #22c55e; margin: 0;">${stats.resolved}</p>
                          <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; color: #52525b; margin: 4px 0 0 0; text-transform: uppercase; letter-spacing: 0.5px;">Resolved</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td width="25%" style="padding: 0 0 0 4px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #18181b; border-radius: 10px;">
                      <tr>
                        <td align="center" style="padding: 16px 8px;">
                          <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 24px; font-weight: 700; color: #eab308; margin: 0;">${stats.unresolved}</p>
                          <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; color: #52525b; margin: 4px 0 0 0; text-transform: uppercase; letter-spacing: 0.5px;">Open</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Top alerts -->
          ${
            topAlerts.length > 0
              ? `<tr>
            <td style="padding: 0 0 24px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #18181b; border-radius: 12px;">
                <tr>
                  <td style="padding: 20px 24px 8px 24px;">
                    <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; font-weight: 600; color: #71717a; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 12px 0;">Recent alerts</p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      ${alertRows}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`
              : ""
          }

          <!-- CTA Button -->
          <tr>
            <td align="center" style="padding: 4px 0 0 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="background-color: #e63946; border-radius: 24px;">
                    <a href="${dashboardUrl}" target="_blank" style="display: inline-block; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 600; color: #ffffff; padding: 12px 32px; text-decoration: none;">View Dashboard</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 36px 0 0 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="border-top: 1px solid #1e1e22; padding-top: 24px; text-align: center;">
                    <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; color: #3f3f46; margin: 0 0 6px 0;">
                      <span style="color: #e63946; font-weight: 600; letter-spacing: 1px;">INARIWATCH</span> &nbsp;&mdash;&nbsp; Proactive developer monitoring
                    </p>
                    <a href="${unsubscribeUrl}" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; color: #52525b; text-decoration: underline;">
                      Unsubscribe from weekly digests
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
