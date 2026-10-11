// READ_IMAGE: lets Gemini actually *see* images that Janitor puts in the chat.
//
// Janitor's official media library links look like
//   ![image](https://ella.janitorai.com/media-approved/iRNgM2uIrrWyd-rsnZ8wq.webp)
// Gemini can't fetch those itself, so when READ_IMAGE is on we:
//   1. find every such link in the final Gemini `contents`,
//   2. download it here (cached — Janitor resends the whole chat on every
//      message, so without a cache the same image would be re-downloaded
//      on every single turn),
//   3. replace the link with an `inlineData` part (base64) that Gemini reads.
//
// Safety rails (this is a server making outbound requests on behalf of
// whatever text lands in a chat, so it is deliberately strict):
//   - only https URLs on an allow-listed host + path prefix are ever fetched
//     (default: ella.janitorai.com/media-approved/), redirects are refused;
//   - only real PNG / JPEG / WEBP bytes are accepted (sniffed from the file
//     header, not trusted from the Content-Type), size-capped;
//   - at most READ_IMAGE_MAX images per request (the most recent ones), so a
//     long chat full of pictures can't blow up the request or your quota.
//
// Anything that can't be loaded is replaced with a short bracketed note so
// the model knows an image was there; a failed image never fails the request.

const MIME_EXT = '(?:webp|png|jpe?g)';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matches either a markdown image  ![alt](URL)  or a bare URL. Group 1 is the
// URL for the markdown form, group 2 for the bare form.
export function buildImageRegex(hosts, pathPrefix) {
  const hostAlt = hosts.map(escapeRegex).join('|');
  const prefix = escapeRegex(pathPrefix);
  const url = `https:\\/\\/(?:${hostAlt})${prefix}[\\w.~-]+\\.${MIME_EXT}(?:\\?[\\w=&.~%-]*)?`;
  return new RegExp(`!\\[[^\\]]*\\]\\(\\s*(${url})\\s*\\)|(${url})`, 'gi');
}

// Sniff the real format from the first bytes. Gemini accepts these three
// (plus HEIC/HEIF, which Janitor's library doesn't serve).
export function sniffImageMime(buf) {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return undefined;
}

// ---- tiny in-memory LRU cache (url -> { mimeType, data(base64) }) ---------
const cache = new Map();
let cacheBytes = 0;
const inflight = new Map();

function cacheGet(url) {
  const hit = cache.get(url);
  if (!hit) return undefined;
  cache.delete(url); // re-insert = mark as most recently used
  cache.set(url, hit);
  return hit;
}

function cacheSet(url, entry, maxBytes) {
  const size = entry.data.length;
  if (size > maxBytes) return;
  cache.set(url, entry);
  cacheBytes += size;
  while (cacheBytes > maxBytes && cache.size) {
    const [oldestUrl, oldest] = cache.entries().next().value;
    cache.delete(oldestUrl);
    cacheBytes -= oldest.data.length;
  }
}

export function clearImageCache() {
  cache.clear();
  inflight.clear();
  cacheBytes = 0;
}

async function download(url, cfg) {
  const res = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(cfg.readImageTimeoutMs),
    headers: {
      accept: 'image/webp,image/png,image/jpeg,image/*;q=0.8',
      'user-agent': 'Mozilla/5.0 (compatible; gemini-railway-proxy)',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > cfg.readImageMaxBytes) throw new Error(`too large (${declared} bytes)`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > cfg.readImageMaxBytes) throw new Error(`too large (${buf.length} bytes)`);

  const mimeType = sniffImageMime(buf);
  if (!mimeType) throw new Error('not a PNG/JPEG/WEBP image');

  return { mimeType, data: buf.toString('base64') };
}

// Returns { mimeType, data } or throws. Concurrent callers for the same URL
// share one download.
async function loadImage(url, cfg) {
  const cached = cacheGet(url);
  if (cached) return cached;

  let pending = inflight.get(url);
  if (!pending) {
    pending = download(url, cfg)
      .then((entry) => {
        cacheSet(url, entry, cfg.readImageCacheBytes);
        return entry;
      })
      .finally(() => inflight.delete(url));
    inflight.set(url, pending);
  }
  return pending;
}

// Takes the Gemini `contents` array (every part is { text } at this point)
// and returns a new one with image links swapped for inlineData parts.
//
// Placement: in a `user` turn the image goes inline, right where the link
// was. Gemini only takes images on user turns, so a link inside a `model`
// turn (e.g. the character card header, or an earlier bot message) becomes
// "[image N]" in place, and the picture itself is attached to the final user
// turn labelled with the same number.
export async function attachImages(contents, cfg) {
  const regex = buildImageRegex(cfg.readImageHosts, cfg.readImagePathPrefix);
  const stats = { found: 0, attached: 0, failed: 0, skipped: 0 };

  // Pass 1: find every image link, in conversation order.
  const found = []; // { url, turnIdx, start, end }
  contents.forEach((turn, turnIdx) => {
    const text = turn.parts?.[0]?.text;
    if (typeof text !== 'string') return;
    for (const m of text.matchAll(regex)) {
      found.push({ url: m[1] || m[2], turnIdx, start: m.index, end: m.index + m[0].length });
    }
  });
  stats.found = found.length;
  if (!found.length) return { contents, stats };

  // Only the most recent N are read; older ones become a note.
  const max = Math.max(0, cfg.readImageMax);
  const liveFrom = Math.max(0, found.length - max);
  const urls = [...new Set(found.slice(liveFrom).map((f) => f.url))];

  const loaded = new Map(); // url -> entry | null
  await Promise.all(
    urls.map(async (url) => {
      try {
        loaded.set(url, await loadImage(url, cfg));
      } catch (err) {
        loaded.set(url, null);
        console.warn(`[read_image] could not load ${url}: ${err.message}`);
      }
    })
  );

  // Pass 2: rebuild each turn.
  const byTurn = new Map();
  found.forEach((f, i) => {
    if (!byTurn.has(f.turnIdx)) byTurn.set(f.turnIdx, []);
    byTurn.get(f.turnIdx).push({ ...f, live: i >= liveFrom });
  });

  const hoisted = []; // images from model turns, attached to the last user turn
  const out = contents.map((turn, turnIdx) => {
    const hits = byTurn.get(turnIdx);
    if (!hits) return turn;

    const text = turn.parts[0].text;
    const parts = [];
    let cursor = 0;
    const pushText = (t) => {
      if (t) parts.push({ text: t });
    };

    for (const hit of hits) {
      pushText(text.slice(cursor, hit.start));
      cursor = hit.end;

      const entry = hit.live ? loaded.get(hit.url) : undefined;
      if (!hit.live) {
        stats.skipped++;
        pushText('[earlier image omitted]');
      } else if (!entry) {
        stats.failed++;
        pushText('[image could not be loaded]');
      } else if (turn.role === 'user') {
        stats.attached++;
        parts.push({ inlineData: { mimeType: entry.mimeType, data: entry.data } });
      } else {
        stats.attached++;
        hoisted.push(entry);
        pushText(`[image ${hoisted.length}]`);
      }
    }
    pushText(text.slice(cursor));

    return { ...turn, parts: parts.length ? parts : [{ text: '.' }] };
  });

  if (hoisted.length) {
    const last = out[out.length - 1];
    const extra = [];
    hoisted.forEach((entry, i) => {
      extra.push({ text: `[image ${i + 1}, from an earlier message:]` });
      extra.push({ inlineData: { mimeType: entry.mimeType, data: entry.data } });
    });
    out[out.length - 1] = { ...last, parts: [...extra, ...last.parts] };
  }

  return { contents: out, stats };
}
