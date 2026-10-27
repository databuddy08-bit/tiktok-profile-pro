// Unit tests on real TikTok responses saved in test/fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProfileInput, profileStatus, authorMetaFromProfile, authorMetaFromItem, videoRow, listItems, embedVideoIds, parseDate, hashtags } from '../src/tiktok.js';

const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));

test('profile inputs: usernames, @handles, profile and video URLs; bad input reported', () => {
    assert.equal(parseProfileInput('apifytech').username, 'apifytech');
    assert.equal(parseProfileInput('@khaby.lame').username, 'khaby.lame');
    assert.equal(parseProfileInput('https://www.tiktok.com/@nasa?lang=en').username, 'nasa');
    assert.equal(parseProfileInput('tiktok.com/@nasa/video/7665075736742530317').username, 'nasa');
    assert.match(parseProfileInput('https://example.com/x').error, /not a valid/);
    assert.match(parseProfileInput('https://www.tiktok.com/tag/fyp').error, /profile link/);
    assert.equal(parseProfileInput('  '), null);
});

test('profile status and authorMeta with exact counters', () => {
    const ud = fx('user-detail-nasa.json');
    assert.equal(profileStatus(ud), 'ok');
    assert.equal(profileStatus(fx('user-detail-missing.json')), 'not_found');
    assert.equal(profileStatus(null), 'blocked');
    assert.equal(profileStatus({ userInfo: { user: { uniqueId: 'x', privateAccount: true } } }), 'private');
    const a = authorMetaFromProfile(ud);
    assert.equal(a.name, 'nasa');
    assert.equal(a.verified, true);
    assert.equal(a.fans, 2140972); // exact (statsV2), not "2.1M"
    assert.match(a.bioLink, /^https:\/\/science\.nasa\.gov/);
    assert.deepEqual(a.commerceUserInfo, { commerceUser: false });
    assert.ok(a.createTimeISO.startsWith('20'));
});

test('counter overflow (heartCount < 0) falls back to the exact value', () => {
    const a = authorMetaFromProfile({ userInfo: { user: { uniqueId: 'big', id: '1' }, stats: { heart: 2700000000, heartCount: -1604136309 }, statsV2: { heart: '2700000000', heartCount: '2690831083' } } });
    assert.equal(a.heart, 2700000000);
});

test('video rows from a list, a video page and a repost: same format as the TikTok Profile Scraper', () => {
    const vd = fx('video-detail.json').itemInfo.itemStruct;
    const am = authorMetaFromProfile(fx('user-detail-nasa.json'));
    const r = videoRow(vd, { authorMeta: am, input: 'nasa', section: 'videos' });
    for (const k of ['id', 'text', 'createTime', 'createTimeISO', 'isAd', 'authorMeta', 'musicMeta', 'webVideoUrl', 'mediaUrls', 'videoMeta', 'diggCount', 'shareCount', 'playCount', 'collectCount', 'commentCount', 'mentions', 'hashtags', 'effectStickers', 'isSlideshow', 'isPinned', 'input']) assert.ok(k in r, k);
    for (const k of ['height', 'width', 'duration', 'coverUrl', 'originalCoverUrl', 'definition', 'format', 'originalDownloadAddr', 'downloadAddr', 'subtitleLinks']) assert.ok(k in r.videoMeta, k);
    for (const k of ['musicName', 'musicAuthor', 'musicOriginal', 'playUrl', 'coverMediumUrl', 'originalCoverMediumUrl', 'musicId']) assert.ok(k in r.musicMeta, k);
    assert.equal(r.webVideoUrl, `https://www.tiktok.com/@nasa/video/${vd.id}`);
    assert.equal(typeof r.playCount, 'number');
    assert.equal(r.authorMeta.fans, am.fans);
    const reposts = listItems(fx('repost-item-list.json'));
    assert.equal(reposts.length, 3);
    const rr = videoRow(reposts[0], { input: 'nasa', section: 'reposts' });
    assert.equal(rr.fromProfileSection, 'reposts');
    assert.deepEqual(rr.authorMeta, authorMetaFromItem(reposts[0])); // reposts keep the original creator
    assert.ok(hashtags(reposts[0]).every((h) => Object.keys(h).join() === 'name'));
});

test('creator embed -> latest video ids', () => {
    const html = `<script id="__FRONTITY_CONNECT_STATE__" type="application/json">${JSON.stringify(fx('embed-nasa.json'))}</script>`;
    const ids = embedVideoIds(html, 'nasa');
    assert.equal(ids.length, 11);
    assert.ok(ids.every((x) => /^\d{15,}$/.test(x)));
    assert.deepEqual(embedVideoIds('<html></html>', 'nasa'), []);
});

test('dates: absolute, relative, invalid', () => {
    assert.equal(parseDate('2025-01-31', 'x'), Date.UTC(2025, 0, 31) / 1000);
    const rel = parseDate('30 days', 'x');
    assert.ok(Math.abs(rel - (Date.now() / 1000 - 30 * 86400)) < 5);
    assert.equal(parseDate('', 'x'), null);
    assert.throws(() => parseDate('yesterday-ish', 'x'), /not a date/);
});
