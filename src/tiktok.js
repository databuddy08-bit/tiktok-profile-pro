// TikTok web data -> rows in the TikTok Profile Scraper format. Pure functions, unit-tested on real responses.

const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const iso = (sec) => (num(sec) ? new Date(Number(sec) * 1000).toISOString() : null);
/** Counters: statsV2 holds exact values as strings; the old int fields can overflow (heartCount < 0). */
const count = (v2, v1) => {
    const a = num(v2);
    if (a !== null && a >= 0) return a;
    const b = num(v1);
    return b !== null && b >= 0 ? b : null;
};

// ---------- input ----------
/** "user", "@user", "tiktok.com/@user", "https://www.tiktok.com/@user/video/123" -> {username} */
export function parseProfileInput(raw) {
    const input = String(raw ?? '').trim();
    if (!input) return null;
    let s = input;
    if (/tiktok\.com/i.test(s)) {
        const m = s.match(/tiktok\.com\/@([\w.]{1,40})/i);
        if (!m) return { input, error: 'not a TikTok profile link (expected tiktok.com/@username)' };
        s = m[1];
    }
    s = s.replace(/^@/, '').replace(/\/+$/, '');
    if (!/^[\w.]{1,40}$/.test(s)) return { input, error: `"${input}" is not a valid TikTok username` };
    return { input, username: s };
}

// ---------- profile page data ----------
/** The profile page's embedded data (__UNIVERSAL_DATA_FOR_REHYDRATION__) -> webapp.user-detail */
export function userDetailFromHtml(html) {
    const m = String(html ?? '').match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    try {
        return JSON.parse(m[1]).__DEFAULT_SCOPE__?.['webapp.user-detail'] ?? null;
    } catch {
        return null;
    }
}
export function videoDetailFromHtml(html) {
    const m = String(html ?? '').match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    try {
        return JSON.parse(m[1]).__DEFAULT_SCOPE__?.['webapp.video-detail'] ?? null;
    } catch {
        return null;
    }
}
/**
 * Profile status: ok | not_found | private | blocked (page served without data).
 * TikTok answers 10221 ("user banned"), 10202 / 10223 ("user not exist") for missing accounts.
 */
export function profileStatus(ud) {
    if (!ud) return 'blocked';
    const u = ud.userInfo?.user;
    if (!u?.uniqueId) return [10202, 10221, 10223, 10101].includes(ud.statusCode) || ud.statusCode ? 'not_found' : 'blocked';
    if (u.privateAccount || u.secret) return 'private';
    return 'ok';
}

/** authorMeta from the profile page (exact counters, bio link, business flags). */
export function authorMetaFromProfile(ud) {
    const u = ud.userInfo.user;
    const s1 = ud.userInfo.stats ?? {};
    const s2 = ud.userInfo.statsV2 ?? {};
    return {
        id: u.id ?? null,
        name: u.uniqueId,
        profileUrl: `https://www.tiktok.com/@${u.uniqueId}`,
        nickName: u.nickname ?? null,
        verified: Boolean(u.verified),
        signature: u.signature ?? '',
        bioLink: u.bioLink?.link ? (/^https?:\/\//.test(u.bioLink.link) ? u.bioLink.link : `https://${u.bioLink.link}`) : null,
        originalAvatarUrl: u.avatarLarger ?? null,
        avatar: u.avatarMedium ?? u.avatarLarger ?? null,
        commerceUserInfo: u.commerceUserInfo ?? { commerceUser: false },
        privateAccount: Boolean(u.privateAccount),
        region: u.region ?? null,
        roomId: u.roomId ?? '',
        ttSeller: Boolean(u.ttSeller),
        following: count(s2.followingCount, s1.followingCount),
        friends: count(s2.friendCount, s1.friendCount),
        fans: count(s2.followerCount, s1.followerCount),
        heart: count(s2.heart ?? s2.heartCount, s1.heart ?? s1.heartCount),
        video: count(s2.videoCount, s1.videoCount),
        digg: count(s2.diggCount, s1.diggCount),
        createTime: num(u.createTime),
        createTimeISO: iso(u.createTime),
        language: u.language ?? null,
        isOrganization: Boolean(u.isOrganization),
        secUid: u.secUid ?? null,
    };
}

/** authorMeta from a video's own author block (used when the profile page is not known, e.g. reposts). */
export function authorMetaFromItem(it) {
    const a = it.author ?? {};
    const s1 = it.authorStats ?? {};
    const s2 = it.authorStatsV2 ?? {};
    return {
        id: a.id ?? null,
        name: a.uniqueId ?? null,
        profileUrl: a.uniqueId ? `https://www.tiktok.com/@${a.uniqueId}` : null,
        nickName: a.nickname ?? null,
        verified: Boolean(a.verified),
        signature: a.signature ?? '',
        bioLink: null,
        originalAvatarUrl: a.avatarLarger ?? null,
        avatar: a.avatarMedium ?? a.avatarLarger ?? null,
        commerceUserInfo: a.commerceUserInfo ?? { commerceUser: false },
        privateAccount: Boolean(a.privateAccount),
        region: a.region ?? null,
        roomId: a.roomId ?? '',
        ttSeller: Boolean(a.ttSeller),
        following: count(s2.followingCount, s1.followingCount),
        friends: count(s2.friendCount, s1.friendCount),
        fans: count(s2.followerCount, s1.followerCount),
        heart: count(s2.heart ?? s2.heartCount, s1.heart ?? s1.heartCount),
        video: count(s2.videoCount, s1.videoCount),
        digg: count(s2.diggCount, s1.diggCount),
        secUid: a.secUid ?? null,
    };
}

// ---------- videos ----------
export const listItems = (json) => (json?.itemList ?? json?.item_list ?? []).filter((it) => it?.id);

function extras(it) {
    return [...(it.textExtra ?? []), ...(it.contents ?? []).flatMap((c) => c.textExtra ?? [])];
}
export function hashtags(it) {
    const seen = new Map();
    for (const t of extras(it)) if (t.hashtagName && !seen.has(t.hashtagName.toLowerCase())) seen.set(t.hashtagName.toLowerCase(), { name: t.hashtagName });
    for (const c of it.challenges ?? []) if (c.title && !seen.has(c.title.toLowerCase())) seen.set(c.title.toLowerCase(), { name: c.title });
    return [...seen.values()];
}
function mentions(it) {
    const m = new Map();
    for (const t of extras(it)) if (t.userUniqueId) m.set(t.userUniqueId, { id: t.userId || null, name: t.userUniqueId, profileUrl: `https://www.tiktok.com/@${t.userUniqueId}`, nickName: null });
    for (const x of String(it.desc ?? '').matchAll(/(?:^|\s)@([\w.]{2,24})/g)) if (!m.has(x[1])) m.set(x[1], { id: null, name: x[1], profileUrl: `https://www.tiktok.com/@${x[1]}`, nickName: null });
    return [...m.values()];
}

/**
 * One video row in the TikTok Profile Scraper format (same field names and nesting), plus a few extras
 * (detailedMentions, repostCount, locationCreated, fromProfileSection).
 */
export function videoRow(it, { authorMeta, input, section } = {}) {
    const v = it.video ?? {};
    const mu = it.music ?? {};
    const am = authorMeta ?? authorMetaFromItem(it);
    const author = it.author?.uniqueId ?? am.name;
    const isSlideshow = Boolean(it.imagePost?.images?.length);
    const images = (it.imagePost?.images ?? []).map((im) => im.imageURL?.urlList?.[0]).filter(Boolean);
    const row = {
        id: String(it.id),
        text: it.desc ?? '',
        textLanguage: it.textLanguage ?? null,
        createTime: num(it.createTime),
        createTimeISO: iso(it.createTime),
        isAd: Boolean(it.isAd),
        authorMeta: am,
        musicMeta: {
            musicName: mu.title ?? null,
            musicAuthor: mu.authorName ?? null,
            musicOriginal: Boolean(mu.original),
            musicAlbum: mu.album || null,
            playUrl: mu.playUrl || null,
            coverMediumUrl: mu.coverMedium ?? null,
            originalCoverMediumUrl: mu.coverMedium ?? null,
            musicId: mu.id ? String(mu.id) : null,
        },
        webVideoUrl: `https://www.tiktok.com/@${author}/${isSlideshow ? 'photo' : 'video'}/${it.id}`,
        mediaUrls: isSlideshow ? images : [v.playAddr].filter(Boolean),
        videoMeta: {
            height: num(v.height),
            width: num(v.width),
            duration: num(v.duration),
            coverUrl: v.cover || v.originCover || null,
            originalCoverUrl: v.cover || v.originCover || null,
            definition: v.definition ?? v.ratio ?? null,
            format: v.format ?? null,
            originalDownloadAddr: v.downloadAddr || v.playAddr || null,
            downloadAddr: v.downloadAddr || v.playAddr || null,
            subtitleLinks: (v.subtitleInfos ?? []).filter((s) => s.Url).map((s) => ({ language: s.LanguageCodeName ?? null, downloadLink: s.Url, tiktokLink: s.Url, source: s.Source ?? null, format: s.Format ?? null })),
        },
        diggCount: count(it.statsV2?.diggCount, it.stats?.diggCount),
        shareCount: count(it.statsV2?.shareCount, it.stats?.shareCount),
        playCount: count(it.statsV2?.playCount, it.stats?.playCount),
        collectCount: count(it.statsV2?.collectCount, it.stats?.collectCount),
        commentCount: count(it.statsV2?.commentCount, it.stats?.commentCount),
        repostCount: count(it.statsV2?.repostCount, it.stats?.repostCount),
        mentions: mentions(it).map((m) => `@${m.name}`),
        detailedMentions: mentions(it),
        hashtags: hashtags(it),
        effectStickers: (it.effectStickers ?? []).map((e) => ({ id: e.ID ?? e.id ?? null, name: e.name ?? null })),
        isSlideshow,
        isPinned: Boolean(it.isPinnedItem),
        isSponsored: Boolean(it.isAd),
        locationCreated: it.locationCreated ?? null,
        input: input ?? am.name,
        fromProfileSection: section ?? 'videos',
    };
    if (isSlideshow) row.slideshowImageLinks = images.map((u) => ({ tiktokLink: u, downloadLink: u }));
    return row;
}

/** The creator embed page (/embed/@user) -> latest video ids (used when the full list is refused). */
export function embedVideoIds(html, username) {
    const m = String(html ?? '').match(/<script id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return [];
    try {
        const data = JSON.parse(m[1]).source?.data ?? {};
        const page = Object.values(data).find((d) => Array.isArray(d?.videoList));
        return (page?.videoList ?? []).filter((x) => !username || !x.authorUniqueId || x.authorUniqueId.toLowerCase() === username.toLowerCase()).map((x) => String(x.id));
    } catch {
        return [];
    }
}

/** "2025-01-31", "2025-01-31T10:00:00Z" or "30 days" / "2 weeks" -> Unix seconds; null when empty. Throws on bad input. */
export function parseDate(s, name) {
    if (s === undefined || s === null || String(s).trim() === '') return null;
    const str = String(s).trim();
    const rel = str.match(/^(\d+)\s*(minute|hour|day|week|month|year)s?(\s+ago)?$/i);
    const d = rel ? new Date(Date.now() - Number(rel[1]) * { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[rel[2].toLowerCase()]) : new Date(str);
    if (Number.isNaN(d.getTime())) throw new Error(`"${str}" in "${name}" is not a date. Use 2025-01-31 or a relative time like "30 days".`);
    return Math.floor(d.getTime() / 1000);
}
