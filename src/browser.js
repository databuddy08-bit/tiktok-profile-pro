// Browser sessions: TikTok signs every web API call inside its own page, so calls are made from a real (headless) page.
// A session = one browser context (cookies, device id, proxy IP) with tiktok.com loaded; calls run through its fetch.
import { chromium } from 'playwright';
import { log } from 'apify';

export const TIKTOK = (process.env.TIKTOK_BASE ?? 'https://www.tiktok.com').replace(/\/$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SIGN_PARAMS = ['X-Bogus', 'X-Gnarly', 'msToken', 'X-Dynosaur'];
const BACKOFF = Number(process.env.HTTP_BACKOFF_SCALE ?? 1);
export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms * BACKOFF)));

export class StoppedError extends Error {}
export class SessionError extends Error {}

let browserPromise = null;
/** One shared browser: Playwright's own Chromium first (always matches), then the image's Chrome. */
export function getBrowser() {
    if (!browserPromise) {
        const args = ['--disable-dev-shm-usage', '--no-sandbox', '--mute-audio'];
        const tries = [{}, ...(process.env.APIFY_CHROME_EXECUTABLE_PATH ? [{ executablePath: process.env.APIFY_CHROME_EXECUTABLE_PATH }] : []), { channel: 'chrome' }];
        browserPromise = (async () => {
            let lastErr;
            for (const t of tries) {
                try {
                    return await chromium.launch({ headless: true, args, ...t });
                } catch (err) {
                    lastErr = err;
                    log.warning(`Browser launch ${JSON.stringify(t)} failed: ${err.message.split('\n')[0]}`);
                }
            }
            throw lastErr;
        })();
    }
    return browserPromise;
}
export async function closeBrowser() {
    if (browserPromise) await (await browserPromise).close().catch(() => {});
}

function proxyOption(url) {
    if (!url) return undefined;
    const u = new URL(url);
    return { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined };
}

export class Session {
    /** @param route {{label, proxy, residential}} @param stats shared counters */
    constructor({ route, region, stats, msLeft }) {
        this.route = route;
        this.region = region;
        this.stats = stats;
        this.msLeft = msLeft;
        this.id = `t${Math.random().toString(36).slice(2, 12)}`;
        this.common = null;
        this.empties = 0;
        this.calls = 0;
    }

    async open() {
        const browser = await getBrowser();
        const proxyUrl = this.route.proxy ? await this.route.proxy.newUrl(this.id) : undefined;
        this.ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1366, height: 900 }, proxy: proxyOption(proxyUrl), ignoreHTTPSErrors: Boolean(process.env.TIKTOK_BASE) });
        this.page = await this.ctx.newPage();
        await this.page.route('**/*', (r) => (['image', 'media', 'font', 'stylesheet'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
        this.page.on('request', (r) => {
            if (this.common) return;
            const url = r.url();
            if (url.includes('/api/') && url.includes('device_id=')) {
                const u = new URL(url);
                for (const k of SIGN_PARAMS) u.searchParams.delete(k);
                this.common = u.searchParams;
            }
        });
        this.stats.sessions += 1;
        try {
            await this.page.goto(`${TIKTOK}/explore`, { waitUntil: 'domcontentloaded', timeout: 45000 });
            for (let i = 0; i < 60 && !this.common; i++) await this.page.waitForTimeout(250);
        } catch (err) {
            await this.close();
            throw new SessionError(`TikTok did not load (${err.message.split('\n')[0]})`);
        }
        if (!this.common) {
            await this.close();
            throw new SessionError('TikTok loaded without starting its web app (blocked or captcha)');
        }
        if (this.region) this.common.set('region', this.region);
        return this;
    }

    async close() {
        await this.ctx?.close().catch(() => {});
        this.ctx = null;
    }

    /** Cookie header that lets any client download this session's video files (TikTok checks tt_chain_token). */
    async mediaCookie() {
        if (this.cookieHeader !== undefined) return this.cookieHeader;
        const cookies = (await this.ctx?.cookies().catch(() => [])) ?? [];
        this.cookieHeader = cookies.filter((c) => c.name === 'tt_chain_token').map((c) => `${c.name}=${c.value}`).join('; ');
        return this.cookieHeader;
    }

    /**
     * One signed API call made by TikTok's own page. Returns parsed JSON, or null when TikTok answered with an empty
     * body (its soft block) after a few tries.
     */
    async api(path, params, { tries = 4 } = {}) {
        const q = new URLSearchParams(this.common);
        for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
        const url = `${path}?${q}`;
        for (let a = 0; a < tries; a++) {
            if (this.msLeft() <= 0) throw new StoppedError('run stopping');
            this.calls += 1;
            this.stats.apiCalls += 1;
            let r;
            try {
                r = await this.page.evaluate(async (u) => {
                    const ac = new AbortController();
                    const t = setTimeout(() => ac.abort(), 30000);
                    try {
                        const res = await fetch(u, { credentials: 'include', signal: ac.signal });
                        return { status: res.status, text: await res.text() };
                    } catch (e) {
                        return { status: 0, text: '', error: String(e) };
                    } finally {
                        clearTimeout(t);
                    }
                }, url);
            } catch (err) {
                throw new SessionError(`page error: ${err.message.split('\n')[0]}`);
            }
            this.stats.bytes += r.text.length;
            if (r.text && r.status < 400) {
                try {
                    const json = JSON.parse(r.text);
                    this.empties = 0;
                    return json;
                } catch { /* not JSON: treat like empty */ }
            }
            this.stats.emptyAnswers += 1;
            this.empties += 1;
            await sleep(1200 + a * 800);
        }
        return null;
    }

    /** A same-site HTML page fetched by the page (e.g. a profile, for its embedded data). */
    async html(path) {
        if (this.msLeft() <= 0) throw new StoppedError('run stopping');
        this.stats.htmlCalls += 1;
        const r = await this.page.evaluate(async (u) => {
            try {
                const res = await fetch(u, { credentials: 'include' });
                return { status: res.status, text: await res.text() };
            } catch (e) {
                return { status: 0, text: '' };
            }
        }, path).catch(() => ({ status: 0, text: '' }));
        this.stats.bytes += r.text.length;
        return r.status === 200 ? r.text : null;
    }
}

/**
 * Hands out sessions and replaces the ones TikTok stops answering. Routes switch (e.g. no proxy -> datacenter ->
 * residential) when sessions on a route keep failing.
 */
export class SessionPool {
    constructor({ routes, region, stats, msLeft, failAfter = 3, name = 'TikTok' }) {
        this.routes = routes.map((r) => ({ ...r, ok: 0, fail: 0, streak: 0 }));
        this.failAfter = failAfter;
        this.name = name;
        this.routeIdx = 0;
        this.region = region;
        this.stats = stats;
        this.msLeft = msLeft;
        this.firstOpen = new Promise((r) => { this.markOpen = r; }); // resolves once TikTok answered a first session
    }

    get route() {
        return this.routes[this.routeIdx];
    }

    async create() {
        let lastErr;
        for (let attempt = 0; attempt < 8; attempt++) {
            if (this.msLeft() <= 0) throw new StoppedError('run stopping');
            const route = this.route;
            try {
                const s = await new Session({ route, region: this.region, stats: this.stats, msLeft: this.msLeft }).open();
                route.ok += 1;
                route.streak = 0;
                this.markOpen(true);
                return s;
            } catch (err) {
                lastErr = err;
                this.failed(route);
                await sleep(1500);
            }
        }
        this.markOpen(false);
        throw new SessionError(`could not open TikTok on any route: ${lastErr?.message}`);
    }

    failed(route) {
        route.fail += 1;
        route.streak += 1;
        const idx = this.routes.indexOf(route);
        if (idx === this.routeIdx && route.streak >= this.failAfter && this.routeIdx < this.routes.length - 1) {
            this.routeIdx += 1;
            this.stats.routeSwitches += 1;
            log.warning(`${this.name}: TikTok keeps refusing "${route.label}". Switching to "${this.route.label}".`);
        }
    }

    /** Session gave up (too many empty answers): close it and open a fresh one. */
    async replace(session) {
        this.failed(session.route);
        this.stats.sessionRotations += 1;
        await session.close();
        return this.create();
    }

    summary() {
        return this.routes.map((r, i) => ({ route: r.label, used: i <= this.routeIdx, sessionsOpened: r.ok, sessionsFailed: r.fail, active: i === this.routeIdx }));
    }
}
