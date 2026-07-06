/**
 * Tracking-parameter removal (ClearURLs-style, no dependencies).
 *
 * cleanUrl() strips known tracking query parameters from a URL and returns
 * the cleaned version, or null when nothing needed removing — callers use
 * that to skip already-clean links.
 */

// Removed on every site.
const GLOBAL_PARAMS = new Set([
	'fbclid', 'gclid', 'gclsrc', 'dclid', 'wbraid', 'gbraid', 'msclkid', 'yclid',
	'twclid', 'ttclid', 'li_fat_id', 'igshid', 'igsh', 'mibextid', 'rdt_cid',
	'mc_cid', 'mc_eid', 'mkt_tok', 'srsltid', 'epik', 'spm', 'sc_cid', 'ncid',
	'cmpid', 'fb_action_ids', 'fb_action_types', 'fb_ref', 'fb_source',
	'_openstat', 'vero_conv', 'wickedid', 'gs_l', 'ml_subscriber', 'ml_subscriber_hash',
]);

// Removed on every site when the name starts with one of these.
const GLOBAL_PREFIXES = ['utm_', 'hsa_', 'pk_', 'piwik_', 'matomo_', 'mtm_', 'oly_', 'vero_', '_hs', 'ga_'];

// Removed only on specific sites (matched by hostname suffix), where these
// short names are known to be share/tracking junk rather than functional.
const DOMAIN_PARAMS: Record<string, string[]> = {
	'x.com': ['s', 't', 'ref_src', 'ref_url'],
	'twitter.com': ['s', 't', 'ref_src', 'ref_url'],
	'youtube.com': ['si', 'feature', 'pp'],
	'youtu.be': ['si', 'feature'],
	'open.spotify.com': ['si', 'context', 'nd'],
	'reddit.com': ['share_id', 'ref', 'ref_source', 'correlation_id'],
	'instagram.com': ['ig_rid'],
	'tiktok.com': ['_r', '_t', 'share_app_id', 'sender_device', 'sender_web_id'],
	'aliexpress.com': ['scm', 'pvid', 'algo_pvid', 'algo_exp_id', 'gatewayAdapt'],
	'ebay.com': ['mkcid', 'mkrid', 'ssspo', 'sssrc', 'ssuid', 'mkevt', 'campid'],
};

// Amazon spreads tracking across many params; matched for any amazon.* host.
const AMAZON_PARAMS = ['pf_rd_p', 'pf_rd_r', 'pd_rd_w', 'pd_rd_wg', 'pd_rd_r', 'qid', 'sr', 'sprefix', 'crid', 'linkCode', 'linkId', 'ref_', 'dib', 'dib_tag', 'content-id'];

function hostMatches(hostname: string, domain: string): boolean {
	return hostname === domain || hostname.endsWith('.' + domain);
}

function isTracking(name: string, hostname: string): boolean {
	const lower = name.toLowerCase();
	if (GLOBAL_PARAMS.has(lower)) return true;
	if (GLOBAL_PREFIXES.some((p) => lower.startsWith(p))) return true;
	for (const [domain, params] of Object.entries(DOMAIN_PARAMS)) {
		if (hostMatches(hostname, domain) && params.includes(name)) return true;
	}
	if (/(^|\.)amazon\./.test(hostname) && AMAZON_PARAMS.includes(name)) return true;
	return false;
}

/** Strip tracking params; returns the cleaned URL, or null if it was already clean. */
export function cleanUrl(raw: string): string | null {
	let url: URL;
	try {
		// Telegram 'url' entities can lack a scheme ("example.com/page")
		url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

	const toRemove = [...new Set([...url.searchParams.keys()])].filter((k) => isTracking(k, url.hostname));
	if (!toRemove.length) return null;

	for (const k of toRemove) url.searchParams.delete(k);
	if ([...url.searchParams.keys()].length === 0) url.search = '';
	return url.toString();
}

/** Pull URLs out of a Telegram message via its entities (more reliable than regex). */
export function extractUrls(msg: any): string[] {
	const text: string = msg.text ?? msg.caption ?? '';
	const entities: any[] = msg.entities ?? msg.caption_entities ?? [];
	const urls: string[] = [];
	for (const e of entities) {
		if (e.type === 'url') urls.push(text.slice(e.offset, e.offset + e.length));
		else if (e.type === 'text_link' && e.url) urls.push(e.url);
	}
	return [...new Set(urls)];
}
