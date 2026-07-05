'use strict';

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const cheerio     = require('cheerio');
const fs          = require('fs');
const path        = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID  = parseInt(process.env.ADMIN_ID, 10);

if (!BOT_TOKEN) { console.error('ERROR: BOT_TOKEN is missing in .env'); process.exit(1); }
if (!ADMIN_ID)  { console.error('ERROR: ADMIN_ID is missing in .env');  process.exit(1); }

const SITES_FILE    = path.join(__dirname, 'sites.json');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

const MAX_CRAWL_DEPTH   = 4;
const MAX_CRAWL_PAGES   = 30;
const PAGE_TIMEOUT      = 12_000;
const MAX_SEARCH_HITS   = 5;
const MAX_FILE_SIZE     = 2 * 1024 * 1024 * 1024;

const DOWNLOADABLE_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.zip', '.rar', '.7z', '.pdf', '.apk', '.mp3'];
const DOWNLOAD_KEYWORDS = ['download', 'direct download', 'direct link', 'watch', 'get file',
                           '480p', '720p', '1080p', '2160p', '4k', 'hdrip', 'webrip', 'bluray'];
const QUALITY_LABELS    = ['2160p', '4k', '1080p', '720p', '480p', '360p'];
const SKIP_EXTS         = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp',
                           '.css', '.js', '.ico', '.woff', '.woff2', '.ttf', '.xml', '.json'];
const SKIP_WORDS        = ['login', 'signin', 'sign-in', 'register', 'signup', 'sign-up',
                           'checkout', 'payment', 'cart', 'account', 'facebook.com',
                           'twitter.com', 'instagram.com', 'google.com', 'youtube.com',
                           'advertisement', 'tracking', 'analytics', 'doubleclick'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadSites() {
  try { return JSON.parse(fs.readFileSync(SITES_FILE, 'utf8')); }
  catch { return []; }
}

function saveSites(sites) {
  fs.writeFileSync(SITES_FILE, JSON.stringify(sites, null, 2));
}

function ensureDownloadsDir() {
  if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

function deleteTempFile(filePath) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

function isAdmin(userId) { return userId === ADMIN_ID; }

function normalizeUrl(rawHref, base) {
  try {
    const u = new URL(rawHref, base);
    u.hash = '';
    return u.href;
  } catch { return null; }
}

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function sameDomain(url, base) {
  return getDomain(url) === getDomain(base);
}

function shouldSkip(url) {
  const lower = url.toLowerCase();
  if (SKIP_EXTS.some(e => lower.endsWith(e))) return true;
  if (SKIP_WORDS.some(w => lower.includes(w))) return true;
  return false;
}

function detectQuality(text) {
  const t = text.toLowerCase();
  for (const q of QUALITY_LABELS) {
    if (t.includes(q.toLowerCase())) return q.toUpperCase();
  }
  return 'Unknown Quality';
}

function isDownloadLink(href, text) {
  const h = href.toLowerCase();
  const t = (text || '').toLowerCase();
  if (DOWNLOADABLE_EXTS.some(e => h.includes(e))) return true;
  if (DOWNLOAD_KEYWORDS.some(k => t.includes(k))) return true;
  return false;
}

const httpClient = axios.create({
  timeout: PAGE_TIMEOUT,
  headers: {
    'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate',
  },
  maxRedirects: 6,
  validateStatus: s => s < 400,
});

async function fetchHtml(url) {
  const resp = await httpClient.get(url);
  return resp.data;
}

// ─── Web Search (DuckDuckGo HTML → Google fallback) ──────────────────────────

async function searchDuckDuckGo(query, domain) {
  const q    = encodeURIComponent(`${query} site:${domain}`);
  const url  = `https://html.duckduckgo.com/html/?q=${q}`;
  const html = await fetchHtml(url);
  const $    = cheerio.load(html);
  const urls = [];

  $('a.result__url, a.result__a, .result__body a').each((_, el) => {
    const href  = $(el).attr('href') || '';
    const match = href.match(/uddg=([^&]+)/);
    const real  = match ? decodeURIComponent(match[1]) : href;
    try {
      const parsed = new URL(real);
      if (getDomain(parsed.href) === domain.replace(/^www\./, '')) {
        if (!urls.includes(parsed.href)) urls.push(parsed.href);
      }
    } catch {}
  });

  return urls;
}

async function searchGoogle(query, domain) {
  const q    = encodeURIComponent(`${query} site:${domain}`);
  const url  = `https://www.google.com/search?q=${q}&num=10&hl=en`;
  let   html;
  try { html = await fetchHtml(url); }
  catch { return []; }

  const $ = cheerio.load(html);
  const urls = [];

  $('a').each((_, el) => {
    const href  = $(el).attr('href') || '';
    const match = href.match(/\/url\?q=([^&]+)/);
    if (!match) return;
    const real = decodeURIComponent(match[1]);
    try {
      const parsed = new URL(real);
      if (getDomain(parsed.href) === domain.replace(/^www\./, '')) {
        if (!urls.includes(parsed.href)) urls.push(parsed.href);
      }
    } catch {}
  });

  return urls;
}

async function searchWeb(query, domain) {
  try {
    const ddg = await searchDuckDuckGo(query, domain);
    if (ddg.length > 0) return ddg.slice(0, MAX_SEARCH_HITS);
  } catch (err) {
    console.error('DDG search failed:', err.message);
  }

  try {
    const google = await searchGoogle(query, domain);
    return google.slice(0, MAX_SEARCH_HITS);
  } catch (err) {
    console.error('Google search failed:', err.message);
  }

  return [];
}

// ─── Deep Crawler ─────────────────────────────────────────────────────────────

async function deepCrawlForDownloads(startUrl, homepageUrl) {
  const visited  = new Set();
  const queue    = [{ url: startUrl, depth: 0 }];
  const allLinks = [];

  while (queue.length > 0 && visited.size < MAX_CRAWL_PAGES) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    let html;
    try { html = await fetchHtml(url); }
    catch { continue; }

    const $ = cheerio.load(html);

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim();
      const abs  = normalizeUrl(href, url);
      if (!abs) return;

      if (isDownloadLink(abs, text)) {
        const quality = detectQuality(text + ' ' + abs);
        const label   = (text || quality).substring(0, 80);
        if (!allLinks.find(l => l.url === abs)) {
          allLinks.push({ label, url: abs, quality, sourcePage: url });
        }
      }
    });

    if (depth < MAX_CRAWL_DEPTH) {
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const abs  = normalizeUrl(href, url);
        if (!abs) return;
        if (!sameDomain(abs, homepageUrl)) return;
        if (shouldSkip(abs)) return;
        if (visited.has(abs)) return;
        const text  = ($(el).text() + abs).toLowerCase();
        const score = DOWNLOAD_KEYWORDS.some(k => text.includes(k)) ? 0 : 1;
        queue.push({ url: abs, depth: depth + 1, score });
      });
      queue.sort((a, b) => (a.score || 1) - (b.score || 1));
    }

    if (allLinks.length >= 20) break;
  }

  return allLinks;
}

// ─── Main Search ─────────────────────────────────────────────────────────────

async function runSearch(chatId, query) {
  const sites = loadSites();

  if (sites.length === 0) {
    return sendMsg(chatId, '❌ No websites added yet. Ask the admin to add some with /addsite.');
  }

  const progressMsg = await sendMsg(chatId, `🔍 Searching for *"${query}"*…`, { parse_mode: 'Markdown' });
  const mid = progressMsg && progressMsg.message_id;

  const allLinks = [];

  for (const site of sites) {
    const domain = getDomain(site.url);

    try {
      await editMsg(chatId, mid,
        `🌐 Searching *${site.name}* — \`${query} site:${domain}\`…`,
        { parse_mode: 'Markdown' });

      const resultUrls = await searchWeb(query, domain);

      if (resultUrls.length === 0) {
        console.log(`[${site.name}] No search results for "${query}"`);
        continue;
      }

      await editMsg(chatId, mid,
        `📂 Found ${resultUrls.length} result(s) on *${site.name}* — crawling for download links…`,
        { parse_mode: 'Markdown' });

      for (const resultUrl of resultUrls) {
        const links = await deepCrawlForDownloads(resultUrl, site.url);
        links.forEach(l => { l.siteName = site.name; allLinks.push(l); });
        if (allLinks.length >= 20) break;
      }
    } catch (err) {
      console.error(`[${site.name}] Error:`, err.message);
    }
  }

  if (allLinks.length === 0) {
    await editMsg(chatId, mid,
      `❌ No download links found for *"${query}"*. Try different keywords.`,
      { parse_mode: 'Markdown' });
    return;
  }

  const seen    = new Set();
  const deduped = allLinks.filter(l => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  }).slice(0, 15);

  sessions[chatId] = deduped;

  const keyboard = deduped.map((item, i) => [{
    text: `[${item.quality}] ${item.label.substring(0, 45)} — ${item.siteName}`,
    callback_data: `dl:${chatId}:${i}`,
  }]);

  await editMsg(chatId, mid,
    `✅ Found *${deduped.length}* download option(s) for *"${query}"*. Choose one:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
}

// ─── Download ─────────────────────────────────────────────────────────────────

function validateDownloadUrl(fileUrl) {
  let parsed;
  try { parsed = new URL(fileUrl); }
  catch { throw new Error('Invalid download URL.'); }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Download URL must use http or https.');
  }

  const h = parsed.hostname.toLowerCase();
  const blocked = [
    /^localhost$/, /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
    /^::1$/, /^0\.0\.0\.0$/, /^169\.254\./,
  ];
  if (blocked.some(r => r.test(h))) throw new Error('Blocked address.');
}

async function downloadFile(fileUrl) {
  validateDownloadUrl(fileUrl);
  ensureDownloadsDir();

  const parsed   = new URL(fileUrl);
  const basename = path.basename(parsed.pathname) || 'file';
  const safeName = basename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dest     = path.join(DOWNLOADS_DIR, `${Date.now()}_${safeName}`);

  const resp = await axios.get(fileUrl, {
    responseType: 'stream',
    timeout: 0,
    headers: { 'User-Agent': httpClient.defaults.headers['User-Agent'] },
    maxRedirects: 10,
  });

  const cl = parseInt(resp.headers['content-length'] || '0', 10);
  if (cl > MAX_FILE_SIZE) { resp.data.destroy(); throw new Error('FILE_TOO_LARGE'); }

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(dest);
    let received = 0;

    resp.data.on('data', chunk => {
      received += chunk.length;
      if (received > MAX_FILE_SIZE) {
        resp.data.destroy();
        writer.destroy();
        deleteTempFile(dest);
        reject(new Error('FILE_TOO_LARGE'));
      }
    });

    resp.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error',    e => { deleteTempFile(dest); reject(e); });
    resp.data.on('error', e => { deleteTempFile(dest); reject(e); });
  });

  return dest;
}

// ─── Session store ────────────────────────────────────────────────────────────

const sessions = {};

// ─── Bot ─────────────────────────────────────────────────────────────────────

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function sendMsg(chatId, text, opts) {
  return bot.sendMessage(chatId, text, opts).catch(console.error);
}

function editMsg(chatId, messageId, text, opts) {
  return bot
    .editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts })
    .catch(() => {});
}

// ─── Callback ─────────────────────────────────────────────────────────────────

bot.on('callback_query', async cq => {
  const data   = cq.data || '';
  const chatId = cq.message.chat.id;
  await bot.answerCallbackQuery(cq.id);

  if (!data.startsWith('dl:')) return;

  const [, , idxStr] = data.split(':');
  const idx   = parseInt(idxStr, 10);
  const items = sessions[chatId];

  if (!items || !items[idx]) {
    return sendMsg(chatId, '❌ Session expired. Please search again.');
  }

  const item     = items[idx];
  let   filePath = null;

  try {
    await sendMsg(chatId,
      `⬇️ Downloading file…\n\`${item.url.substring(0, 90)}\``,
      { parse_mode: 'Markdown' });

    filePath = await downloadFile(item.url);

    await sendMsg(chatId, '🔎 Checking file size…');
    const { size } = fs.statSync(filePath);

    if (size > MAX_FILE_SIZE) {
      deleteTempFile(filePath);
      return sendMsg(chatId, '❌ File is too large. Telegram limit is 2 GB.');
    }

    await sendMsg(chatId, '📤 Uploading to Telegram…');

    await bot.sendDocument(chatId, filePath, {
      caption   : `*${item.label}* — ${item.quality}`,
      parse_mode: 'Markdown',
    });

    deleteTempFile(filePath);
    await sendMsg(chatId, '✅ Done.');
  } catch (err) {
    deleteTempFile(filePath);
    console.error('Error:', err.message);

    if (err.message === 'FILE_TOO_LARGE')
      return sendMsg(chatId, '❌ File is too large. Telegram limit is 2 GB.');
    if (err.message.includes('download') || err.message.includes('URL') || err.message.includes('Blocked'))
      return sendMsg(chatId, '❌ Download failed. Please try another result.');
    return sendMsg(chatId, '❌ Upload failed. Please try another result.');
  }
});

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.onText(/\/start/, msg =>
  sendMsg(msg.chat.id,
    `👋 *Welcome!*\n\nSearch for any movie or file:\n\n• \`/mv Inception\`\n• Or just type: *Inception*\n\nUse /help to see all commands.`,
    { parse_mode: 'Markdown' })
);

bot.onText(/\/help/, msg =>
  sendMsg(msg.chat.id,
    `📖 *Commands*\n\n` +
    `/start — Welcome message\n` +
    `/help — Show this help\n` +
    `/mv <name> — Search for a movie or file\n\n` +
    `*Or just type the name directly.*\n\n` +
    `*Admin only:*\n` +
    `/addsite name | url — Add a website\n` +
    `/listsites — List added websites\n` +
    `/removesite name — Remove a website`,
    { parse_mode: 'Markdown' })
);

bot.onText(/\/addsite (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return sendMsg(chatId, '⛔ Admin only.');

  const parts = match[1].split('|').map(s => s.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    return sendMsg(chatId, '❌ Format: /addsite Name | https://example.com');
  }

  const [name, rawUrl] = parts;
  let parsedUrl;
  try { parsedUrl = new URL(rawUrl); }
  catch { return sendMsg(chatId, '❌ Invalid URL. Must start with http:// or https://'); }

  const sites = loadSites();
  if (sites.find(s => s.name.toLowerCase() === name.toLowerCase())) {
    return sendMsg(chatId, `❌ Site "${name}" already exists. Remove it first.`);
  }

  sites.push({ name, url: parsedUrl.origin });
  saveSites(sites);
  sendMsg(chatId, `✅ Site added:\n*${name}* — ${parsedUrl.origin}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/listsites/, msg => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return sendMsg(chatId, '⛔ Admin only.');

  const sites = loadSites();
  if (sites.length === 0) return sendMsg(chatId, '📭 No sites added yet.');

  const list = sites.map((s, i) => `${i + 1}. *${s.name}*\n   ${s.url}`).join('\n\n');
  sendMsg(chatId, `🌐 *Sites:*\n\n${list}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/removesite (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return sendMsg(chatId, '⛔ Admin only.');

  const name   = match[1].trim();
  let   sites  = loadSites();
  const before = sites.length;

  sites = sites.filter(s => s.name.toLowerCase() !== name.toLowerCase());
  if (sites.length === before) return sendMsg(chatId, `❌ No site named "${name}" found.`);

  saveSites(sites);
  sendMsg(chatId, `✅ *"${name}"* removed.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/mv (.+)/, (msg, match) => {
  const query = match[1].trim();
  if (!query) return sendMsg(msg.chat.id, '❌ Example: /mv Inception');
  runSearch(msg.chat.id, query);
});

// ─── Plain text = search ───────────────────────────────────────────────────────

bot.on('message', msg => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const query = msg.text.trim();
  if (query) runSearch(msg.chat.id, query);
});

// ─── Errors ───────────────────────────────────────────────────────────────────

bot.on('polling_error', err => console.error('Polling error:', err.message));
process.on('unhandledRejection', err => console.error('Unhandled:', err));

// ─── Init ─────────────────────────────────────────────────────────────────────

ensureDownloadsDir();
console.log('Bot is running…');
