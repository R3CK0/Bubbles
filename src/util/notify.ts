/**
 * util/notify.ts — best-effort push notifications via a Telegram bot.
 *
 * Configured through TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (see config.ts);
 * a no-op when either is missing. Every send is fire-and-forget and swallows
 * its own errors, so a notification failure can never break the caller (a
 * sync, a job) that triggered it.
 */
import { config } from "../config.js";

export function isNotifyEnabled(): boolean {
  return config.telegram.botToken.length > 0 && config.telegram.chatId.length > 0;
}

/** Send a Telegram message. Resolves to whether it was delivered; never throws. */
export async function notify(text: string): Promise<boolean> {
  if (!isNotifyEnabled()) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      // Telegram returns a JSON body with a human-readable `description`
      // (e.g. "chat not found", "bot was blocked by the user") — surface it.
      const detail = await res.json().then((b) => (b as { description?: string }).description).catch(() => undefined);
      console.warn(`[notify] Telegram sendMessage failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[notify] Telegram send error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Notify about one or more bank-sync failures. No-op when the list is empty. */
export async function notifySyncFailure(failures: { institution: string; error: string }[]): Promise<void> {
  if (failures.length === 0 || !isNotifyEnabled()) return;
  const lines = failures.map((f) => `• <b>${escapeHtml(f.institution)}</b>: ${escapeHtml(f.error)}`);
  await notify(`🔴 <b>Bubbles</b> — bank sync failed\n${lines.join("\n")}`);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
