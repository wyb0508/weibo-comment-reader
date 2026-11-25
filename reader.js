'use strict';

// 网页返回的评论 ID、游标通常超过 JS 的安全整数范围。
function parseWebJSON(source) {
  return JSON.parse(source, (_, value, context) =>
    typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(context.source)
      ? context.source : value);
}

class ReadError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function postRef(input) {
  const url = new URL(input);
  const match = /^\/(?:([A-Za-z0-9_-]+)\/)([A-Za-z0-9]+)\/?$/.exec(url.pathname);
  if (!['weibo.com', 'www.weibo.com'].includes(url.hostname) || !match ||
      !['https:', 'http:'].includes(url.protocol) || url.port || url.username || url.password ||
      ['u', 'n', 'p', 'ajax', 'login'].includes(match[1])) {
    throw new Error('请传入桌面微博单帖链接，如 https://weibo.com/1749127163/Rc88BhlAZ');
  }
  const token = match[2];
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const chunks = token.match(/(?:^.{1,4}(?=(?:.{4})*$))|.{4}/g);
  const mid = /^\d{14,20}$/.test(token) ? token : chunks.map((s, i) => {
    const n = [...s].reduce((v, ch) => v * 62 + alphabet.indexOf(ch), 0);
    if (n >= 10000000) throw new Error('无效的微博短 ID');
    return String(n).padStart(i === 0 ? 1 : 7, '0');
  }).join('');
  return { url: 'https://weibo.com/' + match[1] + '/' + token, mid, owner: match[1] };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function webReader(context, delay = 650) {
  let last = 0;
  return async function read(path, params, referer) {
    await sleep(Math.max(0, last + delay - Date.now()));
    last = Date.now();
    const url = new URL(path, 'https://weibo.com');
    url.search = new URLSearchParams(params).toString();
    const response = await context.request.get(url.href, {
      headers: { Referer: referer, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      maxRedirects: 0, timeout: 20000
    });
    try {
      const status = response.status();
      const source = await response.text();
      if ([401, 403, 418, 429].includes(status) || (status >= 300 && status < 400) ||
          /^\s*</.test(source) && /登录|passport|visitor system|安全验证|验证码/i.test(source)) {
        throw new ReadError('ACCESS', '微博要求登录、验证或限制访问（HTTP ' + status + '）');
      }
      if (status !== 200) throw new ReadError('HTTP', '微博返回 HTTP ' + status);
      let data;
      try { data = parseWebJSON(source); }
      catch { throw new ReadError('FORMAT', '网页未返回可识别的 JSON'); }
      if (!data || typeof data !== 'object') throw new ReadError('FORMAT', '微博响应格式已变化');
      if (data.ok === 0 || data.ok === false || data.error_code) {
        const message = String(data.msg || data.message || data.error || '微博拒绝请求').slice(0, 150);
        throw new ReadError(/频繁|登录|验证|权限|访问受限/.test(message) ? 'ACCESS' : 'API', message);
      }
      return data;
    } finally { await response.dispose(); }
  };
}

function absoluteDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('日期使用 YYYY-MM-DD');
  const ms = Date.parse(s + 'T00:00:00+08:00');
  if (!Number.isFinite(ms) || new Date(ms + 28800000).toISOString().slice(0, 10) !== s)
    throw new Error('日期无效：' + s);
  return ms;
}

function dateRange(from, to, now = Date.now()) {
  const start = absoluteDate(from), end = absoluteDate(to) + 86400000;
  if (start >= end || start > now) throw new Error('起止时间无效或尚未开始');
  return { start, end: Math.min(end, now + 1) };
}

const idOf = item => String(item?.idstr || item?.id || '');
const numericID = id => /^\d+$/.test(id);

async function discover(read, uid, range, result, maxPages) {
  const seen = new Set();
  result.stop = '主页页数达到上限';
  for (let page = 1; page <= maxPages; page++) {
    const body = await read('/ajax/statuses/mymblog', { uid, page, feature: 0 }, 'https://weibo.com/u/' + uid);
    const list = body.data?.list;
    if (!Array.isArray(list)) throw new ReadError('FORMAT', '账号时间线缺少 list');
    result.pages++;
    if (!list.length) { result.stop = '主页末页'; return; }
    let normal = 0, older = 0, added = 0;
    for (const post of list) {
      if (idOf(post.user) !== uid) continue;
      const time = Date.parse(post.created_at);
      if (!Number.isFinite(time) || !numericID(idOf(post))) {
        if (!result.issues.includes('主页有无法识别日期或 ID 的帖子')) result.issues.push('主页有无法识别日期或 ID 的帖子');
        continue;
      }
      const pinned = Number(post.isTop || post.is_top || 0) === 1;
      if (!pinned) { normal++; if (time < range.start) older++; }
      if (seen.has(idOf(post))) continue;
      seen.add(idOf(post)); added++;
      if (time >= range.start && time < range.end) {
        const url = 'https://weibo.com/' + uid + '/' + (post.mblogid || post.bid || idOf(post));
        result.urls.push(url);
      }
    }
    if (normal && normal === older) { result.stop = '非置顶时间线已越过起始日'; return; }
    if (!added) { result.stop = '主页无新增或账号身份无法核对'; return; }
  }
}

// cursor 只在服务端明确给出末页时结束。重复游标、缺字段均留下缺口。
async function pages(read, params, referer, maxPages, log, consume) {
  let next = {};
  const seen = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const body = await read('/ajax/statuses/buildComments', { ...params, ...next }, referer);
    if (!Array.isArray(body.data)) throw new ReadError('FORMAT', '评论响应缺少 data 数组');
    log.pages++;
    await consume(body.data);
    const cursor = body.max_id;
    if (cursor === 0 || cursor === '0' || (cursor === '' && body.data.length === 0)) {
      log.stop = '末页'; return;
    }
    if (cursor == null || !numericID(String(cursor))) { log.stop = '缺少有效游标'; return; }
    const type = body.max_id_type ?? 0;
    const token = String(cursor) + '/' + type;
    if (seen.has(token)) { log.stop = '游标重复'; return; }
    seen.add(token);
    next = { max_id: cursor, max_id_type: type };
  }
  log.stop = '页数达到上限';
}

function commentText(raw) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(raw || '')
    .replace(/<img\b[^>]*?\balt\s*=\s*(["'])(.*?)\1[^>]*>/gi, '$2')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#x[0-9a-f]+|#\d+);/gi, (all, key) => {
      if (key[0] !== '#') return entities[key.toLowerCase()];
      const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }).trim();
}

async function readPost(read, input, out, maxPages) {
  const ref = postRef(input);
  const meta = await read('/ajax/statuses/show', { id: ref.mid }, ref.url);
  const uid = idOf(meta.user);
  if (idOf(meta) !== ref.mid || !numericID(uid) || /^\d+$/.test(ref.owner) && uid !== ref.owner)
    throw new ReadError('IDENTITY', '帖子 ID 或作者与输入不符');
  out.url = 'https://weibo.com/' + uid + '/' + (meta.mblogid || meta.bid || ref.mid);
  out.mid = ref.mid;
  out.author = meta.user.screen_name;
  out.publishedAt = meta.created_at;
  out.postText = meta.text_raw || commentText(meta.text);
  out.displayedCount = /^\d+$/.test(String(meta.comments_count)) ? Number(meta.comments_count) : null;
  const records = new Map(), roots = new Map();
  function save(row, rootId = null) {
    const id = idOf(row);
    if (!numericID(id) || !row.user || !(row.text_raw || row.text)) {
      if (!out.issues.includes('存在无法解析的评论')) out.issues.push('存在无法解析的评论');
      return;
    }
    if (!records.has(id)) {
      const entry = { id, rootId, replyToId: idOf(row.reply_comment) || null, author: row.user.screen_name,
        authorId: idOf(row.user), publishedAt: row.created_at || null,
        text: row.text_raw || commentText(row.text), postUrl: out.url };
      records.set(id, entry); out.comments.push(entry);
    }
  }
  const base = { uid, is_reload: 1, is_show_bulletin: 2, count: 20 };
  async function traverse(name, params, consume) {
    const log = { name, pages: 0, stop: '中断' };
    out.scans.push(log);
    try { await pages(read, { ...base, ...params }, out.url, maxPages, log, consume); }
    catch (e) {
      if (e.code === 'ACCESS') throw e;
      log.stop = e.message;
    }
    if (log.stop !== '末页') out.issues.push(name + '：' + log.stop);
  }
  for (const [flow, name] of [[0, '按热度'], [1, '按时间']]) {
    await traverse(name, { id: ref.mid, is_mix: 0, fetch_level: 0, flow }, list => {
      for (const row of list) {
        save(row);
        const rootId = idOf(row);
        if (!numericID(rootId)) continue;
        const previews = Array.isArray(row.comments) ? row.comments : [];
        for (const child of previews) save(child, rootId);
        const total = Number(row.total_number || 0);
        if (total || previews.length || row.more_info) {
          roots.set(rootId, Math.max(roots.get(rootId) || 0, total, previews.length));
        }
      }
    });
  }
  for (const rootId of roots.keys()) {
    await traverse('楼中楼 ' + rootId, { id: rootId, is_mix: 1, fetch_level: 1, max_id: 0 }, list => {
      for (const row of list) if (idOf(row) !== rootId) save(row, rootId);
    });
  }
  const replyCounts = new Map();
  for (const c of out.comments) {
    if (c.rootId) replyCounts.set(c.rootId, (replyCounts.get(c.rootId) || 0) + 1);
  }
  for (const [rootId, expected] of roots) {
    const actual = replyCounts.get(rootId) || 0;
    if (actual < expected) out.issues.push('楼中楼 ' + rootId + ' 显示 ' + expected + ' 条，读到 ' + actual + ' 条');
  }
}

module.exports = { ReadError, parseWebJSON, postRef, webReader, dateRange, discover, pages, readPost, commentText };

