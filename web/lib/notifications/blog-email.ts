import { sendEmail } from "./email";
import { db, blogSubscribers } from "@/lib/db";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://inariwatch.com";

export async function sendNewPostNotification(post: {
  title: string;
  description: string;
  slug: string;
  tag: string;
}): Promise<{ sent: number; failed: number }> {
  const subscribers = await db.select().from(blogSubscribers);

  let sent = 0;
  let failed = 0;

  const postUrl = `${BASE_URL}/blog/${post.slug}`;

  for (const sub of subscribers) {
    const unsubscribeUrl = `${BASE_URL}/api/unsubscribe?token=${sub.unsubscribeToken}`;

    const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;background:#09090b;color:#a1a1aa">
  <div style="margin-bottom:32px">
    <span style="font-family:monospace;font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#7C3AED">InariWatch Blog</span>
  </div>

  <div style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:28px;margin-bottom:24px">
    <span style="display:inline-block;font-family:monospace;font-size:11px;color:#7C3AED;background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.2);border-radius:20px;padding:3px 10px;margin-bottom:16px">${post.tag}</span>
    <h1 style="color:#ffffff;font-size:20px;font-weight:700;line-height:1.3;margin:0 0 12px">${post.title}</h1>
    <p style="font-size:14px;line-height:1.6;margin:0 0 24px;color:#a1a1aa">${post.description}</p>
    <a href="${postUrl}" style="display:inline-block;background:#7C3AED;color:#ffffff;font-size:14px;font-weight:600;padding:10px 22px;border-radius:8px;text-decoration:none">Read post →</a>
  </div>

  <p style="font-size:12px;color:#3f3f46;line-height:1.6">
    You're receiving this because you subscribed to InariWatch blog updates.<br>
    <a href="${unsubscribeUrl}" style="color:#52525b;text-decoration:underline">Unsubscribe</a>
  </p>
</div>`;

    const result = await sendEmail(
      { email: sub.email },
      `New post: ${post.title}`,
      html,
      { unsubscribeUrl }
    );

    if (result.ok) sent++;
    else failed++;
  }

  return { sent, failed };
}
