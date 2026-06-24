/**
 * Telegram Bot API client — send, edit, answer callbacks.
 */

const BASE = "https://api.telegram.org/bot";

export async function sendMessage(
  botToken: string,
  chatId: string,
  text: string,
  opts?: { reply_markup?: unknown; parse_mode?: string; reply_to_message_id?: number }
): Promise<{ ok: boolean; result?: { message_id: number } }> {
  const resp = await fetch(`${BASE}${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 4096),
      parse_mode: opts?.parse_mode ?? "HTML",
      reply_markup: opts?.reply_markup,
      reply_to_message_id: opts?.reply_to_message_id,
    }),
  });
  return resp.json();
}

export async function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  text?: string
): Promise<void> {
  await fetch(`${BASE}${botToken}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text?.slice(0, 200),
    }),
  });
}

export async function setWebhook(
  botToken: string,
  url: string,
  secretToken: string
): Promise<boolean> {
  const resp = await fetch(`${BASE}${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, secret_token: secretToken }),
  });
  const data = await resp.json();
  return data.ok === true;
}
