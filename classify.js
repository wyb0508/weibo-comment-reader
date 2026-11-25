'use strict';

const domains = [
  ['增程器与能耗', /增程|发电机|亏电|馈电|油耗|油箱|机油|NVH|保养周期/i],
  ['质量安全与售后', /售后|异响|维修|故障|质保|漏水|漏油|失灵|召回|刹车|安全|抖动|噪[声音]/],
  ['智驾与软件', /智驾|辅助驾驶|车机|OTA|导航|泊车|软件|自动驾驶|更新后/i],
  ['产品配置与补能', /配置|充电|快充|续航|纯电|电池|底盘|空间|座椅|800\s*V|400\s*V|颜色/i],
  ['价格交付与服务', /价格|售价|定金|订金|退订|交付|提车|排产|上市|选装|试驾|多少钱|优惠/],
  ['研发与测试', /测试|实测|验证|冬测|耐久|路测/]
];

function classify(comment, parent, postText, { kinds, topics }) {
  const text = comment.text.replace(/^回复\s*@[^:：]{1,50}[:：]\s*/, '').trim();
  const context = [text, parent?.text || '', postText || ''];
  const tags = [];
  if (/[\p{L}\p{N}]/u.test(text) && !/^(呵呵|哈哈+|笑死|就这|垃圾|傻[逼比]|滚|路过|打卡|沙发|支持)[\s!！?？。]*$/u.test(text)) {
    if (/[?？]|请问|想问|求问|求解|求教|求证|想知道|有无|是否|为什么|为啥|怎么|怎样|如何|何时|什么时候|多久|多[少远大长高重]|哪[个款里种些]|几[个年公里天次]|能不能|可不可以|行不行|有没有|会不会|[吗么][啊呀呢吧。！…]*$/.test(text)) tags.push('提问');
    if (/抱怨|投诉|不满|失望|异响|故障|失灵|卡死|黑屏|漏[水油]|太[吵贵慢]|一直没|迟迟|等了.{0,10}(?:天|周|月)|没人[管理回]|联系不上|反复.{0,8}修|无法.{0,8}(?:使用|充电|启动)|不[给让]退/.test(text)) tags.push('抱怨');
    if (/(?:建议|希望|最好|能否考虑|可否增加).{1,}/.test(text)) tags.push('建议');
  }
  const topicSource = topics.length ? context.findIndex(s => topics.some(t => s.toLowerCase().includes(t.toLowerCase()))) : -1;
  const topicOK = !topics.length || topicSource >= 0;
  let category = '其他';
  for (const source of context) {
    const found = domains.find(([, pattern]) => pattern.test(source));
    if (found) { category = found[0]; break; }
  }
  const selected = topicOK && tags.some(tag => kinds.includes(tag));
  return { tags, category, selected, topicSource: ['评论', '主评论', '帖子'][topicSource] || null };
}

function finishPost(post) {
  const selected = post.comments.filter(c => c.selected);
  const images = selected.filter(c => c.evidence).length;
  const actual = post.comments.length, reported = post.displayedCount;
  if (reported != null && reported !== actual) post.issues.push('帖子显示 ' + reported + ' 条，去重读到 ' + actual + ' 条，计数口径或可见范围存在差异');
  if (reported == null && post.scans.length) post.issues.push('未取得帖子评论总数');
  if (images < selected.length) post.issues.push('入选评论中有 ' + (selected.length - images) + ' 条待补截图');
  post.issues = [...new Set(post.issues)];
  post.counts = { unique: actual, roots: post.comments.filter(c => !c.rootId).length,
    replies: post.comments.filter(c => c.rootId).length, selected: selected.length, withImage: images };
  post.status = post.issues.length ? (post.blocked && !actual ? '访问受限' : '部分完成') : '已核对本次可见范围';
}

module.exports = { classify, finishPost };

