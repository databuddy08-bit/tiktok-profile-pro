// TikTok Profile Scraper Pro — Apify actor entry point. Profiles -> their videos (and reposts), no login.
import { Actor, log } from 'apify';
import { SessionPool, StoppedError, SessionError, closeBrowser, sleep } from './browser.js';
import {
    parseProfileInput, userDetailFromHtml, videoDetailFromHtml, profileStatus, authorMetaFromProfile, videoRow, listItems, embedVideoIds, parseDate,
} from './tiktok.js';

// Pay-per-event names — must match the Monetization settings exactly.
export const EVENT_VIDEO = 'tiktok-video'; // one video saved
export const EVENT_VIDEO_FILE = 'video-download'; // one MP4 stored in the key-value store (add-on)
export const EVENT_MEDIA_FILE = 'media-download'; // one cover / subtitle / slideshow image / avatar / music cover stored (add-on)
export const EVENT_RESI = 'residential-video'; // extra: a video listed through a RESIDENTIAL proxy session

const PROFILE_CONCURRENCY = 3;
const DOWNLOAD_CONCURRENCY = 4;
const STOP_BEFORE_TIMEOUT_MS = 45000;
const PROGRESS_EVERY = 100;
const PAGE_SIZE = { posts: 16, reposts: 30 }; // the sizes TikTok's own page uses (larger values return nothing)
const OLDER_STREAK_TO_STOP = 5;
const SORT_TYPE = { latest: 0, popular: 1, oldest: 2 };

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const int = (v, d, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.floor(Number(v)) : d));
const raw = (Array.isArray(input.profiles) ? input.profiles : String(input.profiles ?? '').split(/[\n,]/)).map((x) => String(typeof x === 'object' && x ? x.url ?? x.username ?? '' : x).trim()).filter(Boolean);
const opts = {
    sections: (Array.isArray(input.profileScrapeSections) && input.profileScrapeSections.length ? input.profileScrapeSections : ['videos']).filter((s) => ['videos', 'reposts'].includes(s)),
    sorting: Object.hasOwn(SORT_TYPE, input.profileSorting) ? input.profileSorting : 'latest',
    resultsPerPage: int(input.resultsPerPage, 100, 1, 100000),
    excludePinnedPosts: Boolean(input.excludePinnedPosts),
    leastDiggs: int(input.leastDiggs, 0, 0, 1e12) || null, // 0 / empty = no minimum
    mostDiggs: int(input.mostDiggs, 0, 0, 1e12) || null, // 0 / empty = no maximum
    maxItems: int(input.maxItems, 0, 0, 1e9),
    shouldDownloadVideos: Boolean(input.shouldDownloadVideos),
    shouldDownloadCovers: Boolean(input.shouldDownloadCovers),
    shouldDownloadSubtitles: Boolean(input.shouldDownloadSubtitles),
    shouldDownloadSlideshowImages: Boolean(input.shouldDownloadSlideshowImages),
    shouldDownloadAvatars: Boolean(input.shouldDownloadAvatars),
    shouldDownloadMusicCovers: Boolean(input.shouldDownloadMusicCovers),
    kvStoreName: String(input.videoKvStoreIdOrName ?? '').trim() || null,
    fallback: input.fallbackWhenListBlocked !== false,
    region: /^[A-Za-z]{2}$/.test(input.proxyCountryCode ?? '') ? input.proxyCountryCode.toUpperCase() : 'US',
};
let oldestTs = null;
let newestTs = null;
try {
    oldestTs = parseDate(input.oldestPostDateUnified ?? input.oldestPostDate, 'Scrape videos published after');
    newestTs = parseDate(input.newestPostDate, 'Scrape videos published before');
    if (newestTs && /^\d{4}-\d{2}-\d{2}$/.test(String(input.newestPostDate).trim())) newestTs += 86399; // a plain date includes that whole day
} catch (err) {
    await Actor.pushData({ input: '', error: err.message, errorCode: 'INVALID_INPUT' });
    await Actor.fail(err.message);
}
if (!raw.length) {
    await Actor.pushData({ input: '', error: 'No profiles given', errorCode: 'INVALID_INPUT' });
    await Actor.fail('Add at least one TikTok username or profile URL in "Profiles".');
}
if (!opts.sections.length) opts.sections = ['videos'];

// ---------- Deadline, routes, pricing ----------
const startedAt = Date.now();
const { timeoutAt } = Actor.getEnv();
const deadline = timeoutAt ? new Date(timeoutAt).getTime() - STOP_BEFORE_TIMEOUT_MS : Infinity;
let stopReason = null;
const stop = (r) => {
    if (!stopReason) {
        stopReason = r;
        log.info(`Stopping: ${r}`);
    }
};
const msLeft = () => {
    if (!stopReason && Date.now() >= deadline) stop('timeout_approaching (stopped 45 s early so data is saved)');
    return stopReason ? 0 : deadline - Date.now();
};

const proxyInput = input.proxyConfiguration;
let userProxy;
if (proxyInput?.useApifyProxy || proxyInput?.proxyUrls?.length) {
    try {
        userProxy = await Actor.createProxyConfiguration({ ...proxyInput, ...(proxyInput.useApifyProxy && opts.region && input.proxyCountryCode ? { countryCode: opts.region } : {}) });
    } catch (err) {
        log.warning(`Proxy could not be configured (${err.message}). Continuing without it.`);
    }
}
const userGroups = proxyInput?.apifyProxyGroups ?? [];
const userLabel = !userProxy ? 'no proxy' : proxyInput?.useApifyProxy ? `Apify proxy (${userGroups.length ? userGroups.join(', ') : 'datacenter'})` : 'custom proxy';
const userRoute = { label: userLabel, proxy: userProxy, residential: Boolean(userProxy && proxyInput?.useApifyProxy && userGroups.includes('RESIDENTIAL')) || process.env.TEST_RESIDENTIAL_EVENT === '1' };
const apifyRoutes = {};
if (input.proxyFallback !== false && (Actor.isAtHome() || process.env.APIFY_PROXY_PASSWORD)) {
    for (const g of ['RESIDENTIAL', 'DATACENTER']) {
        try {
            const pc = await Actor.createProxyConfiguration({ useApifyProxy: true, ...(g === 'RESIDENTIAL' ? { apifyProxyGroups: ['RESIDENTIAL'], ...(input.proxyCountryCode ? { countryCode: opts.region } : {}) } : {}) });
            if (pc) apifyRoutes[g] = { label: `Apify proxy (${g === 'RESIDENTIAL' ? 'RESIDENTIAL' : 'datacenter'})`, proxy: pc, residential: g === 'RESIDENTIAL' };
        } catch { /* group not available */ }
    }
}
const uniq = (routes) => routes.filter((r, i) => r && routes.findIndex((x) => x?.label === r.label) === i);
// Profile pages, reposts, playlists, video pages and downloads work without a proxy; full video lists are refused to
// most datacenter IPs, so that pool falls back to RESIDENTIAL quickly.
const pageRoutes = uniq([userRoute, apifyRoutes.DATACENTER, apifyRoutes.RESIDENTIAL, { label: 'no proxy', proxy: undefined }]);
const listRoutes = uniq([userRoute, apifyRoutes.RESIDENTIAL, apifyRoutes.DATACENTER, { label: 'no proxy', proxy: undefined }]);
const charging = Actor.getChargingManager();
const pricing = charging.getPricingInfo();

const summary = {
    startedAt: new Date(startedAt).toISOString(), finishedAt: null, durationSec: null, stopReason: null,
    profiles: 0, saved: 0, savedBySection: {}, savedBySource: {}, errorItems: {}, chargedEvents: { [EVENT_VIDEO]: 0, [EVENT_VIDEO_FILE]: 0, [EVENT_MEDIA_FILE]: 0, [EVENT_RESI]: 0 },
    downloads: { stored: 0, failed: 0, megabytes: 0 }, skipReasons: {}, perProfile: [], fillRates: null,
    browser: { sessions: 0, sessionRotations: 0, routeSwitches: 0, apiCalls: 0, htmlCalls: 0, emptyAnswers: 0, bytes: 0 }, routes: {},
};
const bump = (o, k, c = 1) => { o[k] = (o[k] ?? 0) + c; };
const pagePool = new SessionPool({ routes: pageRoutes, region: opts.region, stats: summary.browser, msLeft, name: 'Profile pages' });
const listPool = new SessionPool({ routes: listRoutes, region: opts.region, stats: summary.browser, msLeft, failAfter: 2, name: 'Video lists' });
log.info(`${raw.length} profile(s), sections: ${opts.sections.join(', ')}, sort: ${opts.sorting}, up to ${opts.resultsPerPage} per section. Routes — pages: ${pageRoutes.map((r) => r.label).join(' → ')}; video lists: ${listRoutes.map((r) => r.label).join(' → ')}`);

const kv = opts.kvStoreName ? await Actor.openKeyValueStore(opts.kvStoreName) : await Actor.openKeyValueStore();
const anyDownload = opts.shouldDownloadVideos || opts.shouldDownloadCovers || opts.shouldDownloadSubtitles || opts.shouldDownloadSlideshowImages || opts.shouldDownloadAvatars || opts.shouldDownloadMusicCovers;

// ---------- Output ----------
let chain = Promise.resolve();
const savedIds = new Set();
const ERROR_TEXT = {
    NOT_FOUND: 'Profile does not exist (or was banned / renamed)',
    PROFILE_PRIVATE: 'Profile is private',
    PROFILE_EMPTY: 'Profile has no videos (or TikTok refused the video list)',
    PROFILE_REPOSTS_EMPTY: 'Profile has no public reposts',
    FILTER_NO_PASS: 'Videos exist but none match the active date/popularity filters',
    INVALID_URLS: 'Not a TikTok username or profile URL',
};
function saveError(rec, errorCode, error) {
    bump(summary.errorItems, errorCode);
    chain = chain.then(() => Actor.pushData({ url: rec.username ? `https://www.tiktok.com/@${rec.username}` : null, input: rec.input, error: error ?? ERROR_TEXT[errorCode], errorCode })); // never charged
    return chain;
}
function canAfford(events) {
    const counts = [...new Set(events)].map((e) => charging.calculateMaxEventChargeCountWithinLimit(e) / events.filter((x) => x === e).length);
    if (counts.some((c) => c < 1)) return false;
    return counts.reduce((s, c) => s + (Number.isFinite(c) ? 1 / c : 0), 0) <= 1 + 1e-9;
}
const FILL = ['text', 'createTimeISO', 'webVideoUrl', 'playCount', 'diggCount', 'commentCount', 'shareCount', 'collectCount', 'authorMeta.fans', 'authorMeta.bioLink', 'musicMeta.musicName', 'videoMeta.coverUrl', 'videoMeta.downloadAddr', 'videoMeta.subtitleLinks', 'hashtags'];
const fillCounts = {};
function fill(row) {
    for (const f of FILL) {
        const v = f.split('.').reduce((o, k) => o?.[k], row);
        if (v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) bump(fillCounts, f);
    }
}

/** Saves one video with its add-on charges. Resolves to false when the run must stop. */
function save(row, { files = { video: 0, media: 0 }, residential = false } = {}) {
    const p = chain.then(async () => {
        if (stopReason) return false;
        if (opts.maxItems && summary.saved >= opts.maxItems) {
            stop('max_items_reached');
            return false;
        }
        const extra = [...Array(files.video).fill(EVENT_VIDEO_FILE), ...Array(files.media).fill(EVENT_MEDIA_FILE), ...(residential ? [EVENT_RESI] : [])];
        if (pricing.isPayPerEvent && !(extra.length ? canAfford([EVENT_VIDEO, ...extra]) : charging.calculateMaxEventChargeCountWithinLimit(EVENT_VIDEO) > 0)) {
            stop('max_cost_per_run_reached');
            return false;
        }
        const res = await Actor.pushData(row, EVENT_VIDEO);
        summary.chargedEvents[EVENT_VIDEO] += res?.chargedCount ?? 0;
        let limitHit = res?.eventChargeLimitReached;
        for (const [e, n] of [[EVENT_VIDEO_FILE, files.video], [EVENT_MEDIA_FILE, files.media], [EVENT_RESI, residential ? 1 : 0]]) {
            if (!n) continue;
            const r = await charging.charge({ eventName: e, count: n });
            summary.chargedEvents[e] += r?.chargedCount ?? 0;
            limitHit = limitHit || r?.eventChargeLimitReached;
        }
        summary.saved += 1;
        bump(summary.savedBySection, row.fromProfileSection);
        fill(row);
        if (limitHit) stop('max_cost_per_run_reached');
        if (opts.maxItems && summary.saved >= opts.maxItems) stop('max_items_reached');
        if (summary.saved % PROGRESS_EVERY === 0) {
            const min = Math.max((Date.now() - startedAt) / 60000, 1 / 60);
            log.info(`Progress: ${summary.saved} videos saved, ${Math.round(summary.saved / min)}/min.`);
        }
        return true;
    });
    chain = p.then(() => {}, () => {});
    return p;
}

// ---------- Downloads (plain HTTPS with the session's media cookie: no proxy traffic) ----------
const DL_HEADERS = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', referer: 'https://www.tiktok.com/' };
const safeKey = (s) => String(s).replace(/[^a-zA-Z0-9!\-_.'()]/g, '_').slice(0, 250);
const storedAvatars = new Map();
async function download(url, key, contentType, cookie, forceType = false) {
    if (!url) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (msLeft() <= 0) return null;
        try {
            const ac = new AbortController();
            const t = setTimeout(() => ac.abort(), 120000);
            const res = await fetch(url, { headers: { ...DL_HEADERS, ...(cookie ? { cookie } : {}) }, signal: ac.signal }).finally(() => clearTimeout(t));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length < 200) throw new Error('empty file');
            await kv.setValue(key, buf, { contentType: forceType ? contentType : res.headers.get('content-type')?.split(';')[0] || contentType });
            summary.downloads.stored += 1;
            summary.downloads.megabytes += buf.length / 1e6;
            return kv.getPublicUrl(key);
        } catch (err) {
            if (attempt) {
                summary.downloads.failed += 1;
                log.debug(`Download failed ${key}: ${err.message}`);
            } else await sleep(1000);
        }
    }
    return null;
}
/** Stores the requested files; rewrites links to the stored copies (originals stay in original* / tiktokLink). */
async function downloadFiles(row, cookie) {
    const files = { video: 0, media: 0 };
    const base = `${safeKey(row.authorMeta.name ?? 'tiktok')}-${row.id}`;
    const tasks = [];
    if (opts.shouldDownloadVideos && !row.isSlideshow) {
        tasks.push(async () => {
            const url = await download(row.videoMeta.originalDownloadAddr, `video-${base}`, 'video/mp4', cookie, true);
            if (url) {
                row.videoMeta.downloadAddr = url;
                row.mediaUrls = [url];
                files.video += 1;
            }
        });
    }
    if (opts.shouldDownloadCovers && row.videoMeta.originalCoverUrl) {
        tasks.push(async () => {
            const url = await download(row.videoMeta.originalCoverUrl, `cover-${base}`, 'image/jpeg', cookie);
            if (url) {
                row.videoMeta.coverUrl = url;
                files.media += 1;
            }
        });
    }
    if (opts.shouldDownloadSubtitles) {
        row.videoMeta.subtitleLinks.forEach((s, i) => tasks.push(async () => {
            const url = await download(s.tiktokLink, `subtitles-${base}-${safeKey(s.language ?? i)}-${i}`, 'text/vtt', cookie, true);
            if (url) {
                s.downloadLink = url;
                files.media += 1;
            }
        }));
    }
    if (opts.shouldDownloadSlideshowImages && row.slideshowImageLinks) {
        row.slideshowImageLinks.forEach((im, i) => tasks.push(async () => {
            const url = await download(im.tiktokLink, `slideshow-${base}-${i + 1}`, 'image/jpeg', cookie);
            if (url) {
                im.downloadLink = url;
                files.media += 1;
            }
        }));
        if (opts.shouldDownloadSlideshowImages) row.mediaUrls = row.slideshowImageLinks.map((x) => x.downloadLink);
    }
    if (opts.shouldDownloadMusicCovers && row.musicMeta.originalCoverMediumUrl) {
        tasks.push(async () => {
            const url = await download(row.musicMeta.originalCoverMediumUrl, `music-cover-${safeKey(row.musicMeta.musicId ?? row.id)}`, 'image/jpeg', cookie);
            if (url) {
                row.musicMeta.coverMediumUrl = url;
                files.media += 1;
            }
        });
    }
    if (opts.shouldDownloadAvatars && row.authorMeta.originalAvatarUrl) {
        tasks.push(async () => {
            const who = row.authorMeta.name;
            if (!storedAvatars.has(who)) { // once per creator per run
                storedAvatars.set(who, download(row.authorMeta.originalAvatarUrl, `avatar-${safeKey(who)}`, 'image/jpeg', cookie).then((u) => {
                    if (u) files.media += 1;
                    return u;
                }));
            }
            const url = await storedAvatars.get(who);
            if (url) row.authorMeta.avatar = url;
        });
    }
    for (let i = 0; i < tasks.length; i += DOWNLOAD_CONCURRENCY) await Promise.all(tasks.slice(i, i + DOWNLOAD_CONCURRENCY).map((f) => f()));
    if (opts.shouldDownloadSlideshowImages && row.slideshowImageLinks) row.mediaUrls = row.slideshowImageLinks.map((x) => x.downloadLink);
    return files;
}

// ---------- TikTok access with session replacement ----------
class Worker {
    constructor(pool) {
        this.pool = pool;
        this.session = null;
    }

    async call(fn) {
        for (let attempt = 0; attempt < 3; attempt++) {
            if (!this.session) this.session = await this.pool.create();
            try {
                const r = await fn(this.session);
                if (r !== null && r !== undefined) return r;
            } catch (err) {
                if (!(err instanceof SessionError)) throw err;
            }
            this.session = await this.pool.replace(this.session);
        }
        return null;
    }

    api(path, params) {
        return this.call((s) => s.api(path, params));
    }

    async close() {
        await this.session?.close();
    }
}

// ---------- One profile ----------
let listRefusedStreak = 0;
let listGiveUp = false;
async function runProfile(target, pages, lists) {
    const rec = { input: target.input, username: target.username, saved: {}, seen: 0, skipped: {}, source: {}, errors: [] };
    summary.perProfile.push(rec);
    summary.profiles += 1;

    // 1. Profile page: account data, exact counters, secUid
    const ud = await pages.call(async (s) => {
        const html = await s.html(`/@${encodeURIComponent(target.username)}`);
        const d = userDetailFromHtml(html);
        return profileStatus(d) === 'blocked' ? null : d;
    });
    const status = profileStatus(ud);
    if (status === 'blocked') throw Object.assign(new Error('TikTok did not serve the profile page on any route'), { code: 'PROFILE_EMPTY' });
    if (status === 'not_found') return saveError(rec, 'NOT_FOUND', `Profile @${target.username} does not exist (TikTok: ${ud?.statusMsg || ud?.statusCode})`);
    if (status === 'private') return saveError(rec, 'PROFILE_PRIVATE');
    const authorMeta = authorMetaFromProfile(ud);
    rec.username = authorMeta.name;
    rec.profile = { fans: authorMeta.fans, videos: authorMeta.video, verified: authorMeta.verified };

    for (const section of opts.sections) {
        if (stopReason) break;
        const sec = { saved: 0, seen: 0, passed: 0 };
        rec.saved[section] = 0;
        let olderStreak = 0;

        /** Filters + downloads + save. Returns 'go' | 'full' | 'stop'. */
        const handle = async (it, { residential, cookie, source }) => {
            if (sec.saved >= opts.resultsPerPage) return 'full';
            sec.seen += 1;
            rec.seen += 1;
            const skip = (r) => {
                bump(rec.skipped, r);
                bump(summary.skipReasons, r);
            };
            const isPinned = Boolean(it.isPinnedItem);
            const ts = Number(it.createTime) || 0;
            if (opts.excludePinnedPosts && isPinned) return skip('excluded_pinned'), 'go';
            if (oldestTs && ts && ts < oldestTs) {
                skip('older_than_oldest_date');
                if (!isPinned) olderStreak += 1;
                return section === 'videos' && opts.sorting === 'latest' && olderStreak >= OLDER_STREAK_TO_STOP ? 'stop' : 'go';
            }
            if (!isPinned) olderStreak = 0;
            if (newestTs && ts && ts > newestTs) return skip('newer_than_newest_date'), 'go';
            const likes = Number(it.statsV2?.diggCount ?? it.stats?.diggCount ?? 0);
            if (opts.leastDiggs !== null && likes < opts.leastDiggs) return skip('fewer_likes_than_minimum'), 'go';
            if (opts.mostDiggs !== null && likes > opts.mostDiggs) return skip('more_likes_than_maximum'), 'go';
            if (savedIds.has(`${section}:${it.id}`)) return skip('duplicate'), 'go';
            sec.passed += 1;
            const own = section === 'videos' && it.author?.uniqueId?.toLowerCase() === authorMeta.name.toLowerCase();
            const row = videoRow(it, { authorMeta: own || section === 'videos' ? structuredClone(authorMeta) : undefined, input: target.input, section });
            if (source !== 'list') row.dataSource = source;
            const files = anyDownload ? await downloadFiles(row, cookie) : { video: 0, media: 0 };
            savedIds.add(`${section}:${it.id}`);
            if (!(await save(row, { files, residential }))) return 'stop';
            sec.saved += 1;
            rec.saved[section] += 1;
            bump(rec.source, source);
            bump(summary.savedBySource, source);
            return sec.saved >= opts.resultsPerPage ? 'full' : 'go';
        };

        /** Pages through a list endpoint. Returns 'ok' | 'empty' | 'refused'. */
        const pageThrough = async (worker, path, params, source, size) => {
            let cursor = 0;
            let pagesRead = 0;
            while (!stopReason) {
                const j = await worker.api(path, { ...params, count: size, cursor });
                if (!j) return pagesRead ? 'ok' : 'refused';
                pagesRead += 1;
                const items = listItems(j);
                if (pagesRead === 1 && !items.length) return 'empty';
                const session = worker.session;
                const cookie = anyDownload ? await session?.mediaCookie() : null;
                for (const it of items) {
                    const r = await handle(it, { residential: Boolean(session?.route?.residential), cookie, source });
                    if (r !== 'go') return 'ok';
                }
                if (!j.hasMore || !items.length) return pagesRead === 1 && !items.length ? 'empty' : 'ok';
                cursor = j.cursor ?? cursor + items.length;
            }
            return 'ok';
        };

        if (section === 'videos') {
            if (!authorMeta.video) {
                await saveError(rec, 'PROFILE_EMPTY', 'Profile has no videos');
                continue;
            }
            // Once every route has refused the list for 2 profiles in a row, later profiles skip straight to the fallback.
            const lastRoute = listPool.routeIdx === listPool.routes.length - 1;
            let res = listGiveUp ? 'refused' : await pageThrough(lists, '/api/post/item_list/', { secUid: authorMeta.secUid, coverFormat: 2, needPinnedItemIds: true, post_item_list_request_type: SORT_TYPE[opts.sorting] }, 'list', PAGE_SIZE.posts);
            if (res === 'empty' && authorMeta.video > 0) res = 'refused'; // a public profile with videos never has an empty list
            if (!listGiveUp) {
                listRefusedStreak = res === 'refused' ? listRefusedStreak + 1 : 0;
                if (res === 'refused' && lastRoute && listRefusedStreak >= 2) {
                    listGiveUp = true;
                    log.warning('TikTok refuses full video lists on every available route; the remaining profiles use the public fallback directly.');
                }
            }
            rec.listResult = res;
            if (res === 'refused' && !stopReason && sec.saved < opts.resultsPerPage) {
                summary.listRefused = (summary.listRefused ?? 0) + 1;
                log.warning(`@${authorMeta.name}: TikTok refused the full video list on every route${opts.fallback ? ' — collecting the videos it does show publicly (playlists and the latest posts)' : ''}.`);
                if (opts.fallback) await fallbackVideos(authorMeta, handle, pages, rec);
            }
        } else {
            const res = await pageThrough(pages, '/api/repost/item_list/', { secUid: authorMeta.secUid, coverFormat: 2, needPinnedItemIds: true }, 'list', PAGE_SIZE.reposts);
            rec.repostResult = res;
        }
        if (!sec.saved && !stopReason) {
            if (sec.seen && !sec.passed) await saveError(rec, 'FILTER_NO_PASS');
            else if (!sec.seen) await saveError(rec, section === 'reposts' ? 'PROFILE_REPOSTS_EMPTY' : 'PROFILE_EMPTY', section === 'videos' && rec.listResult === 'refused' ? 'TikTok refused the video list (login wall for this IP). Run again with the RESIDENTIAL proxy group.' : undefined);
        }
    }
    return rec;
}

/** When the full list is refused: the profile's playlists (full data) and its latest posts (creator embed + video pages). */
async function fallbackVideos(authorMeta, handle, pages, rec) {
    const ids = new Set();
    const go = async (it, source) => {
        if (ids.has(it.id)) return 'go';
        ids.add(it.id);
        const cookie = anyDownload ? await pages.session?.mediaCookie() : null;
        return handle(it, { residential: Boolean(pages.session?.route?.residential), cookie, source });
    };
    // Latest posts: ids from the creator embed, details from each video page
    const embedIds = (opts.sorting !== 'oldest')
        ? embedVideoIds(await pages.call((s) => s.html(`/embed/@${encodeURIComponent(authorMeta.name)}`)), authorMeta.name)
        : [];
    for (const id of embedIds) {
        if (stopReason) return;
        const vd = await pages.call(async (s) => videoDetailFromHtml(await s.html(`/@${encodeURIComponent(authorMeta.name)}/video/${id}`)) ?? null);
        const it = vd?.itemInfo?.itemStruct;
        if (!it?.id) continue;
        if ((await go(it, 'latest_posts')) !== 'go') return;
    }
    // Playlists
    const pl = await pages.api('/api/user/playlist/', { secUid: authorMeta.secUid, count: 20, cursor: 0 });
    for (const mix of pl?.playList ?? []) {
        let cursor = 0;
        for (let page = 0; page < 20 && !stopReason; page++) {
            const j = await pages.api('/api/mix/item_list/', { mixId: mix.mixId, count: 30, cursor });
            const items = listItems(j);
            for (const it of items) if ((await go(it, `playlist:${mix.name}`)) !== 'go') return;
            if (!j?.hasMore || !items.length) break;
            cursor = j.cursor ?? cursor + items.length;
        }
    }
    rec.fallbackVideosFound = ids.size;
}

// ---------- Run ----------
const targets = [];
const seen = new Set();
for (const r of raw) {
    const t = parseProfileInput(r);
    if (!t) continue;
    if (t.error) {
        await saveError({ input: t.input }, 'INVALID_URLS', t.error);
        continue;
    }
    if (seen.has(t.username.toLowerCase())) continue;
    seen.add(t.username.toLowerCase());
    targets.push(t);
}
const queue = [...targets];
async function loop(i) {
    if (i > 0) await pagePool.firstOpen;
    const pages = new Worker(pagePool);
    const lists = new Worker(listPool);
    while (queue.length && !stopReason && msLeft() > 0) {
        const t = queue.shift();
        try {
            await runProfile(t, pages, lists);
        } catch (err) {
            if (err instanceof StoppedError) break;
            log.warning(`@${t.username}: ${err.message}`);
            await saveError({ input: t.input, username: t.username }, err.code ?? 'PROFILE_EMPTY', err.message);
        }
    }
    await pages.close();
    await lists.close();
}
await Promise.all(Array.from({ length: Math.min(PROFILE_CONCURRENCY, queue.length) }, (_, i) => loop(i)));
await chain;
await closeBrowser();

// ---------- Summary ----------
summary.stopReason = stopReason ?? 'completed';
summary.finishedAt = new Date().toISOString();
summary.durationSec = Math.round((Date.now() - startedAt) / 1000);
summary.routes = { profilePages: pagePool.summary(), videoLists: listPool.summary() };
summary.browser.megabytes = Math.round(summary.browser.bytes / 1e5) / 10;
delete summary.browser.bytes;
summary.downloads.megabytes = Math.round(summary.downloads.megabytes * 10) / 10;
summary.fillRates = summary.saved ? Object.fromEntries(Object.entries(fillCounts).map(([k, v]) => [k, `${Math.round((v / summary.saved) * 100)}%`])) : null;
for (const r of summary.perProfile) if (!r.errors.length) delete r.errors;
await Actor.setValue('RUN_SUMMARY', summary);
const errs = Object.entries(summary.errorItems).map(([k, v]) => `${v} ${k}`).join(', ');
const msg = `Saved ${summary.saved} videos from ${summary.profiles} profile(s)${summary.downloads.stored ? `, ${summary.downloads.stored} files stored` : ''}${errs ? `. Error items (free): ${errs}` : ''}. Stop reason: ${summary.stopReason}.`;
log.info(msg);
await Actor.exit({ statusMessage: msg });
