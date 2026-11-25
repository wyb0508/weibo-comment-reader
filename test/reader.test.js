'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { postRef, pages, discover, dateRange, webReader, readPost, commentText } = require('../reader');
const { classify, finishPost } = require('../classify');
const { runAgent } = require('../agent');

const url = 'https://weibo.com/1749127163/Rc88BhlAZ';
const mid = '5328912214134593';
const uid = '1749127163';
const mock = (value, status = 200) => ({ status: () => status, text: async () => value, dispose: async () => {} });
test('微博短号与超长游标', async () => {
  assert.equal(postRef(url).mid, mid);
  const read = webReader({request:{get:async () => mock('{"max_id":9977700012345678999}')}}, 0);
  assert.equal((await read('/x', {}, url)).max_id, '9977700012345678999');
  assert.throws(() => postRef('https://elsewhere.org/1749127163/Rc88BhlAZ'));
});
test('重复游标与缺失游标均留下缺口', async () => {
  for (const [cursor, reason] of [['123','游标重复'], [undefined,'缺少有效游标']]) {
    const log = { pages: 0 };
    await pages(async () => ({data:[], max_id:cursor}), {}, url, 5, log, () => {});
    assert.equal(log.stop, reason);
  }
});
test('登录墙、限流与异常页面', async () => {
  for (const [s, status, code] of [['<html>登录</html>',200,'ACCESS'], ['{}',429,'ACCESS'], ['<html>维护</html>',200,'FORMAT']]) {
    const read = webReader({request:{get:async () => mock(s,status)}}, 0);
    await assert.rejects(read('/x',{},url), e => e.code === code);
  }
});
test('账号日期过滤排除置顶旧帖、推荐账号和截止时刻之后的新帖', async () => {
  function status(id, date, flags={}) { return { id, user:{id:uid}, created_at:date, ...flags }; }
  const scope = {urls:[],pages:0,issues:[]};
  const range = dateRange('2026-07-28','2026-07-28', Date.parse('2026-07-28T14:00:00+08:00'));
  await discover(async (_, p) => ({data:{list:p.page === 1 ? [
    status(1,'2020-01-01',{isTop:1}), status(2,'2026-07-28T10:00:00+08:00',{mblogid:'AAAA'}),
    status(3,'2026-07-28T19:00:00+08:00'), status(4,'2026-07-28T10:00:00+08:00',{user:{id:'999'}})
  ] : [status(5,'2026-07-27')]}}), uid, range, scope, 5);
  assert.deepEqual(scope.urls,['https://weibo.com/'+uid+'/AAAA']);
  assert.equal(scope.stop,'非置顶时间线已越过起始日');
  assert.throws(() => dateRange('2026-02-30','2026-03-01'));
});
test('意图、主题上下文、非提问和噪声', () => {
  const check = (text,parent='') => classify({text}, {text:parent}, '', {kinds:['提问'],topics:['增程器']});
  assert.equal(check('多久保养一次','增程器体验').selected,true);
  assert.equal(check('增程器一直有异响，怎么处理？').tags.join('/'),'提问/抱怨');
  assert.equal(check('建议改进增程器隔音').selected,false);
  assert.equal(check('就这？','增程器').selected,false);
  assert.equal(check('这款多少钱').selected,false);
  assert.equal(commentText('回复<a>@网友</a>：多久<br>保养<img alt="[问号]"> &amp;'), '回复@网友：多久\n保养[问号] &');
});
test('缺图、差额均禁止报完成', () => {
  const p = {comments:[{selected:true,rootId:null}], displayedCount:3, issues:[],scans:[{}]};
  finishPost(p);
  assert.equal(p.status,'部分完成'); assert.equal(p.issues.length,2);
});

const user = id => ({id,screen_name:'测试用户'+id});
const comment = (id, who, text) => ({ idstr:id, user:user(who), text, created_at:'2026-08-06T12:00:00+08:00' });
const root = comment('100','10','增程器体验交流');
const child = comment('101','11','多久保养一次？');
const twin = comment('102','12','多久保养一次？');
test('一个排序失败后仍读取另一排序和楼中楼', async () => {
  const out = {comments:[], issues:[], scans:[]};
  await readPost(async (path, p) => {
    if (path.endsWith('show')) return {id:mid, user:user(uid), comments_count:2, mblogid:'Rc88BhlAZ'};
    if (p.flow === 0) throw new Error('热门列表暂不可用');
    return {max_id:0, data:p.fetch_level === 1 ? [child] : [{...root,total_number:1}]};
  }, url, out, 4);
  assert.deepEqual(out.comments.map(c => c.id), ['100','101']);
  assert(out.issues.some(s => s.includes('热门列表暂不可用')));
});
test('第一个帖子触发限流后保存剩余队列', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(),'weibo-reader-blocked-'));
  try {
    const {result} = await runAgent({request:{get:async () => mock('{}',429)}},
      {out:scratch,delay:0,posts:[url,'https://weibo.com/1749127163/R939N6os4']});
    assert.equal(result.status,'访问受限'); assert.equal(result.posts.length,1);
    assert.equal(result.pending.length,1); assert.equal(result.posts[0].counts.unique,0);
  } finally { await rm(scratch,{recursive:true,force:true}); }
});
const row = (c, layer) => '<div class="con'+layer+'"><div class="text"><a href="/u/'+c.user.id+'">'+c.user.screen_name+'</a>：<span>'+c.text+'</span></div><small>测试时间</small></div>';
function fixture(showSecond) {
  return '<!doctype html><meta charset="utf-8"><style>body{margin:60px}.item1in,.item2{padding:10px;border:1px solid #ccc}.woo-modal-main{position:fixed;inset:80px;background:white;padding:20px}</style><main class="wbpro-list"><div class="item1"><div class="item1in">'+row(root,1)+'</div><div class="list2"><button id="fold">共2条回复</button></div></div></main><dialog class="woo-modal-main"><button aria-label="关闭" onclick="this.parentElement.close()">关闭</button><h2>2条回复</h2><div class="item2">'+row(child,2)+'</div>'+(showSecond?'<div class="item2">'+row(twin,2)+'</div>':'')+'</dialog><script>fold.onclick=()=>document.querySelector("dialog").showModal()</script>';
}
test('本地 Chrome 端到端：双排序、多页、预览去重、展开回复、同文异人、缺图', async () => {
  const {chromium} = require('playwright-core');
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const scratch = await mkdtemp(path.join(os.tmpdir(),'weibo-reader-test-'));
  try {
    for (const both of [true,false]) {
      const ctx = await browser.newContext({viewport:{width:1300,height:850}});
      await ctx.route('**/*', r => r.fulfill({contentType:'text/html',body:fixture(both)}));
      const flows = [];
      const request = {get:async raw => {
        const q = new URL(raw);
        if(q.pathname.endsWith('show')) return mock(JSON.stringify({id:mid,user:user(uid),mblogid:'Rc88BhlAZ',comments_count:3}));
        const childList = q.searchParams.get('fetch_level') === '1';
        flows.push(q.searchParams.get('flow'));
        if (childList) return mock(JSON.stringify({data:[child,twin],max_id:0}));
        if (q.searchParams.has('max_id')) return mock('{"data":[],"max_id":0}');
        return mock(JSON.stringify({data:[{...root,comments:[child],total_number:2}],max_id:'45'}));
      }};
      const {directory,result} = await runAgent({request,newPage:() => ctx.newPage()},
        {posts:[url,url],out:scratch, delay:0,uiWait:50,readyMs:1000,steps:12,kinds:['提问'],topics:['增程器']});
      const p = result.posts[0];
      assert.equal(result.posts.length,1); assert(flows.includes('0') && flows.includes('1'));
      assert.equal(p.counts.unique,3); assert.equal(p.counts.replies,2);
      assert.equal(p.counts.selected,2);
      assert.equal(p.counts.withImage,both ? 2 : 1, JSON.stringify(p));
      assert.equal(p.status,both ? '已核对本次可见范围' : '部分完成');
      for (const c of p.comments.filter(v => v.evidence)) {
        assert.equal(c.rootId,root.idstr);
        assert.equal(c.postUrl,url); assert(c.evidence.file.includes(c.id));
        const bytes = await readFile(path.join(directory,c.evidence.file));
        assert.equal(bytes.readUInt32BE(16),1300);
        assert.equal(bytes.readUInt32BE(20),850);
        assert.equal(c.evidence.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
      }
      await ctx.close();
    }
  } finally { await browser.close(); await rm(scratch,{recursive:true,force:true}); }
});

