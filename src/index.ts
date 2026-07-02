/**
 * neet-post-notifier — Cloudflare Worker
 *
 * Mirrors every new X post from one account (default @neet_sol) into every
 * Telegram group the bot has been added to, silently pinning the link where
 * it has the rights. Posts are fetched via Nitter RSS — no X API needed.
 *
 * - scheduled(): cron poll of the RSS feed, diffed against KV state
 * - fetch(): Telegram webhook (group add/remove, /start, /status) and
 *   GET /init to (re)register the webhook after deploying
 */

interface Env {
	STATE: KVNamespace;
	TELEGRAM_BOT_TOKEN: string;
	X_HANDLE: string;
	NITTER_INSTANCES: string;
	INCLUDE_RETWEETS: string;
	INCLUDE_REPLIES: string;
}

interface Post {
	id: bigint;
	url: string;
	title: string;
	isRetweet: boolean;
	isReply: boolean;
}

type Chats = Record<string, string>; // chat_id -> title

const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---------- Telegram API ----------

async function tg(env: Env, method: string, payload: unknown): Promise<any> {
	const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	});
	return res.json();
}

/** Webhook secret derived from the bot token, so there's only one secret to manage. */
async function webhookSecret(env: Env): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.TELEGRAM_BOT_TOKEN));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// ---------- Feed fetching (Nitter RSS) ----------

function decodeEntities(s: string): string {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&');
}

function parseRss(xml: string, handle: string): Post[] {
	const posts: Post[] = [];
	for (const item of xml.split('<item>').slice(1)) {
		const idMatch = item.match(/<link>[^<]*\/status\/(\d+)/);
		if (!idMatch) continue;
		const title = decodeEntities(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').trim();
		const creator = (item.match(/<dc:creator>@?([^<]*)<\/dc:creator>/)?.[1] ?? '').trim();
		posts.push({
			id: BigInt(idMatch[1]),
			url: `https://x.com/${handle}/status/${idMatch[1]}`,
			title,
			isRetweet: creator !== '' && creator.toLowerCase() !== handle.toLowerCase(),
			isReply: title.startsWith('R to @'),
		});
	}
	return posts;
}

/** Try each Nitter instance until one returns a parseable, non-empty feed. */
async function fetchPosts(env: Env): Promise<Post[] | null> {
	const instances = env.NITTER_INSTANCES.split(',').map((u) => u.trim().replace(/\/$/, '')).filter(Boolean);
	for (const base of instances) {
		try {
			const res = await fetch(`${base}/${env.X_HANDLE}/rss`, {
				headers: { 'User-Agent': USER_AGENT },
			});
			if (!res.ok) {
				console.warn(`Instance ${base} returned HTTP ${res.status}`);
				continue;
			}
			const text = await res.text();
			if (!text.slice(0, 500).includes('<rss')) {
				console.warn(`Instance ${base} did not return RSS`);
				continue;
			}
			const posts = parseRss(text, env.X_HANDLE);
			if (posts.length) return posts;
			console.warn(`Instance ${base} returned an empty feed`);
		} catch (e) {
			console.warn(`Instance ${base} failed: ${e}`);
		}
	}
	return null;
}

// ---------- State (KV) ----------

async function getChats(env: Env): Promise<Chats> {
	return (await env.STATE.get<Chats>('chats', 'json')) ?? {};
}

async function saveChats(env: Env, chats: Chats): Promise<void> {
	await env.STATE.put('chats', JSON.stringify(chats));
}

// ---------- Broadcasting ----------

async function broadcastPost(env: Env, url: string): Promise<void> {
	const chats = await getChats(env);
	let chatsChanged = false;

	for (const chatId of Object.keys(chats)) {
		let targetId = chatId;
		let sent = await tg(env, 'sendMessage', { chat_id: Number(chatId), text: url });

		const migratedTo = sent?.parameters?.migrate_to_chat_id;
		if (!sent.ok && migratedTo) {
			chats[String(migratedTo)] = chats[chatId];
			delete chats[chatId];
			chatsChanged = true;
			targetId = String(migratedTo);
			sent = await tg(env, 'sendMessage', { chat_id: migratedTo, text: url });
		}
		if (!sent.ok) {
			if (sent.error_code === 403) {
				// kicked from this chat without us seeing the update
				delete chats[chatId];
				chatsChanged = true;
			}
			console.warn(`sendMessage to ${chatId} failed: ${sent.description}`);
			continue;
		}

		const pinned = await tg(env, 'pinChatMessage', {
			chat_id: Number(targetId),
			message_id: sent.result.message_id,
			disable_notification: true,
		});
		if (!pinned.ok) {
			// no pin rights here — the link alone is fine
			console.log(`No pin rights in ${targetId}: ${pinned.description}`);
		}
	}

	if (chatsChanged) await saveChats(env, chats);
}

// ---------- Cron ----------

async function pollFeed(env: Env): Promise<void> {
	if (!env.TELEGRAM_BOT_TOKEN) {
		console.error('TELEGRAM_BOT_TOKEN secret is not set yet');
		return;
	}

	const all = await fetchPosts(env);
	if (all === null) {
		console.warn('All Nitter instances failed this round, will retry next cron');
		return;
	}

	const posts = all.filter(
		(p) => (env.INCLUDE_RETWEETS === '1' || !p.isRetweet) && (env.INCLUDE_REPLIES === '1' || !p.isReply),
	);
	if (!posts.length) return;

	const lastSeenRaw = await env.STATE.get('last_seen_id');
	const newest = posts.reduce((a, b) => (a.id > b.id ? a : b));

	if (lastSeenRaw === null) {
		// first run: mark current feed as seen instead of spamming the backlog
		await env.STATE.put('last_seen_id', newest.id.toString());
		console.log(`Initialized last_seen_id=${newest.id}`);
		return;
	}

	const lastSeen = BigInt(lastSeenRaw);
	const fresh = posts.filter((p) => p.id > lastSeen).sort((a, b) => (a.id < b.id ? -1 : 1));

	for (const post of fresh) {
		console.log(`New post ${post.id}: ${post.title.slice(0, 80)}`);
		await broadcastPost(env, post.url);
		await env.STATE.put('last_seen_id', post.id.toString());
	}
}

// ---------- Webhook ----------

async function handleUpdate(env: Env, update: any): Promise<void> {
	const member = update.my_chat_member;
	if (member) {
		const chat = member.chat;
		if (chat.type !== 'group' && chat.type !== 'supergroup') return;
		const status = member.new_chat_member?.status;
		const chats = await getChats(env);
		if (status === 'member' || status === 'administrator') {
			chats[String(chat.id)] = chat.title ?? '';
			await saveChats(env, chats);
			console.log(`Added to chat ${chat.id} (${chat.title})`);
		} else if (status === 'left' || status === 'kicked') {
			if (String(chat.id) in chats) {
				delete chats[String(chat.id)];
				await saveChats(env, chats);
			}
			console.log(`Removed from chat ${chat.id} (${chat.title})`);
		}
		return;
	}

	const msg = update.message;
	const text: string = msg?.text ?? '';
	if (!msg) return;

	if (text.startsWith('/start') && msg.chat.type === 'private') {
		await tg(env, 'sendMessage', {
			chat_id: msg.chat.id,
			text:
				`Add me to a group and I'll post every new X post from @${env.X_HANDLE} there. ` +
				`Make me an admin with 'Pin messages' rights and I'll also pin each link (silently).`,
		});
	} else if (text.startsWith('/status')) {
		const chats = await getChats(env);
		const lastSeen = await env.STATE.get('last_seen_id');
		await tg(env, 'sendMessage', {
			chat_id: msg.chat.id,
			text: `Watching @${env.X_HANDLE} · ${Object.keys(chats).length} chat(s) registered · last seen post ID ${lastSeen ?? 'none yet'}`,
		});
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/webhook' && request.method === 'POST') {
			if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== (await webhookSecret(env))) {
				return new Response('forbidden', { status: 403 });
			}
			await handleUpdate(env, await request.json());
			return new Response('ok');
		}

		// One-time setup after deploying + setting the token secret:
		// visiting /init registers this Worker as the bot's webhook. Idempotent.
		if (url.pathname === '/init') {
			if (!env.TELEGRAM_BOT_TOKEN) {
				return new Response('Set the TELEGRAM_BOT_TOKEN secret first', { status: 500 });
			}
			const result = await tg(env, 'setWebhook', {
				url: `${url.origin}/webhook`,
				secret_token: await webhookSecret(env),
				allowed_updates: ['message', 'my_chat_member'],
			});
			return Response.json(result);
		}

		return new Response('neet-post-notifier is running');
	},

	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(pollFeed(env));
	},
} satisfies ExportedHandler<Env>;
