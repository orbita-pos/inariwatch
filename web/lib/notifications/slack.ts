const SLACK_WEBHOOK_PREFIX = "https://hooks.slack.com/";

interface SlackConfig {
  webhook_url: string;
}

export async function sendSlack(
  config: SlackConfig,
  message: string
): Promise<{ ok: boolean; error?: string }> {
  if (!config.webhook_url.startsWith(SLACK_WEBHOOK_PREFIX)) {
    return { ok: false, error: "Invalid Slack webhook URL." };
  }

  try {
    const res = await fetch(config.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: body || `Slack API ${res.status}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function verifySlackWebhook(
  webhookUrl: string
): Promise<{ ok: boolean; error?: string }> {
  if (!webhookUrl.startsWith(SLACK_WEBHOOK_PREFIX)) {
    return { ok: false, error: "URL must start with https://hooks.slack.com/" };
  }

  return sendSlack(
    { webhook_url: webhookUrl },
    "InariWatch connected! You'll receive alerts here."
  );
}
