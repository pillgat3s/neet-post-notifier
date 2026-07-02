# neet-post-notifier

Telegram bot that mirrors every new X post from [@neet_sol](https://x.com/neet_sol)
into every group chat it gets added to. If the bot has "Pin messages" admin
rights in a group, it also pins each link — silently (no notification).

Runs on **Cloudflare Workers** (free tier) and fetches posts via **Nitter RSS**,
so there is **no X API key and no hosting cost**.

## How it works

- A cron trigger (`*/2 * * * *`) polls `https://nitter.net/neet_sol/rss`
  (fallback instances configurable via `NITTER_INSTANCES`).
- Group membership and the last-seen post ID are stored in Workers KV.
- A Telegram webhook (`POST /webhook`, authenticated with a secret token
  derived from the bot token) tracks the bot being added to / removed from groups.
- On a new post, the Worker sends `https://x.com/neet_sol/status/<id>` to every
  registered group and tries to pin it with `disable_notification: true`.
- Retweets and replies are skipped by default (`INCLUDE_RETWEETS` /
  `INCLUDE_REPLIES = "1"` in `wrangler.jsonc` to change).
- On the very first poll it marks the current feed as already seen, so it
  never spams the backlog.

## Deploy

```bash
npm install
npx wrangler kv namespace create STATE   # put the id into wrangler.jsonc
npx wrangler deploy
npx wrangler secret put TELEGRAM_BOT_TOKEN   # token from @BotFather
```

Then visit `https://<your-worker>.workers.dev/init` once — this registers the
Worker as the bot's Telegram webhook. It's idempotent; re-run it after
changing the token.

### Bot setup

1. Create a bot with [@BotFather](https://t.me/BotFather), copy the token.
2. In BotFather: `/setjoingroups` → Enable.

## Usage

- Add the bot to a group → it starts posting new @neet_sol posts there.
- Promote it to admin with only **Pin messages** enabled → links get pinned
  silently. Without the right it just posts the link.
- `/status` in any chat shows what it's watching and how many chats are registered.
- Kick the bot from a group to unsubscribe that group.

## Notes

- Nitter instances come and go. If `nitter.net` dies, add working mirrors to
  `NITTER_INSTANCES` in `wrangler.jsonc` (comma-separated, tried in order) and
  redeploy — status of public instances: https://status.d420.de/
- Debug with `npx wrangler tail` (cron runs log every poll).
