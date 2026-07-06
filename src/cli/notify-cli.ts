/**
 * notify-cli.ts — Telegram push-notification helper.
 *
 * Usage:
 *   npm run notify -- chat-id         Discover your chat id from recent messages
 *   npm run notify -- chat-id --delete-webhook   ...after clearing a webhook
 *   npm run notify -- test            Send a test message to the configured chat
 *
 * The bot token is read from TELEGRAM_BOT_TOKEN (.env). To find your chat id:
 *   1. In Telegram, open a chat with your bot and send it any message (or add
 *      it to the group/channel you want alerts in).
 *   2. Run `npm run notify -- chat-id`. Put the printed id in TELEGRAM_CHAT_ID.
 *
 * Common trap: if a webhook is set, getUpdates always returns empty (Telegram
 * routes updates to the webhook instead). This command detects that and can
 * clear it with --delete-webhook.
 */
import { Command } from "commander";
import { config } from "../config.js";
import { notify, isNotifyEnabled } from "../util/notify.js";

const TOKEN = config.telegram.botToken;
const API = `https://api.telegram.org/bot${TOKEN}`;

async function tg<T>(method: string): Promise<{ ok: boolean; result?: T; description?: string }> {
  const res = await fetch(`${API}/${method}`);
  return (await res.json()) as { ok: boolean; result?: T; description?: string };
}

interface Chat { id: number; type: string; title?: string; username?: string; first_name?: string; last_name?: string }
interface Update {
  message?: { chat: Chat };
  edited_message?: { chat: Chat };
  channel_post?: { chat: Chat };
  my_chat_member?: { chat: Chat };
}

function requireToken(): void {
  if (!TOKEN) {
    console.error("✗ TELEGRAM_BOT_TOKEN is not set. Message @BotFather → /newbot, then put the token in .env.");
    process.exit(1);
  }
}

function describeChat(c: Chat): string {
  const name = c.title ?? ([c.first_name, c.last_name].filter(Boolean).join(" ") || (c.username ? `@${c.username}` : ""));
  return `  chat_id ${c.id}   (${c.type}${name ? ` · ${name}` : ""})`;
}

async function chatId(opts: { deleteWebhook?: boolean }): Promise<void> {
  requireToken();

  // 1. Confirm the token is valid and name the bot.
  const me = await tg<{ username?: string }>("getMe");
  if (!me.ok) {
    console.error(`✗ Token rejected by Telegram: ${me.description ?? "unknown error"}`);
    process.exit(1);
  }
  console.log(`✓ Bot: @${me.result?.username}`);

  // 2. The webhook trap: getUpdates is empty whenever a webhook is configured.
  const hook = await tg<{ url?: string; pending_update_count?: number }>("getWebhookInfo");
  if (hook.ok && hook.result?.url) {
    if (opts.deleteWebhook) {
      const del = await tg("deleteWebhook");
      console.log(del.ok ? "✓ Cleared the webhook." : `✗ Failed to clear webhook: ${del.description}`);
    } else {
      console.warn(`\n⚠ A webhook is set (${hook.result.url}). While it is, getUpdates returns nothing.`);
      console.warn("  Re-run with --delete-webhook to clear it, then message your bot again.\n");
    }
  }

  // 3. Pull recent updates and collect every distinct chat we can see.
  const updates = await tg<Update[]>("getUpdates");
  if (!updates.ok) {
    console.error(`✗ getUpdates failed: ${updates.description}`);
    process.exit(1);
  }
  const chats = new Map<number, Chat>();
  for (const u of updates.result ?? []) {
    const c = u.message?.chat ?? u.edited_message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
    if (c) chats.set(c.id, c);
  }

  if (chats.size === 0) {
    console.log("\nNo chats found in recent updates. Checklist:");
    console.log("  • Open your bot in Telegram and send it a message (or /start).");
    console.log("  • For a group: add the bot to the group and send a message there.");
    console.log("  • For a channel: add the bot as an admin, then post something.");
    console.log("  • Updates older than 24h expire — send a fresh message and retry.");
    return;
  }
  console.log(`\nFound ${chats.size} chat(s) — copy the right id into TELEGRAM_CHAT_ID:`);
  for (const c of chats.values()) console.log(describeChat(c));
}

async function test(): Promise<void> {
  if (!isNotifyEnabled()) {
    console.error("✗ Notifications are not fully configured. Need both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.");
    process.exit(1);
  }
  const ok = await notify("✅ <b>Bubbles</b> — Telegram notifications are working.");
  console.log(ok ? "✓ Test message sent." : "✗ Send failed — see the warning above for Telegram's reason.");
  if (!ok) process.exit(1);
}

const program = new Command();
program.name("notify").description("Telegram notification helper for Bubbles");
program
  .command("chat-id")
  .description("Discover your Telegram chat id from recent messages to the bot")
  .option("--delete-webhook", "clear a configured webhook first (it blocks getUpdates)")
  .action((opts) => chatId(opts).catch((e) => { console.error(e); process.exit(1); }));
program
  .command("test")
  .description("Send a test message to the configured chat")
  .action(() => test().catch((e) => { console.error(e); process.exit(1); }));
program.parseAsync();
