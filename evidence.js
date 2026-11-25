'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { postRef, ReadError } = require('./reader');

const norm = text => String(text || '').replace(/\s+/g, '').replace(/：/g, ':');
function signature(comment) {
  return JSON.stringify([comment.authorId || comment.author, norm(comment.text)]);
}

// 在网页上下文运行。只读取已渲染的评论节点，作者和正文都属于同一行。
function pageView({ op, index, proof, button, position }) {
  const shown = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const modal = [...document.querySelectorAll('.woo-modal-main, [role="dialog"], [aria-modal="true"]')]
    .filter(shown).pop();
  const scope = modal || document;
  const selector = '.wbpro-list .item1, .wbpro-list .item2, .woo-modal-main .item1, .woo-modal-main .item2, [role="dialog"] .item2, [aria-modal="true"] .item2';
  const nodes = [...scope.querySelectorAll(selector)].filter(shown);
  function row(el) {
    const card = el.matches('.item1') ? el.querySelector(':scope > .item1in') || el : el;
    const content = card.querySelector('.con1 > .text, .con2 > .text, .con1 .text, .con2 .text');
    if (!content || content.closest('.item1,.item2') !== el) return null;
    const user = content.querySelector('a[href*="/u/"]') || card.querySelector('a[href*="/u/"]');
    if (!user) return null;
    const author = user.innerText.trim() || user.title;
    const authorId = (user.pathname.match(/^\/u\/(\d+)\/?$/) || [])[1];
    const copy = content.cloneNode(true);
    const nick = [...copy.querySelectorAll('a')].find(a => a.getAttribute('href') === user.getAttribute('href') && a.textContent.trim() === author);
    nick?.remove();
    for (const img of copy.querySelectorAll('img')) img.replaceWith(img.alt);
    for (const br of copy.querySelectorAll('br')) br.replaceWith('\n');
    const text = copy.textContent.replace(/^\s*[:：]\s*/, '').trim();
    const id = el.getAttribute('comment_id') || el.getAttribute('data-comment-id') || card.getAttribute('data-comment-id');
    const rect = card.getBoundingClientRect();
    return { card, data: { id, author, authorId, text }, rect };
  }
  const entries = nodes.map(row);
  function parentData(el) {
    const parent = el.parentElement?.closest('.item1');
    return parent ? row(parent)?.data : null;
  }
  const actionLabel = /^(?:共\s*\d+\s*条回复|(?:还有|另有|剩余)\s*\d+\s*条回复|(?:查看|展开|显示|加载)(?:更多|全部|(?:被)?折叠的?)?(?:\s*\d+\s*条)?(?:回复|评论)|更多回复|按热度|按时间|按时间排序|最新评论)$/;
  const actions = ['click', 'snapshot'].includes(op) ? [...scope.querySelectorAll('button, [role="button"], a, span, div')]
    .filter(el => el.childElementCount < 3 && actionLabel.test(el.textContent.trim()) && shown(el))
    .filter(el => ![...el.children].some(c => c.innerText?.trim() === el.innerText.trim())) : [];
  function controls() {
    return actions.map((el, i) => ({ i, label: el.innerText.trim(), parent: rowParent(el) }));
  }
  function rowParent(el) {
    const root = el.closest('.item1');
    return root ? row(root)?.data : null;
  }
  const anchor = nodes.find(el => el.matches('.item2')) || nodes[0];
  let scroller = anchor?.parentElement || modal;
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 5 &&
    /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
  scroller ||= document.scrollingElement;
  function accessWall() {
    const warning = /登录后(?:才能|才可|可)?(?:查看|浏览)(?:全部|更多)?评论|请完成安全验证|访问频次过高|请先完成验证/;
    return [...document.querySelectorAll('.woo-modal-main, [role="dialog"], main, .wbpro-list')].some(el =>
      shown(el) && warning.test(el.innerText?.slice(-1600) || '') && !el.querySelector('.item1,.item2')) ||
      [...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="geetest"]')].some(shown) ||
      /passport\.weibo|visitor\.passport/.test(location.href);
  }
  if (op === 'snapshot') {
    return { modal: !!modal, blocked: accessWall(), position: scroller.scrollTop,
      rows: entries.flatMap((e, i) => e ? [{ ...e.data, i, parent: parentData(nodes[i]), reply: nodes[i].matches('.item2') }] : []),
      controls: controls() };
  }
  if (op === 'scroll') {
    const before = scroller.scrollTop;
    scroller.scrollTop += Math.floor(scroller.clientHeight * 0.74);
    return scroller.scrollTop !== before;
  }
  if (op === 'restore') { scroller.scrollTop = position; return; }
  if (op === 'click') {
    const c = controls()[button.i];
    if (!c || JSON.stringify(c) !== JSON.stringify(button)) return false;
    actions[c.i].click(); return true;
  }
  if (op === 'close') {
    const el = modal?.querySelector('[aria-label="关闭"], [title="关闭"], [class*="close" i], [class*="Close"]') ||
      modal?.parentElement?.querySelector('.woo-modal-close');
    if (el && shown(el)) { (el.closest('button,[role="button"]') || el).click(); return true; }
    return false;
  }
  const e = entries[index];
  if (!e || accessWall() || JSON.stringify([e.data, parentData(nodes[index])]) !== proof) return false;
  if (op === 'focus') { e.card.scrollIntoView({ block: 'center', behavior: 'instant' }); return true; }
  const r = e.rect;
  if (r.width < 5 || r.height < 5 || r.left < 0 || r.top < 0 || r.bottom > innerHeight || r.right > innerWidth) return false;
  for (const y of [r.top + 2, r.top + r.height / 2, r.bottom - 2]) {
    for (const x of [r.left + 3, r.left + r.width / 2, r.right - 3]) {
      if (!e.card.contains(document.elementFromPoint(x, y))) return false;
    }
  }
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

async function captureEvidence(page, post, dir, options = {}) {
  const wait = options.wait ?? 700;
  let steps = options.steps ?? 180;
  const view = (op, args = {}) => page.evaluate(pageView, { op, ...args });
  const wanted = post.comments.filter(c => c.selected);
  const groups = new Map();
  for (const c of post.comments) {
    const key = signature(c);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  function identify(dom, parentId) {
    if (!dom) return;
    const list = (groups.get(signature(dom)) || []).filter(c =>
      c.rootId === parentId && (!dom.id || dom.id === c.id) && c.author === dom.author);
    if (list.length === 1) return list[0];
  }
  const missing = () => wanted.filter(c => !c.evidence);
  if (!missing().length) return;
  await page.goto(post.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const checkSource = () => {
    if (/passport\.|\/login(?:[/?#]|$)|\/visitor\//.test(page.url())) throw new ReadError('ACCESS', '原帖跳转至登录或验证页');
    let mid;
    try { mid = postRef(page.url()).mid; } catch {}
    if (mid !== post.mid) throw new ReadError('PAGE', '原帖页面被重定向，无法核对截图');
  };
  checkSource();
  await page.locator('.wbpro-list .item1, .wbpro-list .item2').first().waitFor({ timeout: options.readyMs ?? 10000 }).catch(() => {});
  async function shot(row, comment) {
    const { i, parent, reply, ...data } = row;
    const args = { index: i, proof: JSON.stringify([data, parent ?? null]) };
    if (!await view('focus', args)) return;
    await page.waitForTimeout(Math.min(wait, 160));
    checkSource();
    const rect = await view('verify', args);
    if (!rect) return;
    const bytes = await page.screenshot({ type: 'png', fullPage: false, timeout: 10000 });
    checkSource();
    if (JSON.stringify(await view('verify', args)) !== JSON.stringify(rect)) return;
    const name = post.mid + '-' + comment.id + '.png';
    await fs.writeFile(path.join(dir, name), bytes);
    comment.evidence = { file: 'evidence/' + name, sha256: createHash('sha256').update(bytes).digest('hex'),
      capturedAt: new Date().toISOString(), page: page.url(), rect };
  }
  // 分别滚动主列表与弹窗，已命中和截图的评论共用一套 ID。
  async function walk(parentId) {
    let idle = 0;
    const actionsDone = new Set();
    while (steps > 0 && missing().length && idle < 3) {
      steps--;
      checkSource();
      const state = await view('snapshot');
      if (state.blocked) throw new ReadError('ACCESS', '评论页面要求登录或验证');
      if (!!parentId !== state.modal) return;
      const position = state.position;
      for (const row of state.rows) {
        const owner = row.parent ? identify(row.parent, null)?.id : parentId;
        if (row.reply && !owner) continue;
        const c = identify(row, owner || null);
        if (c?.selected && !c.evidence) {
          await shot(row, c);
          await view('restore', { position });
        }
      }
      if (parentId && !missing().some(c => c.rootId === parentId)) return;
      let changed = false;
      for (const button of state.controls.filter(b => /回复|^(?:展开|查看|加载|显示).*评论/.test(b.label))) {
        const root = identify(button.parent, null);
        if (root && !missing().some(c => c.rootId === root.id)) continue;
        const key = JSON.stringify([button.label, root?.id || parentId, state.rows.map(r => signature(r))]);
        if (actionsDone.has(key)) continue;
        actionsDone.add(key);
        if (!await view('click', { button })) continue;
        await page.waitForTimeout(wait);
        if (!parentId && (await view('snapshot')).modal) {
          if (root) await walk(root.id);
          if (!await view('close')) await page.keyboard.press('Escape');
          await page.waitForTimeout(wait);
          if ((await view('snapshot')).modal) { post.issues.push('回复弹窗未能关闭'); return; }
          await view('restore', { position });
        }
        changed = true; break;
      }
      if (changed) { idle = 0; continue; }
      if (await view('scroll')) idle = 0; else idle++;
      await page.waitForTimeout(wait);
    }
  }
  await walk(null);
  if (steps > 0 && missing().length) {
    await view('restore', { position: 0 });
    let controls = (await view('snapshot')).controls;
    let time = controls.find(b => /按时间|最新评论/.test(b.label));
    if (!time) {
      const hot = controls.find(b => b.label === '按热度');
      if (hot) { await view('click', { button: hot }); await page.waitForTimeout(wait); }
      controls = (await view('snapshot')).controls;
      time = controls.find(b => /按时间|最新评论/.test(b.label));
    }
    if (time && await view('click', { button: time })) {
      await page.waitForTimeout(wait); await walk(null);
    }
  }
  if (steps <= 0 && missing().length) post.issues.push('截图浏览步数达到上限');
}

module.exports = { captureEvidence, pageView };

