const TELEGRAM_API = "https://api.telegram.org/bot";

interface TelegramConfig {
  bot_token: string;
  chat_id: string;
}

export async function sendTelegram(
  config: TelegramConfig,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${TELEGRAM_API}${config.bot_token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chat_id,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.description ?? `Telegram API ${res.status}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function verifyTelegramBot(
  botToken: string
): Promise<{ ok: boolean; botName?: string; error?: string }> {
  try {
    const res = await fetch(`${TELEGRAM_API}${botToken}/getMe`);
    if (!res.ok) return { ok: false, error: "Invalid bot token." };
    const data = await res.json();
    return { ok: true, botName: data.result?.username };
  } catch {
    return { ok: false, error: "Could not reach Telegram API." };
  }
}

export async function detectChatId(
  botToken: string
): Promise<{ chatId?: string; error?: string }> {
  try {
    const res = await fetch(`${TELEGRAM_API}${botToken}/getUpdates?limit=5`);
    if (!res.ok) return { error: "Could not fetch updates from Telegram." };
    const data = await res.json();

    // Find the most recent message with a chat id
    const updates = data.result ?? [];
    for (const update of updates.reverse()) {
      const chatId =
        update.message?.chat?.id ?? update.my_chat_member?.chat?.id;
      if (chatId) return { chatId: String(chatId) };
    }

    return { error: "No messages found. Send /start to your bot first, then try again." };
  } catch {
    return { error: "Could not reach Telegram API." };
  }
}
