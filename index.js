'use strict';

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID  = parseInt(process.env.ADMIN_ID, 10);

if (!BOT_TOKEN) { console.error('ERROR: BOT_TOKEN is missing in .env'); process.exit(1); }
if (!ADMIN_ID)  { console.error('ERROR: ADMIN_ID is missing in .env');  process.exit(1); }

const SITES_FILE    = path.join(__dirname, 'sites.json');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const MAX_DEPTH     = 3;
const MAX_PAGES     = 50;
const PAGE_TIMEOUT  = 10_000;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB in bytes

const DOWNLOADABLE_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.zip', '.rar', '.7z', '.pdf', '.apk', '.mp3'];
const DOWNLOAD_KEYWORDS = ['download', 'direct download', 'watch', '480p', '720p', '1080p', 'file', 'get file'];
const QUALITY_LABELS    = ['2160p', '4k', '1080p', '720p', '480p', '360p'];
const SKIP_EXTS         = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.css', '.js', '.ico', '.woff', '.woff2', '.ttf'];
const SKIP_KEYWORDS     = ['login', 'signin', 'sign-in', 'register', 'signup', 'sign-up', 'checkout', 'payment', 'cart', 'account', 'facebook.com', 'twitter.com', 'instagram.com', 'google.com', 'youtube.com', 'ads', 'advertisement', 'tracking'];

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

function isAdmin(userId) {
  return userId === ADMIN_ID;
}

function normalizeUrl(rawHref, base) {
  try {
    const url = new URL(rawHref, base);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function sameDomain(url, base) {
  try {
    return new URL(url).hostname === new URL(base).hostname;
  } catch {
    return false;
  }
}

function shouldSkipUrl(url) {
  const lower = url.toLowerCase();
  if (SKIP_EXTS.some(ext => lower.endsWith(ext))) return true;
  if (SKIP_KEYWORDS.some(kw => lower.includes(kw))) return true;
  return false;
}

function detectQuality(text) {
  const t = text.toLowerCase();
  for (const q of QUALITY_LABELS) {
    if (t.includes(q)) return q.toUpperCase();
  }
  return 'Unknown Quality';
}

function scoreMatch(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  let score = 0;
  if (t.includes(q)) score += 10;
  words.forEach(w => { if (t.includes(w)) score += 1; });
  return score;
}

function isDownloadableLink(href, linkText) {
  const lower = href.toLowerCase();
  const textLower = (linkText || '').toLowerCase();
  if (DOWNLOADABLE_EXTS.some(ext => lower.includes(ext))) return true;
  if (DOWNLOAD_KEYWORDS.some(kw => textLower.includes(kw))) return true;
  return false;
}

async function fetchPage(url) {
  const resp = await axios.get(url, {
    timeout: PAGE_TIMEOUT,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    maxRedirects: 5,
    validateStatus: s => s < 400,
  });
  return resp.data;
}

// ─── Crawler ─────────────────────────────────────────────────────────────────

async function crawlSite(homepageUrl) {
  const visited = new Set();
  const queue   = [{ url: homepageUrl, depth: 0 }];
  const pages   = [];

  while (queue.length > 0 && pages.length < MAX_PAGES) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    let html;
    try { html = await fetchPage(url); }
    catch { continue; }

    const $ = cheerio.load(html);
    const title = $('title').text().trim() || $('h1').first().text().trim() || url;
    const body  = $('body').text().replace(/\s+/g, ' ').trim();
    pages.push({ url, title, body });

    if (depth < MAX_DEPTH) {
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        const abs  = normalizeUrl(href, url);
        if (!abs) return;
        if (!sameDomain(abs, homepageUrl)) return;
        if (shouldSkipUrl(abs)) return;
        if (visited.has(abs)) return;
        queue.push({ url: abs, depth: depth + 1 });
      });
    }
  }

  return pages;
}

function findRelevantPages(pages, query) {
  return pages
    .map(p => ({
      ...p,
      score: scoreMatch(query, p.title + ' ' + p.url + ' ' + p.body),
    }))
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

async function findDownloadLinks(pageUrl) {
  let html;
  try { html = await fetchPage(pageUrl); }
  catch { return []; }

  const $       = cheerio.load(html);
  const results = [];
  const seen    = new Set();

  $('a[href]').each((_, el) => {
    const href     = $(el).attr('href');
    const linkText = $(el).text().trim();
    const abs      = normalizeUrl(href, pageUrl);
    if (!abs || seen.has(abs)) return;
    if (!isDownloadableLink(abs, linkText)) return;

    seen.add(abs);
    const quality = detectQuality(linkText + ' ' + abs);
    const label   = linkText || quality;
    results.push({ label: label.substring(0, 60), url: abs, quality });
  });

  return results;
}

// ─── Download ─────────────────────────────────────────────────────────────────

function validateDownloadUrl(fileUrl) {
  let parsed;
  try { parsed = new URL(fileUrl); }
  catch { throw new Error('Invalid download URL.'); }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Download URL must use http or https.');
  }

  const hostname = parsed.hostname.toLowerCase();
  const blocked = [
    /^localhost$/,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^::1$/,
    /^0\.0\.0\.0$/,
    /^169\.254\./,
  ];
  if (blocked.some(re => re.test(hostname))) {
    throw new Error('Download URL points to a private/loopback address.');
  }
}

async function downloadFile(fileUrl) {
  validateDownloadUrl(fileUrl);
  ensureDownloadsDir();

  const parsedUrl = new URL(fileUrl);
  const basename  = path.basename(parsedUrl.pathname) || 'file';
  const safeName  = basename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const destPath  = path.join(DOWNLOADS_DIR, `${Date.now()}_${safeName}`);

  const resp = await axios.get(fileUrl, {
    responseType: 'stream',
    timeout: 0,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    },
    maxRedirects: 10,
  });

  // Fast rejection via Content-Length header
  const contentLength = parseInt(resp.headers['content-length'] || '0', 10);
  if (contentLength > MAX_FILE_SIZE) {
    resp.data.destroy();
    throw new Error('FILE_TOO_LARGE');
  }

  // Stream to disk; abort mid-transfer if over 2 GB
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    let received = 0;

    resp.data.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_FILE_SIZE) {
        resp.data.destroy();
        writer.destroy();
        deleteTempFile(destPath);
        reject(new Error('FILE_TOO_LARGE'));
      }
    });

    resp.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error',  (err) => { deleteTempFile(destPath); reject(err); });
    resp.data.on('error', (err) => { deleteTempFile(destPath); reject(err); });
  });

  return destPath;
}

// ─── Session state ────────────────────────────────────────────────────────────

const sessions = {};

// ─── Bot setup ────────────────────────────────────────────────────────────────

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function sendMsg(chatId, text, opts) {
  return bot.sendMessage(chatId, text, opts).catch(console.error);
}

function editMsg(chatId, messageId, text, opts) {
  return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts }).catch(() => {});
}

// ─── Search flow ──────────────────────────────────────────────────────────────

async function handleSearch(chatId, query) {
  const sites = loadSites();

  if (sites.length === 0) {
    return sendMsg(chatId, 'No websites added yet. Ask the admin to add some with /addsite.');
  }

  const progressMsg = await sendMsg(chatId, `🔍 Searching for *"${query}"*…`, { parse_mode: 'Markdown' });
  const progressId  = progressMsg && progressMsg.message_id;

  const allDownloadLinks = [];

  for (const site of sites) {
    try {
      await editMsg(chatId, progressId, `📂 Opening website pages from *${site.name}*…`, { parse_mode: 'Markdown' });

      const pages    = await crawlSite(site.url);
      const relevant = findRelevantPages(pages, query);

      if (relevant.length === 0) continue;

      await editMsg(chatId, progressId, `🔗 Finding download links…`);

      for (const page of relevant.slice(0, 5)) {
        const links = await findDownloadLinks(page.url);
        links.forEach(l => {
          l.siteName = site.name;
          allDownloadLinks.push(l);
        });
        if (allDownloadLinks.length >= 20) break;
      }
    } catch (err) {
      console.error(`Site error [${site.name}]:`, err.message);
    }
  }

  if (allDownloadLinks.length === 0) {
    await editMsg(chatId, progressId, '❌ No results found. Try a different search term.');
    return;
  }

  const seen    = new Set();
  const deduped = allDownloadLinks.filter(l => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });

  sessions[chatId] = deduped.slice(0, 15);

  const keyboard = deduped.slice(0, 15).map((item, i) => [{
    text: `[${item.quality}] ${item.label.substring(0, 40)} — ${item.siteName}`,
    callback_data: `dl:${chatId}:${i}`,
  }]);

  await editMsg(chatId, progressId, `✅ Found *${deduped.length}* result(s) for *"${query}"*. Choose one:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard },
  });
}

// ─── Callback handler ─────────────────────────────────────────────────────────

bot.on('callback_query', async (callbackQuery) => {
  const data   = callbackQuery.data || '';
  const chatId = callbackQuery.message.chat.id;
  await bot.answerCallbackQuery(callbackQuery.id);

  if (!data.startsWith('dl:')) return;

  const parts = data.split(':');
  const idx   = parseInt(parts[2], 10);
  const items = sessions[chatId];

  if (!items || !items[idx]) {
    return sendMsg(chatId, '❌ Result expired. Please search again.');
  }

  const item = items[idx];
  let filePath = null;

  try {
    await sendMsg(chatId, `⬇️ Downloading file…\n\`${item.url.substring(0, 80)}\``, { parse_mode: 'Markdown' });

    filePath = await downloadFile(item.url);

    await sendMsg(chatId, '🔎 Checking file size…');
    const stat = fs.statSync(filePath);

    if (stat.size > MAX_FILE_SIZE) {
      deleteTempFile(filePath);
      return sendMsg(chatId, '❌ File is too large. Telegram limit is 2 GB.');
    }

    await sendMsg(chatId, '📤 Uploading to Telegram…');

    await bot.sendDocument(chatId, filePath, {
      caption: `*${item.label}* — ${item.quality}`,
      parse_mode: 'Markdown',
    });

    deleteTempFile(filePath);
    await sendMsg(chatId, '✅ Done.');
  } catch (err) {
    deleteTempFile(filePath);
    console.error('Download/upload error:', err.message);

    if (err.message === 'FILE_TOO_LARGE') {
      await sendMsg(chatId, '❌ File is too large. Telegram limit is 2 GB.');
    } else if (err.message.includes('download') || err.message.includes('URL')) {
      await sendMsg(chatId, '❌ Download failed. Please try another result.');
    } else {
      await sendMsg(chatId, '❌ Upload failed. Please try another result.');
    }
  }
});

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  sendMsg(msg.chat.id,
    `👋 Welcome!\n\nSend me a movie or file name and I will find and send it to you.\n\nExamples:\n• /mv Inception\n• Just type: *Inception*\n\nUse /help for all commands.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/help/, (msg) => {
  sendMsg(msg.chat.id,
    `📖 *Commands*\n\n` +
    `/start — Welcome message\n` +
    `/help — Show this help\n` +
    `/mv <name> — Search for a movie or file\n\n` +
    `*Or just type the name directly*\n\n` +
    `*Admin only:*\n` +
    `/addsite name | url — Add a website\n` +
    `/listsites — List added websites\n` +
    `/removesite name — Remove a website`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/addsite (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return sendMsg(chatId, '⛔ Admin only.');

  const parts = match[1].split('|').map(s => s.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    return sendMsg(chatId, '❌ Format: /addsite Name | https://example.com');
  }

  const [name, url] = parts;

  let parsedUrl;
  try { parsedUrl = new URL(url); }
  catch { return sendMsg(chatId, '❌ Invalid URL. Make sure it starts with http:// or https://'); }

  const sites = loadSites();
  if (sites.find(s => s.name.toLowerCase() === name.toLowerCase())) {
    return sendMsg(chatId, `❌ A site named "${name}" already exists. Remove it first.`);
  }

  sites.push({ name, url: parsedUrl.href });
  saveSites(sites);
  sendMsg(chatId, `✅ Site added:\n*${name}*\n${parsedUrl.href}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/listsites/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return sendMsg(chatId, '⛔ Admin only.');

  const sites = loadSites();
  if (sites.length === 0) return sendMsg(chatId, '📭 No sites added yet.');

  const list = sites.map((s, i) => `${i + 1}. *${s.name}*\n   ${s.url}`).join('\n\n');
  sendMsg(chatId, `🌐 *Added Sites:*\n\n${list}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/removesite (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return sendMsg(chatId, '⛔ Admin only.');

  const name  = match[1].trim();
  let   sites = loadSites();
  const before = sites.length;

  sites = sites.filter(s => s.name.toLowerCase() !== name.toLowerCase());

  if (sites.length === before) {
    return sendMsg(chatId, `❌ No site found with name "${name}".`);
  }

  saveSites(sites);
  sendMsg(chatId, `✅ Site *"${name}"* removed.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/mv (.+)/, (msg, match) => {
  const query = match[1].trim();
  if (!query) return sendMsg(msg.chat.id, '❌ Please provide a search name. Example: /mv Inception');
  handleSearch(msg.chat.id, query);
});

// ─── Plain text = search ───────────────────────────────────────────────────────

bot.on('message', (msg) => {
  if (!msg.text) return;
  if (msg.text.startsWith('/')) return;

  const query = msg.text.trim();
  if (!query) return;

  handleSearch(msg.chat.id, query);
});

// ─── Error handling ───────────────────────────────────────────────────────────

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

// ─── Start ────────────────────────────────────────────────────────────────────

ensureDownloadsDir();
console.log('Bot is running…');
