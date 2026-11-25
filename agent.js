'use strict';

const { mkdir, mkdtemp, writeFile, rename } = require('node:fs/promises');
const path = require('node:path');
const { webReader, dateRange, discover, readPost, postRef } = require('./reader');
const { captureEvidence } = require('./evidence');
const { classify, finishPost } = require('./classify');

function reportHTML(run) {
  const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const h = ['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>微博评论复核</title>',
    '<style>body{font:16px/1.65 system-ui,sans-serif;max-width:960px;margin:32px auto;padding:0 20px;color:#222}img{max-width:100%;height:auto}article{border-top:1px solid #ddd;padding:12px 0}blockquote{white-space:pre-wrap;margin-left:0}small{color:#555}</style>',
    '<h1>微博评论复核</h1><p>' + escape(run.status) + ' · ' + escape(run.startedAt) + '</p>'];
  for (const scope of run.accounts) h.push('<p>账号 ' + escape(scope.uid) + ' · 发现 ' + scope.urls.length + ' 帖 · ' + escape([scope.stop, ...scope.issues].join(' / ')) + '</p>');
  if (run.pending.length) h.push('<p>尚未处理 ' + run.pending.length + ' 个原帖。</p>');
  for (const p of run.posts) {
    h.push('<h2><a href="' + escape(p.url) + '">' + escape(p.author || '微博原帖') + '</a></h2><p>' +
      escape(p.status) + ' · 已读 ' + p.counts.unique + ' 条（楼中楼 ' + p.counts.replies + ' 条），入选 ' + p.counts.selected + ' 条，已截图 ' + p.counts.withImage + ' 条</p>');
    for (const issue of p.issues) h.push('<p>' + escape(issue) + '</p>');
    const byId = new Map(p.comments.map(c => [c.id, c]));
    const selected = p.comments.filter(c => c.selected).sort((a,b) => a.category.localeCompare(b.category, 'zh'));
    let category;
    for (const c of selected) {
      if (category !== c.category) { category = c.category; h.push('<h3>' + escape(category) + '</h3>'); }
      h.push('<article><small>' + escape([c.author, c.publishedAt, ...c.tags].filter(Boolean).join(' · ')) +
        ' · <a href="' + escape(p.url) + '">查看原帖</a> · 评论 ' + escape(c.id) + '</small><blockquote>' + escape(c.text) + '</blockquote>');
      if (c.rootId) {
        const root = byId.get(c.rootId);
        if (root) h.push('<small>主评论 · ' + escape(root.author) + '　' + escape(root.text) + '</small>');
      }
      h.push(c.evidence ? '<p><a href="' + escape(c.evidence.file) + '"><img loading="lazy" alt="微博原页截图" src="' + escape(c.evidence.file) + '"></a></p>' : '<p>待补原页截图</p>');
      h.push('</article>');
    }
  }
  return h.join('\n') + '</html>';
}

// context 可由调用方传入（例如其他 Agent 已登录的 Playwright BrowserContext）。
async function runAgent(context, config) {
  const now = Date.now();
  const posts = config.posts || [], uids = config.uids || [];
  const filter = { topics: config.topics || [], kinds: config.kinds || ['提问', '抱怨', '建议'] };
  const maxPages = config.maxPages ?? 100;
  const steps = config.steps ?? 180;
  if (!posts.length && !uids.length) throw new Error('至少指定一个帖子或账号 UID');
  if (uids.some(uid => !/^\d+$/.test(uid))) throw new Error('账号必须使用数字 UID');
  if (!Number.isInteger(maxPages) || maxPages < 1 || !Number.isInteger(steps) || steps < 1) throw new Error('页数和步数必须为正整数');
  if (!filter.kinds.length || filter.kinds.some(k => !['提问', '抱怨', '建议'].includes(k))) throw new Error('意图可选提问、抱怨、建议');
  const range = uids.length ? dateRange(config.from, config.to, now) : null;
  const queue = new Map(posts.map(url => [postRef(url).mid, postRef(url).url]));
  const base = path.resolve(config.out || 'weibo-runs');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'scan-' + new Date(now).toISOString().replace(/[:.]/g, '-') + '-'));
  const imageDir = path.join(dir, 'evidence');
  await mkdir(imageDir);
  const read = webReader(context, config.delay);
  const run = { startedAt: new Date(now).toISOString(), status: '进行中', filter, range, accounts: [], posts: [], pending: [...queue.values()] };
  async function checkpoint() {
    const file = path.join(dir, 'result.json');
    await writeFile(file + '.tmp', JSON.stringify(run, null, 2) + '\n');
    await rename(file + '.tmp', file);
  }
  let blocked = false;
  for (const uid of new Set(uids)) {
    const account = { uid, urls: [], pages: 0, stop: '未开始', issues: [] };
    run.accounts.push(account);
    if (blocked) { account.issues.push('此前访问受限'); continue; }
    try {
      await discover(read, uid, range, account, maxPages);
      if (!['主页末页', '非置顶时间线已越过起始日'].includes(account.stop)) account.issues.push(account.stop);
    } catch (e) {
      account.stop = '中断'; account.issues.push(e.message); blocked = e.code === 'ACCESS';
    }
    for (const url of account.urls) queue.set(postRef(url).mid, url);
  }
  run.pending = [...queue.values()];
  await checkpoint();
  while (!blocked && run.pending.length) {
    const input = run.pending[0];
    const p = { url: input, displayedCount: null, issues: [], scans: [], comments: [] };
    try { await readPost(read, input, p, maxPages); }
    catch (e) { p.issues.push(e.message); p.blocked = blocked = e.code === 'ACCESS'; }
    const byId = new Map(p.comments.map(c => [c.id, c]));
    for (const c of p.comments) Object.assign(c, classify(c, byId.get(c.rootId), p.postText, filter));
    if (!blocked && p.comments.some(c => c.selected)) {
      let page;
      try {
        page = await context.newPage();
        await captureEvidence(page, p, imageDir, { steps, wait: config.uiWait, readyMs: config.readyMs });
      } catch (e) { p.issues.push(e.message); p.blocked = blocked = e.code === 'ACCESS'; }
      finally { if (page) await page.close(); }
    }
    finishPost(p);
    run.posts.push(p); run.pending.shift();
    await checkpoint();
    if (config.onPost) config.onPost(p);
  }
  const partial = run.pending.length || run.accounts.some(a => a.issues.length) || run.posts.some(p => p.issues.length);
  run.status = partial ? (blocked && !run.posts.some(p => p.counts.unique) ? '访问受限' : '部分完成') :
    run.posts.length ? '已核对本次可见范围' : '指定日期内未发现账号帖子';
  run.finishedAt = new Date().toISOString();
  await checkpoint();
  await writeFile(path.join(dir, 'review.html'), reportHTML(run));
  return { directory: dir, result: run };
}

module.exports = { runAgent };

