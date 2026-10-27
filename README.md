# TikTok Profile Scraper Pro: Profiles, Videos & Reposts

Extract data from TikTok profiles and the videos they post or repost.

**Profile data:**
- name, nickname, ID, bio and bio link;
- verified, private, business and TikTok Shop seller flags;
- exact followers, following, likes, friends and video counts;
- account creation date.

**Every video:**
- caption, link, publish time and pinned flag;
- plays, likes, comments, shares and saves;
- hashtags and mentions;
- video, cover and music metadata, and subtitle tracks.

**Optional:** store the MP4s, covers, subtitles, slideshow images, avatars and music covers in a key-value store.

**No login. Same output format as the popular TikTok Profile Scraper**, so existing integrations keep working.

## Input

```json
{
  "profiles": ["apifytech", "@nasa", "https://www.tiktok.com/@khaby.lame"],
  "profileScrapeSections": ["videos", "reposts"],
  "profileSorting": "latest",
  "resultsPerPage": 100,
  "oldestPostDateUnified": "90 days",
  "leastDiggs": 100,
  "shouldDownloadVideos": false,
  "shouldDownloadCovers": false,
  "shouldDownloadSubtitles": false
}
```

**Inputs:**
- **Profiles:** usernames with or without @, profile URLs, or even a video URL (its creator is used).
- **Sections:** the videos a profile posted, and/or its reposts.
- **Sort:** Latest, Popular or Oldest, the same as the tabs on TikTok.
- **Filters:**
  - published after / before (`2025-01-31` or "30 days");
  - minimum / maximum likes;
  - exclude pinned videos.
  - Filtered videos are free. With *Latest* sorting, the scraper stops paging once it passes your start date.
- **Downloads** (add-ons):
  - Stored files replace the TikTok links: `videoMeta.downloadAddr`, `videoMeta.coverUrl`, `subtitleLinks[].downloadLink`, `slideshowImageLinks[].downloadLink`, `authorMeta.avatar` and `musicMeta.coverMediumUrl`.
  - The TikTok originals stay in `originalDownloadAddr`, `originalCoverUrl`, `tiktokLink`, `originalAvatarUrl` and `originalCoverMediumUrl`.

## Output (shortened, real run)

```json
{
  "id": "7665075736742530317",
  "text": "Something big just landed on TikTok.",
  "createTime": 1784664542,
  "createTimeISO": "2026-07-21T20:09:02.000Z",
  "isAd": false,
  "authorMeta": {
    "id": "7664638705177150477", "name": "nasa", "nickName": "NASA", "verified": true,
    "signature": "Making the seemingly impossible, possible.✨",
    "bioLink": "https://science.nasa.gov/feature/artemis-ii-preliminary-lunar-science-report",
    "commerceUserInfo": { "commerceUser": false }, "privateAccount": false, "ttSeller": false,
    "following": 23, "friends": 17, "fans": 2140977, "heart": 11391468, "video": 60, "digg": 0
  },
  "musicMeta": { "musicName": "original sound", "musicAuthor": "NASA", "musicOriginal": true, "musicId": "…", "playUrl": "https://…" },
  "webVideoUrl": "https://www.tiktok.com/@nasa/video/7665075736742530317",
  "mediaUrls": ["https://…"],
  "videoMeta": { "height": 1280, "width": 720, "duration": 25, "definition": "720p", "format": "mp4", "coverUrl": "https://…", "originalCoverUrl": "https://…", "downloadAddr": "https://…", "originalDownloadAddr": "https://…", "subtitleLinks": [{ "language": "eng-US", "downloadLink": "https://…", "tiktokLink": "https://…" }] },
  "diggCount": 108200, "shareCount": 4100, "playCount": 1700000, "collectCount": 9800, "commentCount": 3100,
  "mentions": [], "hashtags": [], "effectStickers": [],
  "isSlideshow": false, "isPinned": false,
  "input": "nasa",
  "fromProfileSection": "videos"
}
```

- Counters are **exact** (2,140,977 followers, not "2.1M"). They are also safe on huge accounts, where TikTok's own like counter can overflow into a negative number.
- Reposts keep the original creator in `authorMeta`, and `input` shows whose profile they came from.

## Error items (free)

When a profile can't be scraped, the dataset gets a free error item instead of silence:

```json
{ "url": "https://www.tiktok.com/@someuser", "input": "someuser", "error": "Profile is private", "errorCode": "PROFILE_PRIVATE" }
```

| errorCode | Meaning |
|---|---|
| `NOT_FOUND` | Profile does not exist, or was banned or renamed |
| `PROFILE_PRIVATE` | Profile is private |
| `PROFILE_EMPTY` | Profile has no videos, or TikTok refused the video list |
| `PROFILE_REPOSTS_EMPTY` | Profile has no public reposts |
| `FILTER_NO_PASS` | Videos exist, but none match the date or like filters |
| `INVALID_URLS` | The input is not a TikTok username or profile URL |
| `INVALID_INPUT` | Bad configuration (the run stops) |

## How it stays reliable without login

- **Profile pages, reposts, playlists and single videos** load without any proxy.
- **The full video list:** TikTok refuses it to logged-out visitors on many datacenter IPs. For these lists only, the scraper switches to Apify **RESIDENTIAL** proxies automatically. Videos listed that way add the small `residential-video` extra.
- **If every route is refused**, the scraper still saves what the profile shows publicly: its latest posts and its playlists. These rows are marked with `dataSource` (`latest_posts`, `playlist:<name>`). You can turn this off with *Public fallback*.
- **File downloads** never go through a proxy, so they stay fast and cheap.

## Pricing (pay per event)

| Event | When | Free / Starter | Scale | Business |
|---|---|---|---|---|
| `tiktok-video` | One video saved | $1.50 / 1,000 | $1.10 / 1,000 | $0.80 / 1,000 |
| `video-download` | Add-on: one MP4 stored | $5.00 / 1,000 | $4.00 / 1,000 | $3.00 / 1,000 |
| `media-download` | Add-on: one cover, subtitle, slideshow image, avatar or music cover stored | $0.40 / 1,000 | $0.30 / 1,000 | $0.25 / 1,000 |
| `residential-video` | Extra, only for videos listed through a RESIDENTIAL proxy | $0.50 / 1,000 | $0.40 / 1,000 | $0.30 / 1,000 |

- Error items, filtered videos and duplicates are **never charged**.
- The run stops cleanly at your **Maximum cost per run**, with the add-ons counted.

## Run summary

Every run saves a `RUN_SUMMARY` in the key-value store. It contains:
- videos per profile and per section;
- where the videos came from (full list or public fallback);
- skip reasons, error items and fill rates;
- files stored, and the network route used for pages and for video lists.

## Good to know

- **TikTok links expire:** video and image links are signed by TikTok and expire after a few hours. Turn on downloads if you need the files later.
- **Comments and followers lists are not included.** TikTok shows them on the web only to logged-in users.
- **Memory:** 2 GB (a headless browser runs inside, because TikTok signs every request).

## Legal

Only publicly visible data is collected. Profiles can contain personal data under the GDPR and similar laws. Use it for a legitimate purpose and follow TikTok's terms.
