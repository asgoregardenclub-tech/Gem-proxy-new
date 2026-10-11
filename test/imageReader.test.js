import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { attachImages, buildImageRegex, sniffImageMime, clearImageCache } from '../src/lib/imageReader.js';
import { extractInlineCommands, applyInlineCommands } from '../src/lib/inlineCommands.js';

const cfg = {
  readImageHosts: ['ella.janitorai.com'],
  readImagePathPrefix: '/media-approved/',
  readImageMax: 4,
  readImageMaxBytes: 1024 * 1024,
  readImageTimeoutMs: 2000,
  readImageCacheBytes: 10 * 1024 * 1024,
};

const OK = 'https://ella.janitorai.com/media-approved/iRNgM2uIrrWyd-rsnZ8wq.webp';
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(16)]);

const realFetch = globalThis.fetch;
let calls;
function stubFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
}
const imgResponse = (buf, status = 200) => new Response(buf, { status, headers: { 'content-type': 'application/octet-stream' } });

beforeEach(() => clearImageCache());
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('regex matches the Janitor markdown form and bare links, nothing else', () => {
  const re = buildImageRegex(cfg.readImageHosts, cfg.readImagePathPrefix);
  const text = `a ![image](${OK}) b ${OK} c https://evil.com/media-approved/x.webp d https://ella.janitorai.com/other/x.webp e http://ella.janitorai.com/media-approved/x.webp`;
  const urls = [...text.matchAll(re)].map((m) => m[1] || m[2]);
  assert.deepEqual(urls, [OK, OK]);
});

test('regex does not accept a look-alike host', () => {
  const re = buildImageRegex(cfg.readImageHosts, cfg.readImagePathPrefix);
  const bad = 'https://ella.janitorai.com.evil.io/media-approved/x.webp';
  assert.equal([...bad.matchAll(re)].length, 0);
});

test('sniffs real formats from bytes', () => {
  assert.equal(sniffImageMime(WEBP), 'image/webp');
  assert.equal(sniffImageMime(PNG), 'image/png');
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.from('<html>nope</html>')), undefined);
});

test('user-turn link becomes text / inlineData / text in place', async () => {
  stubFetch(() => imgResponse(WEBP));
  const { contents, stats } = await attachImages(
    [{ role: 'user', parts: [{ text: `look at this ![image](${OK}) what is it?` }] }],
    cfg
  );
  assert.equal(contents[0].parts.length, 3);
  assert.deepEqual(contents[0].parts[0], { text: 'look at this ' });
  assert.equal(contents[0].parts[1].inlineData.mimeType, 'image/webp');
  assert.equal(contents[0].parts[1].inlineData.data, WEBP.toString('base64'));
  assert.deepEqual(contents[0].parts[2], { text: ' what is it?' });
  assert.deepEqual(stats, { found: 1, attached: 1, failed: 0, skipped: 0 });
});

test('same image across turns is downloaded once (cache)', async () => {
  stubFetch(() => imgResponse(WEBP));
  const turns = () => [{ role: 'user', parts: [{ text: `![image](${OK})` }] }];
  await attachImages(turns(), cfg);
  await attachImages(turns(), cfg);
  assert.equal(calls.length, 1);
});

test('redirects are refused and headers sent', async () => {
  stubFetch(() => imgResponse(WEBP));
  await attachImages([{ role: 'user', parts: [{ text: OK }] }], cfg);
  assert.equal(calls[0].init.redirect, 'error');
});

test('failed download leaves a note and does not throw', async () => {
  stubFetch(() => imgResponse(Buffer.from('nope'), 403));
  const { contents, stats } = await attachImages([{ role: 'user', parts: [{ text: `hi ${OK}` }] }], cfg);
  assert.equal(contents[0].parts.map((p) => p.text).join(''), 'hi [image could not be loaded]');
  assert.equal(stats.failed, 1);
});

test('non-image bytes are rejected', async () => {
  stubFetch(() => imgResponse(Buffer.from('<html>captcha</html>')));
  const { stats } = await attachImages([{ role: 'user', parts: [{ text: OK }] }], cfg);
  assert.equal(stats.failed, 1);
  assert.equal(stats.attached, 0);
});

test('oversized image is rejected', async () => {
  stubFetch(() => imgResponse(Buffer.concat([WEBP, Buffer.alloc(2 * 1024 * 1024)])));
  const { stats } = await attachImages([{ role: 'user', parts: [{ text: OK }] }], cfg);
  assert.equal(stats.failed, 1);
});

test('only the most recent READ_IMAGE_MAX images are read', async () => {
  stubFetch(() => imgResponse(WEBP));
  const u = (n) => `https://ella.janitorai.com/media-approved/img${n}.webp`;
  const { contents, stats } = await attachImages(
    [
      { role: 'user', parts: [{ text: `${u(1)} ${u(2)} ${u(3)}` }] },
      { role: 'model', parts: [{ text: 'ok' }] },
      { role: 'user', parts: [{ text: u(4) }] },
    ],
    { ...cfg, readImageMax: 2 }
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.url).sort(), [u(3), u(4)]);
  assert.equal(stats.skipped, 2);
  assert.match(contents[0].parts[0].text, /\[earlier image omitted\]/);
});

test('image link inside a model turn is hoisted onto the last user turn', async () => {
  stubFetch(() => imgResponse(PNG));
  const { contents } = await attachImages(
    [
      { role: 'model', parts: [{ text: `Character card ![image](${OK}) end` }] },
      { role: 'user', parts: [{ text: 'hello' }] },
    ],
    cfg
  );
  assert.equal(contents[0].parts.map((p) => p.text).join(''), 'Character card [image 1] end');
  const last = contents[1].parts;
  assert.equal(last[0].text, '[image 1, from an earlier message:]');
  assert.equal(last[1].inlineData.mimeType, 'image/png');
  assert.equal(last[2].text, 'hello');
});

test('no links -> contents returned untouched, no fetches', async () => {
  stubFetch(() => imgResponse(WEBP));
  const input = [{ role: 'user', parts: [{ text: 'just text' }] }];
  const { contents } = await attachImages(input, cfg);
  assert.equal(contents, input);
  assert.equal(calls.length, 0);
});

test('<READ_IMAGE=...> inline tag overrides config and is stripped', () => {
  const { commands, messages } = extractInlineCommands([
    { role: 'system', content: 'You are Bob.\n<READ_IMAGE=true>\nBe nice.' },
  ]);
  assert.equal(commands.readImage, true);
  assert.equal(messages[0].content, 'You are Bob.\nBe nice.');
  const { cfg: eff } = applyInlineCommands({ readImage: false }, {}, commands);
  assert.equal(eff.readImage, true);

  const off = extractInlineCommands([{ role: 'system', content: '<read_image: off>' }]).commands;
  assert.equal(applyInlineCommands({ readImage: true }, {}, off).cfg.readImage, false);
});
