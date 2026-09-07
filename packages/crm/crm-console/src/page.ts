/**
 * The console single-page application, served verbatim at `/crm-console`.
 * One self-contained HTML document (no build step, no external assets): five
 * views over the JSON API — dashboard, client book, pipeline, tasks, and the
 * suitability audit trail.
 * @module @deepseek-ai/dsh-crm-console/src/page
 */

const LIFECYCLE_LABEL: Record<string, string> = {
  lead: '线索', prospect: '意向', onboarding: '开户中', active: '活跃', dormant: '沉睡', lost: '流失',
}
const TOLERANCE_LABEL: Record<string, string> = { C1: 'C1 保守', C2: 'C2 稳健', C3: 'C3 平衡', C4: 'C4 成长', C5: 'C5 进取' }
const STAGE_LABEL: Record<string, string> = {
  new: '新建', qualified: '已验证', proposal: '方案中', negotiation: '谈判中', won: '已成交', lost: '已流失', abandoned: '已放弃',
}
const STATUS_LABEL: Record<string, string> = { valid: '有效', expiring: '即将到期', expired: '已过期', missing: '未测评' }
const VERDICT_LABEL: Record<string, string> = {
  matched: '✓ 匹配', 'product-exceeds-profile': '✗ 超出风险承受', 'assessment-expired': '✗ 测评已过期', 'missing-profile': '✗ 未测评',
}
const SENTIMENT_LABEL: Record<string, string> = { positive: '积极', neutral: '中性', negative: '消极' }
const PRIORITY_LABEL: Record<string, string> = { low: '低', normal: '中', high: '高', urgent: '紧急' }

const lifecycleOptions = Object.entries(LIFECYCLE_LABEL)
  .map(([value, label]) => `<option value="${value}">${label}</option>`).join('')
const toleranceOptions = Object.entries(TOLERANCE_LABEL)
  .map(([value, label]) => `<option value="${value}">${label}</option>`).join('')
const stageOptions = Object.entries(STAGE_LABEL)
  .map(([value, label]) => `<option value="${value}">${label}</option>`).join('')

/**
 * The console document served verbatim at `/crm-console`.
 */
export const CONSOLE_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%231d3357'/%3E%3Ctext x='16' y='22' font-size='15' text-anchor='middle' fill='%237db6ff' font-family='sans-serif' font-weight='700'%3EC%3C/text%3E%3C/svg%3E">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>投顾 CRM 控制台</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'PingFang SC','Microsoft YaHei',-apple-system,sans-serif; background:#0e1421; color:#d7e1f2; }
  header { display:flex; align-items:center; gap:14px; padding:14px 28px; background:#131b2d; border-bottom:1px solid #26324e; position:sticky; top:0; z-index:5; }
  header h1 { font-size:17px; color:#fff; font-weight:600; }
  header .sub { font-size:12px; color:#63769b; }
  nav { display:flex; gap:6px; margin-left:24px; }
  nav button { background:transparent; border:1px solid transparent; color:#8fa2c6; font-size:13px; padding:6px 14px; border-radius:8px; cursor:pointer; }
  nav button.on { background:#1c2a44; color:#7db6ff; border-color:#2d4266; }
  main { padding:22px 28px; max-width:1200px; margin:0 auto; }
  section { display:none; }
  section.on { display:block; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; margin-bottom:18px; }
  .card { background:#151d30; border:1px solid #26324e; border-radius:12px; padding:14px 16px; }
  .card .v { font-size:22px; font-weight:700; color:#fff; margin-top:4px; }
  .card .l { font-size:12px; color:#7488ad; }
  .card .s { font-size:11px; color:#5c6f93; margin-top:4px; }
  table { width:100%; border-collapse:collapse; background:#131b2d; border:1px solid #26324e; border-radius:12px; overflow:hidden; font-size:13px; }
  th { text-align:left; padding:9px 12px; background:#182238; color:#8ba0c6; font-weight:600; font-size:12px; white-space:nowrap; }
  td { padding:9px 12px; border-top:1px solid #1f2b44; vertical-align:top; }
  tr:hover td { background:#16203400; }
  td.empty { text-align:center; color:#5c6f93; padding:26px; }
  .pill { display:inline-block; padding:2px 9px; border-radius:20px; font-size:11px; white-space:nowrap; }
  .pill.ok { background:#15321f; color:#79df9d; border:1px solid #245c3c; }
  .pill.warn { background:#3a2e14; color:#e8c26a; border:1px solid #5c4a1e; }
  .pill.bad { background:#3a1d1d; color:#f09b9b; border:1px solid #5c2e2e; }
  .pill.dim { background:#1d2740; color:#8fa2c6; border:1px solid #2d3c5c; }
  .pill.money { background:#122a3a; color:#7cc4f0; border:1px solid #24455e; }
  .bar { height:6px; border-radius:4px; background:#1d2740; overflow:hidden; margin-top:4px; }
  .bar i { display:block; height:100%; background:linear-gradient(90deg,#2d6fb0,#6fb3ff); }
  .toolbar { display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; align-items:center; }
  .toolbar input, .toolbar select { background:#101728; border:1px solid #2a3854; color:#c9d8ef; border-radius:8px; padding:7px 10px; font-size:13px; }
  .toolbar button, .act { background:#1d3357; color:#9cc3f7; border:1px solid #2f4b78; border-radius:8px; padding:7px 14px; font-size:13px; cursor:pointer; }
  .act { padding:3px 10px; font-size:12px; }
  .act.gray { background:#26324e; color:#9db1d6; border-color:#39496e; }
  .act.red { background:#3a1d1d; color:#f09b9b; border-color:#5c2e2e; }
  .toolbar button:hover, .act:hover { filter:brightness(1.2); }
  h3 { font-size:14px; color:#9db8e8; margin:20px 0 10px; }
  .kv { font-size:12px; color:#8ba0c6; line-height:2; }
  .kv b { color:#d7e1f2; font-weight:600; }
  .detail { background:#131b2d; border:1px solid #26324e; border-radius:12px; padding:16px 18px; margin-bottom:14px; }
  .muted { color:#6b7fa5; font-size:12px; }
  .auditblock { background:#101828; border-left:3px solid #37507a; padding:10px 14px; border-radius:0 8px 8px 0; margin-bottom:8px; font-size:12.5px; line-height:1.8; }
  .toast { position:fixed; bottom:20px; right:20px; background:#1c3a2a; color:#8fe6ae; border:1px solid #2c5a40; border-radius:10px; padding:10px 16px; font-size:13px; display:none; }
  .toast.err { background:#3a1d1d; color:#f09b9b; border-color:#5c2e2e; }
  dialog { background:#151d30; color:#d7e1f2; border:1px solid #2d3c5c; border-radius:14px; padding:20px; width:min(480px,92vw); }
  dialog::backdrop { background:#000a; }
  dialog h4 { margin-bottom:12px; color:#9cc3f7; font-size:15px; }
  dialog label { display:block; font-size:12px; color:#8ba0c6; margin:10px 0 4px; }
  dialog input, dialog select { width:100%; background:#101728; border:1px solid #2a3854; color:#c9d8ef; border-radius:8px; padding:8px 10px; font-size:13px; }
  dialog .foot { display:flex; gap:8px; justify-content:flex-end; margin-top:16px; }
</style>
</head>
<body>
<header>
  <h1>投顾 CRM 控制台</h1>
  <span class="sub">dsh-crm · 浏览器管理台</span>
  <nav>
    <button data-view="overview" class="on">总览</button>
    <button data-view="clients">客户簿</button>
    <button data-view="pipeline">商机管线</button>
    <button data-view="tasks">跟进任务</button>
    <button data-view="audit">适当性审计</button>
    <button data-view="insights">客户洞察</button>
    <button data-view="plans">投顾方案</button>
  </nav>
</header>
<main>
  <section id="overview" class="on"></section>
  <section id="clients">
    <div class="toolbar">
      <input id="client-q" placeholder="搜索姓名 / 标签 / 区域…">
      <select id="client-kind"><option value="">全部类型</option><option value="individual">个人</option><option value="institution">机构</option></select>
      <select id="client-lifecycle"><option value="">全部阶段</option>${lifecycleOptions}</select>
      <select id="client-tolerance"><option value="">全部容忍度</option>${toleranceOptions}</select>
      <button id="client-new">＋ 新建客户</button>
      <button id="log-interaction">＋ 记录互动</button>
    </div>
    <div id="client-list"></div>
    <div id="client-detail"></div>
  </section>
  <section id="pipeline">
    <div class="toolbar">
      <select id="stage-filter"><option value="">全部阶段</option>${stageOptions}</select>
      <button id="opp-new">＋ 新建商机</button>
      <button id="opp-refresh">刷新</button>
    </div>
    <div id="pipeline-cards"></div>
    <div id="opp-list"></div>
  </section>
  <section id="tasks">
    <div class="toolbar">
      <select id="task-filter">
        <option value="open">未完成</option>
        <option value="overdue">已逾期</option>
        <option value="done">已完成</option>
        <option value="cancelled">已取消</option>
      </select>
      <button id="task-new">＋ 新建任务</button>
      <button id="task-refresh">刷新</button>
    </div>
    <div id="task-list"></div>
  </section>
  <section id="plans">
    <div class="toolbar">
      <select id="plan-client"></select>
      <select id="plan-kind">
        <option value="recurring-investment">定投计划</option>
        <option value="allocation">资产配置方案</option>
        <option value="protection-gap">保障缺口分析</option>
      </select>
      <button id="plan-new">＋ 新建方案</button>
    </div>
    <div id="plan-list"></div>
    <div id="plan-review"></div>
  </section>
  <section id="insights">
    <div class="toolbar">
      <button class="act export" data-export="export-clients">⬇ 客户 CSV</button>
      <button class="act export" data-export="export-deals">⬇ 商机 CSV</button>
      <button class="act export" data-export="export-tasks">⬇ 任务 CSV</button>
      <button class="act export" data-export="export-interactions">⬇ 互动 CSV</button>
      <button class="act export" data-export="export-audit">⬇ 适当性审计 CSV</button>
      <span class="muted">UTF-8 BOM + CRLF，Excel 直接打开</span>
    </div>
    <h3>RFM 客户分层</h3>
    <div id="rfm-tiers" class="cards"></div>
    <div id="rfm-rows"></div>
    <h3>线索 → 成交转化漏斗</h3>
    <div id="funnel"></div>
    <h3>客户分组</h3>
    <div id="segments"></div>
  </section>
  <section id="audit">
    <div class="toolbar"><button id="audit-refresh">刷新审计轨迹</button></div>
    <div id="audit-list"></div>
  </section>
</main>
<div class="toast" id="toast"></div>

<dialog id="dlg-client">
  <h4>新建客户</h4>
  <label>姓名 <input id="nc-name"></label>
  <label>类型 <select id="nc-kind"><option value="individual">个人</option><option value="institution">机构</option></select></label>
  <label>归属顾问 <select id="nc-advisor"><option value="">（稍后指派）</option></select></label>
  <label>风险容忍度 <select id="nc-tolerance"><option value="">（暂不测评）</option>${toleranceOptions}</select></label>
  <label>区域 <input id="nc-region" placeholder="城市"></label>
  <label>资产规模（元） <input id="nc-aum" type="number" min="0"></label>
  <label>标签（逗号分隔） <input id="nc-tags" placeholder="私行客户, 基金定投"></label>
  <div class="foot"><button class="act gray" id="nc-cancel">取消</button><button id="nc-save">保存</button></div>
</dialog>

<dialog id="dlg-interaction">
  <h4>记录客户互动</h4>
  <label>客户 <select id="it-client"></select></label>
  <label>渠道 <select id="it-kind"><option>meeting</option><option>call</option><option>wechat</option><option>email</option><option>report_review</option><option>consultation</option></select></label>
  <label>主题 <select id="it-topic"><option value="">（不标注）</option>${Object.entries({ asset_allocation: '资产配置', retirement: '退休规划', tax: '税务', insurance: '保险', education: '教育金', market_outlook: '市场展望', product_review: '产品解读', portfolio_rebalance: '组合再平衡', other: '其他' }).map(function (e) { return '<option value="' + e[0] + '">' + e[1] + '</option>' }).join('')}</select></label>
  <label>摘要 <input id="it-summary" placeholder="本次沟通要点"></label>
  <div class="foot"><button class="act gray" id="it-cancel">取消</button><button id="it-save">记录</button></div>
</dialog>

<dialog id="dlg-task">
  <h4>新建跟进任务</h4>
  <label>标题 <input id="tk-title"></label>
  <label>客户 <select id="tk-client"></select></label>
  <label>责任顾问 <select id="tk-advisor"></select></label>
  <label>到期日 <input id="tk-due" type="date"></label>
  <label>优先级 <select id="tk-priority"><option value="normal">中</option><option value="low">低</option><option value="high">高</option><option value="urgent">紧急</option></select></label>
  <div class="foot"><button class="act gray" id="tk-cancel">取消</button><button id="tk-save">保存</button></div>
</dialog>

<dialog id="dlg-plan">
  <h4>新建投顾方案</h4>
  <label>客户 <select id="pl-client"></select></label>
  <label>方案类型 <select id="pl-kind">
    <option value="recurring-investment">定投计划</option>
    <option value="allocation">资产配置方案</option>
    <option value="protection-gap">保障缺口分析</option>
  </select></label>
  <div id="pl-recurring-fields">
    <label>每月金额（元） <input id="pl-monthly" type="number" min="0" value="1000"></label>
    <label>扣款日（1–28） <input id="pl-day" type="number" min="1" max="28" value="15"></label>
    <label>标的 <input id="pl-product" placeholder="中证红利低波ETF联接A"></label>
  </div>
  <div id="pl-allocation-fields" style="display:none">
    <label>固收 % <input id="pl-fixed" type="number" min="0" max="100" value="60"></label>
    <label>权益 % <input id="pl-equity" type="number" min="0" max="100" value="30"></label>
    <label>现金 % <input id="pl-cash" type="number" min="0" max="100" value="10"></label>
  </div>
  <div id="pl-protection-fields" style="display:none">
    <label>年收入（元） <input id="pl-income" type="number" min="0"></label>
    <label>保障年限 <input id="pl-years" type="number" min="1" max="30" value="10"></label>
    <label>已有寿险保额 <input id="pl-life" type="number" min="0" value="0"></label>
    <label>已有重疾保额 <input id="pl-ci" type="number" min="0" value="0"></label>
  </div>
  <div class="foot"><button class="act gray" id="pl-cancel">取消</button><button id="pl-save">保存</button></div>
</dialog>

<dialog id="dlg-deal">
  <h4>新建商机</h4>
  <label>客户 <select id="dl-client"></select></label>
  <label>产品名称 <input id="dl-product" placeholder="中证红利低波ETF联接A"></label>
  <label>金额（元） <input id="dl-amount" type="number" min="0"></label>
  <div class="foot"><button class="act gray" id="dl-cancel">取消</button><button id="dl-save">保存</button></div>
</dialog>

<dialog id="dlg-consult">
  <h4>记录咨询 · 适当性自动判定</h4>
  <label>客户 <select id="cs-client"></select></label>
  <label>产品名称 <input id="cs-product" placeholder="中证红利低波ETF联接A"></label>
  <label>产品风险等级 <select id="cs-risk"><option>R1</option><option>R2</option><option>R3</option><option>R4</option><option>R5</option></select></label>
  <label>小结 <input id="cs-summary" placeholder="本次咨询要点"></label>
  <div class="foot"><button class="act gray" id="cs-cancel">取消</button><button id="cs-save">记录</button></div>
</dialog>

<script>
var API = '/crm-console/api';
function $(id) { return document.getElementById(id); }
function esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function toast(msg, err) {
  var t = $('toast');
  t.textContent = msg;
  t.className = err ? 'toast err' : 'toast';
  t.style.display = 'block';
  setTimeout(function () { t.style.display = 'none'; }, 2600);
}
function api(path, opts) {
  return fetch(API + path, opts).then(function (res) {
    return res.json().then(function (body) {
      if (!res.ok) throw new Error(body && body.error ? body.error : res.status);
      return body;
    }).catch(function (e) {
      toast('请求失败：' + (e && e.message ? e.message : String(e)), true);
      throw e;
    });
  }).catch(function (e) {
    if (e && e.message && e.message.indexOf('请求失败') === 0) throw e;
    toast('网络错误：无法连接 CRM 服务', true);
    throw e;
  });
}
function post(path, body) {
  return api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
}
function patch(path, body) {
  return api(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
}
function money(n) { return (n === null || n === undefined) ? '—' : Number(n).toLocaleString('zh-CN') + ' 元'; }
function dateOf(v) { if (v === null || v === undefined || v === '') return '—'; var s = String(v); if (/^\\d{12,14}$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10); return s.slice(0, 10); }

/* ── 总览 ─────────────────────────────────────────── */
function loadOverview() {
  return api('/overview').then(function (data) {
    var p = data.pipeline, b = data.book, tl = data.taskLoad;
    var maxStage = 1;
    p.stages.forEach(function (s) { maxStage = Math.max(maxStage, s.count); });
    var html = '<div class="cards">'
      + '<div class="card"><div class="l">客户总数</div><div class="v">' + b.totalClients + '</div><div class="s">AUM ' + money(b.totalAum) + '</div></div>'
      + '<div class="card"><div class="l">存续商机</div><div class="v">' + p.openCount + '</div><div class="s">加权预测 ' + money(Math.round(p.weightedForecast)) + '</div></div>'
      + '<div class="card"><div class="l">赢单率</div><div class="v">' + (p.winRate === null ? '—' : p.winRate + '%') + '</div><div class="s">' + p.wonCount + ' 赢 / ' + p.lostCount + ' 输</div></div>'
      + '<div class="card"><div class="l">未完成任务</div><div class="v">' + tl.open + '</div><div class="s">' + tl.overdue + ' 已逾期</div></div>'
      + '<div class="card"><div class="l">测评即将到期</div><div class="v">' + b.expiringProfiles.length + '</div><div class="s">30 天窗口内</div></div>'
      + '<div class="card"><div class="l">测评已过期</div><div class="v">' + b.expiredProfiles.length + '</div><div class="s">需尽快复测</div></div>'
      + '</div><h3>管线漏斗</h3><div class="detail">';
    p.stages.forEach(function (s) {
      html += '<div style="display:flex;align-items:center;gap:10px;margin:6px 0">'
        + '<span class="pill dim" style="width:64px;text-align:center">' + (STAGE_LABEL[s.stage] || s.stage) + '</span>'
        + '<span style="flex:1"><span class="bar"><i style="width:' + Math.round(s.count / maxStage * 100) + '%"></i></span></span>'
        + '<span class="muted" style="width:150px;text-align:right">' + s.count + ' 单 · ' + money(s.amount) + '</span></div>';
    });
    html += '</div>'
    if (b.totalClients === 0 && localStorage.getItem('crm-onboarding-dismissed') !== '1') {
      html += '<div class="detail" style="border-color:#2d4b78">'
        + '<h3 style="margin-top:0;color:#9cc3f7">欢迎使用投顾 CRM · 三步上手</h3>'
        + '<div class="kv" style="line-height:2.2">'
        + '<b>① 建团队</b>　客户簿 → “＋ 新建客户”前先到顾问列表建顾问（或直接用演示数据）<br>'
        + '<b>② 建客户</b>　录入风险测评（C1–C5）与资产，360° 视图自动可用<br>'
        + '<b>③ 记咨询</b>　每款产品自动做适当性判定——绿灯可推、红灯即停，留痕可审计'
        + '</div>'
        + '<div style="margin-top:12px">'
        + '<button id="demo-seed" style="background:#1d3357;color:#9cc3f7;border:1px solid #2f4b78;border-radius:8px;padding:9px 18px;font-size:13px;cursor:pointer">🚀 一键载入演示数据（24 客户 · 28 互动 · 21 咨询 · 21 商机 · 27 任务）</button>'
        + ' <span class="muted">载入后每个页面都有真实感数据可探索</span>'
        + ' <button id="demo-skip" class="act gray" style="margin-left:10px">不再显示</button>'
        + '</div></div>'
    }
    html += '<h3>客户结构</h3><div class="detail"><div class="kv">';
    b.byLifecycle.forEach(function (row) {
      html += (LIFECYCLE_LABEL[row.lifecycle] || row.lifecycle) + ' <b>' + row.count + '</b>　　';
    });
    html += '<br>';
    b.byTolerance.forEach(function (row) {
      html += (row.tolerance === null ? '未测评' : TOLERANCE_LABEL[row.tolerance] || row.tolerance) + ' <b>' + row.count + '</b>　　';
    });
    html += '</div></div>';
    $('overview').innerHTML = html;
    var seed = $('demo-seed')
    if (seed) seed.onclick = function () {
      seed.disabled = true
      seed.textContent = '载入中…'
      post('/demo-data').then(function (summary) {
        localStorage.setItem('crm-demo-loaded', '1')
        toast('演示数据已载入：' + summary.clients + ' 位客户、' + summary.opportunities + ' 个商机')
        views.overview()
      }).catch(function (e) {
        toast(e.message, true)
        if (seed) { seed.disabled = false; seed.textContent = '🚀 一键载入演示数据（24 客户 · 28 互动 · 21 咨询 · 21 商机 · 27 任务）' }
      })
    }
    var skip = $('demo-skip')
    if (skip) skip.onclick = function () {
      localStorage.setItem('crm-onboarding-dismissed', '1')
      views.overview()
    }
  });
}

/* ── 客户簿 ───────────────────────────────────────── */
var LIFECYCLE_LABEL = ${JSON.stringify(LIFECYCLE_LABEL)};
var TOLERANCE_LABEL = ${JSON.stringify(TOLERANCE_LABEL)};
var STATUS_LABEL = ${JSON.stringify(STATUS_LABEL)};
var STAGE_LABEL = ${JSON.stringify(STAGE_LABEL)};
var VERDICT_LABEL = ${JSON.stringify(VERDICT_LABEL)};
var SENTIMENT_LABEL = ${JSON.stringify(SENTIMENT_LABEL)};
var PRIORITY_LABEL = ${JSON.stringify(PRIORITY_LABEL)};

var advisorNames = {};
function rememberAdvisors(rows) {
  rows.forEach(function (a) { advisorNames[a.id] = a.name })
}
function loadClients() {
  var q = new URLSearchParams();
  if ($('client-q').value) q.set('query', $('client-q').value);
  if ($('client-lifecycle').value) q.set('lifecycle', $('client-lifecycle').value);
  if ($('client-tolerance').value) q.set('tolerance', $('client-tolerance').value);
  if ($('client-kind').value) q.set('kind', $('client-kind').value)
  q.set('limit', '100');
  return api('/clients?' + q).then(function (rows) {
    var html = '<table><tr><th>客户</th><th>类型</th><th>阶段</th><th>顾问</th><th>风险测评</th><th>资产</th><th>标签</th><th>操作</th></tr>'
      + rows.map(function (c) {
        var st = '<span class="pill ' + (c.profileStatus === 'valid' ? 'ok' : c.profileStatus === 'missing' ? 'dim' : 'warn') + '">' + (STATUS_LABEL[c.profileStatus] || c.profileStatus) + (c.tolerance ? ' · ' + (TOLERANCE_LABEL[c.tolerance] || c.tolerance) : '') + '</span>';
        return '<tr><td><b>' + esc(c.name) + '</b><div class="muted">' + String(c.id).slice(0, 8) + '</div></td>'
          + '<td>' + (c.kind === 'institution' ? '机构' : '个人') + '</td>'
          + '<td>' + (LIFECYCLE_LABEL[c.lifecycle] || c.lifecycle) + '</td>'
          + '<td class="muted">' + esc(advisorNames[c.advisorId] || '—') + '</td>'
          + '<td>' + st + '</td>'
          + '<td class="pill money">' + money(c.totalAum) + '</td>'
          + '<td class="muted">' + esc((c.tags || []).join('、')) + '</td>'
          + '<td><button class="act" onclick="openClient(\\'' + c.id + '\\')">360°</button> <button class="act gray" onclick="consultFor(\\'' + c.id + '\\')">记咨询</button></td></tr>';
      }).join('') + '</table>';
    $('client-list').innerHTML = html;
    $('client-detail').innerHTML = '';
  });
}
function openClient(id) {
  return api('/clients/' + id).then(function (book) {
    var c = book.client;
    var html = '<h3>' + esc(c.name) + ' · 360° 视图</h3><div class="detail"><div class="kv">'
      + '阶段 <b>' + (LIFECYCLE_LABEL[c.lifecycle] || c.lifecycle) + '</b>　'
      + '测评 <b>' + (c.riskProfile ? (TOLERANCE_LABEL[c.riskProfile.tolerance] || c.riskProfile.tolerance) + '，' + dateOf(c.riskProfile.expiresAt) + ' 到期' : '未测评') + '</b>　'
      + 'AUM <b>' + money(c.financial && c.financial.totalAum) + '</b>　'
      + (c.contact && c.contact.region ? '区域 <b>' + esc(c.contact.region) + '</b>' : '')
      + '</div></div>';
    html += '<h3>最近互动</h3><table><tr><th>时间</th><th>渠道</th><th>摘要</th><th>情绪</th></tr>'
      + book.interactions.map(function (i) {
        return '<tr><td>' + dateOf(i.occurredAt) + '</td><td>' + esc(i.kind) + '</td><td>' + esc(i.summary) + '</td><td>' + (SENTIMENT_LABEL[i.sentiment] || '—') + '</td></tr>';
      }).join('') + '</table>';
    html += '<h3>商机</h3><table><tr><th>产品</th><th>阶段</th><th>金额</th><th>概率</th></tr>'
      + book.opportunities.map(function (o) {
        return '<tr><td>' + esc(o.productName || o.productKind) + '</td><td>' + (STAGE_LABEL[o.stage] || o.stage) + '</td><td class="pill money">' + money(o.amount) + '</td><td>' + o.probability + '%</td></tr>';
      }).join('') + '</table>';
    html += '<h3>未完成任务</h3><table><tr><th>标题</th><th>到期</th><th>优先级</th><th>状态</th></tr>'
      + book.openTasks.map(function (t) {
        return '<tr><td>' + esc(t.title) + '</td><td>' + dateOf(t.dueAt) + '</td><td>' + (PRIORITY_LABEL[t.priority] || t.priority) + '</td><td>' + (t.dueAt < Date.now() ? '<span class="pill bad">逾期</span>' : '未完成') + '</td></tr>';
      }).join('') + '</table>';
    $('client-detail').innerHTML = html;
    window.scrollTo(0, document.body.scrollHeight);
  });
}

/* ── 商机管线 ─────────────────────────────────────── */
function loadPipeline() {
  return api('/overview').then(function (data) {
    var cards = '';
    data.pipeline.stages.forEach(function (s) {
      cards += '<div class="card" style="min-width:150px"><div class="l">' + (STAGE_LABEL[s.stage] || s.stage) + '</div><div class="v">' + s.count + '</div><div class="s">' + money(s.amount) + '</div></div>';
    });
    $('pipeline-cards').innerHTML = '<div class="cards" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">' + cards + '</div>';
  }).then(function () {
    var q = new URLSearchParams();
    if ($('stage-filter').value) q.set('stage', $('stage-filter').value);
    q.set('limit', '100');
    return api('/opportunities?' + q);
  }).then(function (deals) {
    var html = '<table><tr><th>产品</th><th>阶段</th><th>金额</th><th>概率</th><th>收尾</th><th>操作</th></tr>'
      + deals.map(function (d) {
        var terminal = d.stage === 'won' || d.stage === 'lost' || d.stage === 'abandoned';
        var acts = '';
        if (!terminal) {
          var next = { new: 'qualified', qualified: 'proposal', proposal: 'negotiation', negotiation: 'won' }[d.stage];
          acts = '<button class="act" onclick="moveDeal(\\'' + d.id + '\\',\\'' + next + '\\')">→ ' + (STAGE_LABEL[next] || next) + '</button> ';
          if (d.stage !== 'new') acts += '<button class="act red" onclick="moveDeal(\\'' + d.id + '\\',\\'lost\\',\\'客户暂缓\\')">判输</button>';
        } else {
          acts = '<span class="muted">' + dateOf(d.closedAt) + (d.closeReason ? ' · ' + esc(d.closeReason) : '') + '</span>';
        }
        return '<tr><td>' + esc(d.productName || d.productKind) + '<div class="muted">' + String(d.clientId).slice(0, 8) + '</div></td>'
          + '<td><span class="pill ' + (d.stage === 'won' ? 'ok' : terminal ? 'bad' : 'dim') + '">' + (STAGE_LABEL[d.stage] || d.stage) + '</span></td>'
          + '<td class="pill money">' + money(d.amount) + '</td>'
          + '<td>' + d.probability + '%</td>'
          + '<td class="muted">' + dateOf(d.expectedCloseAt) + '</td>'
          + '<td>' + acts + '</td></tr>';
      }).join('') + '</table>';
    $('opp-list').innerHTML = html;
  });
}
function moveDeal(id, to, reason) {
  var body = { to: to };
  if (reason) body.closeReason = reason;
  return post('/opportunities/' + id + '/move', body)
    .then(function () { toast('已推进到 ' + (STAGE_LABEL[to] || to)); loadPipeline(); })
    .catch(function (e) { toast(e.message, true); });
}

/* ── 任务 ─────────────────────────────────────────── */
function loadTasks() {
  var f = $('task-filter').value;
  var q = new URLSearchParams();
  if (f === 'overdue') q.set('overdue', 'true'); else q.set('status', f);
  q.set('limit', '100');
  return api('/tasks?' + q).then(function (tasks) {
    var html = '<table><tr><th>标题</th><th>类型</th><th>到期</th><th>优先级</th><th>状态</th><th>操作</th></tr>'
      + tasks.map(function (t) {
        var overdue = t.status === 'open' && new Date(t.dueAt) < new Date();
        var acts = t.status === 'open'
          ? '<button class="act" onclick="taskAct(\\'' + t.id + '\\',\\'complete\\')">完成</button> <button class="act gray" onclick="taskAct(\\'' + t.id + '\\',\\'cancel\\')">取消</button>'
          : '<span class="muted">' + dateOf(t.completedAt) + '</span>';
        return '<tr><td>' + esc(t.title) + '</td><td class="muted">' + esc(t.kind) + '</td>'
          + '<td>' + dateOf(t.dueAt) + (overdue ? ' <span class="pill bad">逾期</span>' : '') + '</td>'
          + '<td>' + (PRIORITY_LABEL[t.priority] || t.priority) + '</td>'
          + '<td>' + (t.status === 'open' ? '未完成' : t.status === 'done' ? '已完成' : '已取消') + '</td>'
          + '<td>' + acts + '</td></tr>';
      }).join('') + '</table>';
    $('task-list').innerHTML = html;
  });
}
function taskAct(id, act) {
  return post('/tasks/' + id + '/' + act)
    .then(function () { toast('任务已' + (act === 'complete' ? '完成' : '取消')); loadTasks(); })
    .catch(function (e) { toast(e.message, true); });
}

/* ── 适当性审计 ───────────────────────────────────── */
function loadAudit() {
  return api('/audit?limit=100').then(function (entries) {
    var html = entries.map(function (e) {
      var blocked = e.verdict !== 'matched';
      return '<div class="auditblock" style="border-left-color:' + (blocked ? '#7a3d3d' : '#2c5a40') + '">'
        + '<b>' + esc(e.clientName) + '</b> <span class="muted">' + dateOf(e.occurredAt) + ' · ' + esc(e.product.name) + '（' + e.product.riskLevel + '）</span><br>'
        + '<span class="pill ' + (blocked ? 'bad' : 'ok') + '">' + (VERDICT_LABEL[e.verdict] || e.verdict) + '</span> '
        + '<span class="muted">' + esc(e.rationale) + '</span></div>';
    }).join('') || '<div class="muted">暂无审计记录</div>';
    $('audit-list').innerHTML = html;
  });
}

/* ── 新建客户 / 记咨询 对话框 ──────────────────────── */
$('client-new').onclick = function () {
  api('/advisors').then(function (rows) {
    $('nc-advisor').innerHTML = '<option value="">（稍后指派）</option>' + rows.map(function (a) {
      return '<option value="' + a.id + '">' + esc(a.name) + (a.team ? '（' + esc(a.team) + '）' : '') + '</option>'
    }).join('')
    $('dlg-client').showModal()
  })
};
$('nc-cancel').onclick = function () { $('dlg-client').close(); };
$('nc-save').onclick = function () {
  var body = { name: $('nc-name').value, kind: $('nc-kind').value };
  if ($('nc-advisor').value) body.advisorId = $('nc-advisor').value;
  if ($('nc-tolerance').value) body.tolerance = $('nc-tolerance').value;
  if ($('nc-region').value) body.region = $('nc-region').value;
  if ($('nc-aum').value) body.totalAum = Number($('nc-aum').value);
  if ($('nc-tags').value) body.tags = $('nc-tags').value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
  post('/clients', body).then(function () {
    $('dlg-client').close();
    $('nc-name').value = ''; $('nc-region').value = ''; $('nc-aum').value = ''; $('nc-tags').value = '';
    toast('客户已建档'); loadClients();
  }).catch(function (e) { toast(e.message, true); });
};
function consultFor(clientId) {
  api('/clients?limit=100').then(function (rows) {
    $('cs-client').innerHTML = rows.map(function (c) {
      return '<option value="' + c.id + '"' + (c.id === clientId ? ' selected' : '') + '>' + esc(c.name) + (c.tolerance ? '（' + c.tolerance + '）' : '（未测评）') + '</option>';
    }).join('');
    $('dlg-consult').showModal();
  });
}
$('cs-cancel').onclick = function () { $('dlg-consult').close(); };
$('cs-save').onclick = function () {
  var kinds = { fund: 'fund', insurance: 'insurance', structured: 'structured' };
  post('/consultations', {
    clientId: $('cs-client').value,
    // The wire boundary takes products as JSON-encoded strings.
    products: [JSON.stringify({ name: $('cs-product').value, kind: 'fund', riskLevel: $('cs-risk').value })],
    summary: $('cs-summary').value,
  }).then(function (record) {
    $('dlg-consult').close();
    var v = record.products[0];
    toast(v.verdict === 'matched' ? '✓ 适当性匹配' : '✗ 已阻断：' + (VERDICT_LABEL[v.verdict] || v.verdict), v.verdict !== 'matched');
    loadClients();
  }).catch(function (e) { toast(e.message, true); });
  void kinds;
};

/* ── 投顾方案 ─────────────────────────────────────── */
$('plan-new').onclick = function () {
  api('/clients?limit=100').then(function (rows) {
    $('plan-client').innerHTML = rows.map(function (c) {
      return '<option value="' + c.id + '">' + esc(c.name) + '</option>'
    }).join('')
    $('dlg-plan').showModal()
  })
}
$('pl-cancel').onclick = function () { $('dlg-plan').close() }
$('pl-save').onclick = function () {
  var kind = $('pl-kind').value
  var body = { clientId: $('pl-client').value, kind: kind }
  if (kind === 'recurring-investment') {
    body.monthlyAmount = Number($('pl-monthly').value)
    body.deductionDay = Number($('pl-day').value)
    body.productName = $('pl-product').value
  } else if (kind === 'allocation') {
    body.sleevesJson = JSON.stringify([
      { name: '固收', kind: 'fund', targetPercent: Number($('pl-fixed').value) },
      { name: '权益', kind: 'fund', targetPercent: Number($('pl-equity').value) },
      { name: '现金', kind: 'fund', targetPercent: Number($('pl-cash').value) },
    ])
    body.rebalanceBand = 5
  } else {
    body.annualIncome = Number($('pl-income').value)
    body.incomeYears = Number($('pl-years').value)
    body.existingLifeCover = Number($('pl-life').value || 0)
    body.existingCriticalIllnessCover = Number($('pl-ci').value || 0)
  }
  post('/plans', body).then(function (record) {
    $('dlg-plan').close()
    toast('方案已创建（' + record.id.slice(0, 8) + '）')
    loadPlans()
  }).catch(function (e) { toast(e.message, true) })
}
function reviewPlan(id) {
  return api('/plans-review?planId=' + id).then(function (r) {
    var p = r.plan
    var html = '<h3>方案详情</h3><div class="detail"><div class="kv">'
      + '状态 <b>' + esc(p.status) + '</b>　'
      + (p.recurring ? '月投 <b>' + money(p.recurring.monthlyAmount) + '</b>，每月 ' + p.recurring.deductionDay + ' 日，标的 <b>' + esc(p.recurring.productName) + '</b>　' : '')
      + (p.allocation ? '再平衡带宽 <b>±' + p.allocation.rebalanceBand + '%</b>　' : '')
      + (p.protectionGap ? '建议寿险保额 <b>' + money(p.protectionGap.recommendedLifeCover) + '</b>，建议重疾保额 <b>' + money(p.protectionGap.recommendedCriticalIllnessCover) + '</b>　' : '')
      + '</div></div>'
    if (p.allocation) {
      html += '<h3>当前配置 vs 目标</h3><table><tr><th>部分</th><th>目标</th><th>当前</th><th>偏离</th><th>状态</th></tr>'
      html += r.allocation.sleeves.map(function (s) {
        return '<tr><td>' + esc(s.name) + '</td><td>' + s.targetPercent + '%</td><td>' + s.currentPercent + '%</td><td>' + (s.driftPercent > 0 ? '+' : '') + s.driftPercent + '%</td><td>' + (s.breached ? '<span class="pill bad">偏离超限</span>' : '<span class="pill ok">正常</span>') + '</td></tr>'
      }).join('') + '</table>'
      html += r.allocation.needsRebalance ? '<p class="pill warn" style="margin-top:10px;display:inline-block">⚠ 需要再平衡</p>' : '<p class="pill ok" style="margin-top:10px;display:inline-block">✓ 配置在带宽内</p>'
    }
    $('plan-review').innerHTML = html
    window.scrollTo(0, document.body.scrollHeight)
  })
}
function loadPlans() {
  return api('/plans').then(function (plans) {
    var html = '<table><tr><th>方案</th><th>客户</th><th>类型</th><th>状态</th><th>更新</th><th>操作</th></tr>'
      + plans.map(function (p) {
        var kindLabel = { 'recurring-investment': '定投计划', allocation: '资产配置', 'protection-gap': '保障缺口' }[p.kind] || p.kind
        var statusPill = { draft: 'dim', active: 'ok', paused: 'warn', completed: 'ok', cancelled: 'bad' }[p.status] || 'dim'
        var acts = '<button class="act" onclick="reviewPlan(\\'' + p.id + '\\')">评估</button> '
        if (p.status === 'draft') acts += '<button class="act" onclick="transitionPlan(\\'' + p.id + '\\',\\'active\\')">激活</button>'
        else if (p.status === 'active') acts += '<button class="act gray" onclick="transitionPlan(\\'' + p.id + '\\',\\'paused\\')">暂停</button> <button class="act" onclick="transitionPlan(\\'' + p.id + '\\',\\'completed\\')">完成</button>'
        else if (p.status === 'paused') acts += '<button class="act" onclick="transitionPlan(\\'' + p.id + '\\',\\'active\\')">恢复</button>'
        return '<tr><td class="muted">' + String(p.id).slice(0, 8) + '</td>'
          + '<td class="muted">' + String(p.clientId).slice(0, 8) + '</td>'
          + '<td>' + kindLabel + '</td>'
          + '<td><span class="pill ' + statusPill + '">' + esc(p.status) + '</span></td>'
          + '<td class="muted">' + dateOf(p.updatedAt) + '</td>'
          + '<td>' + acts + '</td></tr>'
      }).join('') + '</table>'
    $('plan-list').innerHTML = html
  })
}
function transitionPlan(id, to) {
  return post('/plans-transition', { planId: id, to: to })
    .then(function () { toast('方案状态已更新'); loadPlans() })
    .catch(function (e) { toast(e.message, true) })
}

/* ── 商机创建 ─────────────────────────────────────── */
$('opp-new').onclick = function () {
  api('/clients?limit=100').then(function (rows) {
    $('dl-client').innerHTML = rows.map(function (c) {
      return '<option value="' + c.id + '">' + esc(c.name) + '</option>'
    }).join('')
    $('dlg-deal').showModal()
  })
}
$('dl-cancel').onclick = function () { $('dlg-deal').close() }
$('dl-save').onclick = function () {
  post('/opportunities', {
    clientId: $('dl-client').value,
    productKind: 'fund',
    productName: $('dl-product').value,
    amount: Number($('dl-amount').value),
  }).then(function () {
    $('dlg-deal').close()
    $('dl-product').value = ''; $('dl-amount').value = ''
    toast('商机已创建'); loadPipeline()
  }).catch(function (e) { toast(e.message, true) })
}

/* ── 互动记录 ─────────────────────────────────────── */
$('log-interaction').onclick = function () {
  api('/clients?limit=100').then(function (rows) {
    $('it-client').innerHTML = rows.map(function (c) {
      return '<option value="' + c.id + '">' + esc(c.name) + '</option>'
    }).join('')
    $('dlg-interaction').showModal()
  })
}
$('it-cancel').onclick = function () { $('dlg-interaction').close() }
$('it-save').onclick = function () {
  post('/interactions', {
    clientId: $('it-client').value,
    kind: $('it-kind').value,
    summary: $('it-summary').value,
    topics: $('it-topic').value ? [$('it-topic').value] : [],
  }).then(function () {
    $('dlg-interaction').close()
    $('it-summary').value = ''
    toast('互动已记录'); loadClientsWithAdvisors()
  }).catch(function (e) { toast(e.message, true) })
}

/* ── 任务创建 ─────────────────────────────────────── */
$('task-new').onclick = function () {
  Promise.all([api('/clients?limit=100'), api('/advisors')]).then(function (r) {
    $('tk-client').innerHTML = '<option value="">（不关联客户）</option>' + r[0].map(function (c) {
      return '<option value="' + c.id + '">' + esc(c.name) + '</option>'
    }).join('')
    $('tk-advisor').innerHTML = r[1].map(function (a) {
      return '<option value="' + a.id + '">' + esc(a.name) + '</option>'
    }).join('')
    rememberAdvisors(r[1])
    $('dlg-task').showModal()
  })
}
$('tk-cancel').onclick = function () { $('dlg-task').close() }
$('tk-save').onclick = function () {
  var body = {
    title: $('tk-title').value,
    dueAt: Math.floor(new Date($('tk-due').value || '2026-12-31').getTime() / 1000) * 1000,
    priority: $('tk-priority').value,
  }
  if ($('tk-client').value) body.clientId = $('tk-client').value
  if ($('tk-advisor').value) body.advisorId = $('tk-advisor').value
  post('/tasks', body).then(function () {
    $('dlg-task').close()
    $('tk-title').value = ''
    toast('任务已创建'); loadTasks()
  }).catch(function (e) { toast(e.message, true) })
}

$('pl-kind').onchange = function () {
  var v = this.value
  $('pl-recurring-fields').style.display = v === 'recurring-investment' ? '' : 'none'
  $('pl-allocation-fields').style.display = v === 'allocation' ? '' : 'none'
  $('pl-protection-fields').style.display = v === 'protection-gap' ? '' : 'none'
}
function reviewPlan(id) { return window.reviewPlan(id) }

/* ── 导航与筛选 ───────────────────────────────────── */
function loadInsights() {
  return Promise.all([api('/rfm'), api('/funnel'), api('/segments')]).then(function (r) {
    var rfm = r[0], funnel = r[1], segments = r[2]
    var tierLabel = { champion: '冠军客户', loyal: '忠诚客户', promising: '潜力客户', 'needs-attention': '需关注', 'at-risk': '流失风险', dormant: '沉睡' }
    var tierClass = { champion: 'ok', loyal: 'ok', promising: 'dim', 'needs-attention': 'warn', 'at-risk': 'bad', dormant: 'dim' }
    $('rfm-tiers').innerHTML = rfm.tiers.map(function (t) {
      return '<div class="card"><div class="l">' + (tierLabel[t.tier] || t.tier) + '</div><div class="v">' + t.count + '</div></div>'
    }).join('')
    $('rfm-rows').innerHTML = '<table><tr><th>客户</th><th>R</th><th>F</th><th>M</th><th>评分</th><th>分层</th><th>最近互动</th><th>互动次数</th><th>AUM</th></tr>'
      + rfm.rows.map(function (row) {
        return '<tr><td>' + esc(row.name) + '</td><td>' + row.recency + '</td><td>' + row.frequency + '</td><td>' + row.monetary + '</td><td><b>' + row.score + '</b></td><td><span class="pill ' + (tierClass[row.tier] || 'dim') + '">' + (tierLabel[row.tier] || row.tier) + '</span></td><td class="muted">' + (row.lastInteractionAt ? dateOf(row.lastInteractionAt) : '—') + '</td><td>' + row.interactions + '</td><td class="pill money">' + money(row.totalAum) + '</td></tr>'
      }).join('') + '</table>'
    var maxCount = 1
    funnel.stages.forEach(function (s) { maxCount = Math.max(maxCount, s.count) })
    $('funnel').innerHTML = '<div class="detail">' + funnel.stages.map(function (s) {
      var pct = s.conversionFromPrevious === null ? '—' : s.conversionFromPrevious + '%'
      return '<div style="display:flex;align-items:center;gap:10px;margin:6px 0">'
        + '<span class="pill dim" style="width:64px;text-align:center">' + (STAGE_LABEL[s.stage] || s.stage) + '</span>'
        + '<span style="flex:1"><span class="bar"><i style="width:' + Math.round(s.count / maxCount * 100) + '%"></i></span></span>'
        + '<span class="muted" style="width:170px;text-align:right">' + s.count + ' 单 · 转化 ' + pct + '</span></div>'
    }).join('') + '</div>'
    $('segments').innerHTML = segments.map(function (seg) {
      return '<div class="detail"><div class="kv"><b>' + esc(seg.label) + '</b>（' + seg.count + ' 人 · AUM ' + money(seg.totalAum) + '）<span class="muted"> — ' + esc(seg.description) + '</span></div>'
        + '<div class="muted" style="margin-top:6px">' + (seg.rows.slice(0, 8).map(function (row) { return esc(row.name) }).join('、') || '暂无') + (seg.count > 8 ? ' 等 ' + seg.count + ' 人' : '') + '</div></div>'
    }).join('')
  })
}
document.querySelectorAll('button.export').forEach(function (btn) {
  btn.onclick = function () {
    fetch(API + '/' + btn.dataset.export).then(function (res) {
      if (!res.ok) throw new Error('导出失败 ' + res.status);
      var header = res.headers.get('content-disposition') || '';
      var m = header.match(/filename="([^"]+)"/);
      return res.blob().then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = m ? m[1] : 'export.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        toast('CSV 已下载（' + btn.textContent.trim() + '）');
      });
    }).catch(function (e) { toast(e && e.message ? e.message : '导出失败', true); });
  };
});

var clientLoadSeq = 0;
function loadClientsWithAdvisors() {
  var seq = ++clientLoadSeq;
  return api('/advisors').then(function (rows) {
    if (seq !== clientLoadSeq) return;   // a newer load superseded this one
    rememberAdvisors(rows);
    return loadClients().then(function () {
      if (seq !== clientLoadSeq) return; // same guard for the table render
    });
  });
}
var views = { overview: loadOverview, clients: loadClientsWithAdvisors, pipeline: loadPipeline, tasks: loadTasks, audit: loadAudit, insights: loadInsights };
document.querySelectorAll('nav button').forEach(function (btn) {
  btn.onclick = function () {
    document.querySelectorAll('nav button').forEach(function (b) { b.classList.remove('on'); });
    btn.classList.add('on');
    document.querySelectorAll('main section').forEach(function (s) { s.classList.remove('on'); });
    $(btn.dataset.view).classList.add('on');
    views[btn.dataset.view]();
  };
});
var clientQTimer;
$('client-q').oninput = function () {
  clearTimeout(clientQTimer);
  clientQTimer = setTimeout(loadClientsWithAdvisors, 300);
};
$('client-kind').onchange = loadClientsWithAdvisors;
$('client-lifecycle').onchange = loadClientsWithAdvisors;
$('client-tolerance').onchange = loadClientsWithAdvisors;
$('stage-filter').onchange = loadPipeline;
$('opp-refresh').onclick = loadPipeline;
$('task-filter').onchange = loadTasks;
$('task-refresh').onclick = loadTasks;
$('audit-refresh').onclick = loadAudit;
loadOverview();
</script>
</body>
</html>`
