#!/usr/bin/env node
'use strict';
const { parseArgs } = require('node:util');
const { createInterface } = require('node:readline/promises');
const os = require('node:os');
const path = require('node:path');
const { runAgent } = require('./agent');

const help = [
  '微博网页数据读取 agent',
  '  ./weibo login                         打开专用 Chrome，登录后回到终端按回车',
  '  ./weibo scan 帖子链接 [帖子链接 ...]',
  '  ./weibo scan --uid 数字UID --from YYYY-MM-DD --to YYYY-MM-DD',
  '  --uid、--topic、--kind 均可重复；--kind 可选 提问、抱怨、建议',
  '  --out 结果目录  --profile 专用浏览器目录  --max-pages 每个列表页数  --steps 单帖截图浏览步数',
  '  --headless 使用已登录的专用会话在后台采集'
].join('\n');

async function main() {
  const { values: v, positionals: [cmd, ...posts] } = parseArgs({ allowPositionals: true, options: {
    uid: { type: 'string', multiple: true }, topic: { type: 'string', multiple: true },
    kind: { type: 'string', multiple: true }, from: { type: 'string' }, to: { type: 'string' },
    out: { type: 'string' }, profile: { type: 'string' }, 'max-pages': { type: 'string' },
    steps: { type: 'string' }, headless: { type: 'boolean' }, help: { type: 'boolean' }
  } });
  if (v.help || !cmd) { console.log(help); return; }
  if (!['login', 'scan'].includes(cmd)) throw new Error(help);
  const { chromium } = require('playwright-core');
  const profile = path.resolve(v.profile || path.join(os.homedir(), '.weibo-comment-reader', 'chrome'));
  const ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: cmd === 'scan' && !!v.headless,
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  try {
    if (cmd === 'login') {
      const page = ctx.pages()[0] || await ctx.newPage();
      await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded' });
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { await rl.question('请在打开的 Chrome 中登录微博。确认能看到目标评论后，回到这里按回车保存会话。'); }
      finally { rl.close(); }
      return;
    }
    const { directory, result } = await runAgent(ctx, { posts, uids: v.uid, from: v.from, to: v.to,
      kinds: v.kind, topics: v.topic, out: v.out, maxPages: Number(v['max-pages'] || 100),
      steps: Number(v.steps || 180), onPost: p => console.log(p.status, p.url, JSON.stringify(p.counts)) });
    console.log(result.status + '\n' + directory);
    if (['部分完成', '访问受限'].includes(result.status)) process.exitCode = 2;
  } finally { await ctx.close(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });

