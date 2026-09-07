/**
 * The console single-page application, served verbatim at
 * `/session-import-console`. One self-contained HTML document (no build step,
 * no external assets): a conversation-hub layout — sidebar with date-grouped,
 * searchable, provider-filtered listings; detail pane rendering the selected
 * conversation as a chat thread with an import action.
 *
 * The page renders entirely through `document.createElement` / `textContent`
 * so every provider-supplied or user-supplied string reaches the DOM as a
 * text node, never as parsed HTML — no escape helper needed inside the
 * renderers.
 * @module @deepseek-ai/dsh-session-import-console/src/page
 */

/**
 * The full client script. Kept as a TypeScript string-literal so the
 * TypeScript compiler type-checks the surrounding TypeScript module even
 * though the page is served verbatim with no build step.
 *
 * Convention: every renderer builds nodes through `el(tag, props?, ...kids)`
 * and every user-visible string lands in a text node — no `innerHTML` is
 * used to assemble the sidebar list, the detail pane, or the toast. Fixed
 * UI labels (Chinese) and structural HTML (chips, group labels, action
 * buttons) are the only strings concatenated as HTML.
 */
const PAGE_SCRIPT = `'use strict';
var API = '/session-import-console/api';
var PROVIDERS = {
  'claude-code': { label: 'Claude Code', short: 'C', color: '#ef8b56' },
  'codex':       { label: 'Codex',      short: 'X', color: '#3ddba0' },
  'zcode':       { label: 'ZCode',      short: 'Z', color: '#4da3ff' },
  'minimax':     { label: 'MiniMax',    short: 'M', color: '#f478b4' },
};
var FALLBACK_META = { label: '?', short: '?', color: '#8b96ad' };
var BATCH_CONCURRENCY = 3;
var state = {
  provider: null,
  query: '',
  rows: [],
  selected: null,
  importing: false,
  abort: null,
  selectMode: false,
  selectedIds: {},
};
var rowKey = function (row) { return row.provider + ':' + row.sourceId; };
var $ = function (id) { return document.getElementById(id); };

function el(tag, props, kids) {
  var node = document.createElement(tag);
  if (props !== undefined) {
    for (var key in props) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
      var value = props[key];
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'style' && typeof value === 'object') {
        for (var s in value) node.style[s] = value[s];
      } else if (key.indexOf('on') === 0) {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else {
        node.setAttribute(key, value);
      }
    }
  }
  if (kids !== undefined) {
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (kid === null || kid === undefined || kid === false) continue;
      node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
  }
  return node;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function fmtTime(ms, withTime) {
  if (!ms) return '—';
  var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
  var date = d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate());
  return withTime ? date + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) : date;
}
function fmtClock(ms) {
  if (!ms) return '';
  var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
  return p(d.getHours()) + ':' + p(d.getMinutes());
}
function groupLabel(ms) {
  if (!ms) return '更早';
  var now = new Date();
  var d = new Date(ms);
  var day = 86400000;
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= today) return '今天';
  if (ms >= today - day) return '昨天';
  if (ms >= today - 7 * day) return '最近 7 天';
  if (ms >= today - 30 * day) return '最近 30 天';
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月';
}
function toast(kind, text) {
  var t = $('toast');
  t.className = 'toast ' + kind;
  t.textContent = text;
  if (kind === 'ok') setTimeout(function () { t.className = 'toast'; }, 4200);
}
function rowTitle(row) {
  return row.title && row.title.length > 0 ? row.title : row.sourceId.slice(0, 22) + '…';
}

/* ── sidebar ── */
function makeChip(label, dotColor, isOn, onClick) {
  var dot = dotColor !== undefined ? el('span', { class: 'dot', style: { background: dotColor } }) : null;
  var chip = el('button', { class: 'chip' + (isOn ? ' on' : '') }, dot !== null ? [dot, label] : [label]);
  chip.addEventListener('click', onClick);
  return chip;
}

function renderChips() {
  var box = $('chips');
  clear(box);
  var setProvider = function (next) { state.provider = next; renderChips(); loadList(); };
  box.appendChild(makeChip('全部', undefined, state.provider === null, function () { setProvider(null); }));
  Object.keys(PROVIDERS).forEach(function (id) {
    var meta = PROVIDERS[id];
    box.appendChild(makeChip(meta.label, meta.color, state.provider === id, function () { setProvider(id); }));
  });
}

function makeRow(row, meta) {
  var isOn = state.selected === row.sourceId;
  var key = rowKey(row);
  var checked = state.selectedIds[key] === true;
  var titleNode = el('div', { class: 'item-title', text: rowTitle(row) });
  var timeNode = el('span', { class: 'time', text: fmtTime(row.mtimeMs) });
  var metaBits = [timeNode];
  if (row.imported) metaBits.push(el('span', { class: 'badge-in', text: '已导入' }));
  var metaNode = el('div', { class: 'item-meta' }, metaBits);
  var body = el('div', { class: 'item-body' }, [titleNode, metaNode]);
  var logo = el('div', { class: 'logo', style: { background: meta.color }, text: meta.short });
  var kids = [logo, body];
  if (state.selectMode) {
    var box = el('input', { type: 'checkbox', class: 'row-check' });
    box.checked = checked;
    box.addEventListener('click', function (e) { e.stopPropagation(); });
    box.addEventListener('change', function () { toggleSelected(key, box.checked); });
    kids.unshift(box);
  }
  var item = el('div', { class: 'item' + (isOn ? ' on' : '') + (checked ? ' checked' : '') }, kids);
  item.addEventListener('click', function () {
    if (state.selectMode) { toggleSelected(key, !state.selectedIds[key]); return; }
    select(row);
  });
  return item;
}

function toggleSelected(key, on) {
  if (on) state.selectedIds[key] = true;
  else delete state.selectedIds[key];
  renderList();
  renderBatchBar();
}

function setSelectMode(on) {
  state.selectMode = on;
  if (!on) state.selectedIds = {};
  var btn = $('multi');
  if (btn) {
    btn.textContent = on ? '☑ 多选（已开）' : '☐ 多选';
    btn.classList.toggle('on', on);
  }
  var detail = $('detail');
  if (!state.selectMode) {
    if (state.rows.length === 0) {
      clear(detail);
      detail.appendChild(el('div', { class: 'placeholder' }, [
        el('div', { class: 'big', text: '⇄' }),
        el('div', { class: 't', text: '选择左侧对话查看内容' }),
      ]));
    }
    // Restore the previously selected preview if the user is still pointing at one row.
    if (state.selected !== null) {
      var match = null;
      for (var i = 0; i < state.rows.length; i++) {
        if (state.rows[i].sourceId === state.selected) { match = state.rows[i]; break; }
      }
      if (match !== null) select(match);
    }
  }
  renderList();
  renderBatchBar();
}

function renderBatchBar() {
  var bar = $('batch-bar');
  if (!bar) return;
  if (!state.selectMode) { clear(bar); return; }
  clear(bar);
  var ids = Object.keys(state.selectedIds);
  var note = el('span', { class: 'batch-note', text: '已选 ' + ids.length + ' 个' });
  var importBtn = el('button', {
    class: 'btn primary',
    text: state.importing ? '批量导入中…' : '批量导入 ' + ids.length,
  });
  importBtn.disabled = state.importing || ids.length === 0;
  importBtn.addEventListener('click', batchImport);
  var cancelBtn = el('button', { class: 'btn', text: '退出多选' });
  cancelBtn.addEventListener('click', function () { setSelectMode(false); });
  bar.appendChild(note);
  bar.appendChild(importBtn);
  bar.appendChild(cancelBtn);
}

function batchImport() {
  var keys = Object.keys(state.selectedIds);
  if (keys.length === 0) return;
  state.importing = true;
  renderBatchBar();
  var imported = 0, upToDate = 0, conflict = 0, errors = 0;
  var cursor = 0;
  function next() {
    if (cursor >= keys.length) {
      state.importing = false;
      state.selectedIds = {};
      renderBatchBar();
      renderList();
      var msg = '批量完成：导入 ' + imported + ' · 未变 ' + upToDate + ' · 冲突 ' + conflict + ' · 失败 ' + errors;
      toast(errors > 0 ? 'err' : 'ok', msg);
      loadList();
      return;
    }
    var key = keys[cursor++];
    var colonAt = key.indexOf(':');
    var provider = key.slice(0, colonAt);
    var sourceId = key.slice(colonAt + 1);
    var force = state.rows.some(function (r) { return rowKey(r) === key && r.imported; });
    fetch(API + '/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: provider, sourceId: sourceId, ...(force ? { force: true } : {}) }),
    })
      .then(function (r) { return r.json(); })
      .then(function (body) {
        if (!body.ok) { errors++; return; }
        if (body.data.status === 'imported') imported++;
        else if (body.data.status === 'up-to-date') upToDate++;
        else conflict++;
      })
      .catch(function () { errors++; })
      .then(next);
  }
  var workers = [];
  for (var i = 0; i < Math.min(BATCH_CONCURRENCY, keys.length); i++) workers.push(next());
  Promise.all(workers).catch(function () {});
}

function renderList() {
  var box = $('groups');
  clear(box);
  if (state.rows.length === 0) {
    box.appendChild(el('div', { class: 'side-empty', text: state.query ? '没有命中的对话' : '没有发现对话' }));
    return;
  }
  var groups = [];
  var lastLabel = null;
  state.rows.forEach(function (row) {
    var label = groupLabel(row.mtimeMs);
    if (label !== lastLabel) { groups.push({ label: label, rows: [] }); lastLabel = label; }
    groups[groups.length - 1].rows.push(row);
  });
  groups.forEach(function (g) {
    box.appendChild(el('div', { class: 'group-label', text: g.label }));
    g.rows.forEach(function (row) {
      var meta = PROVIDERS[row.provider] || FALLBACK_META;
      box.appendChild(makeRow(row, meta));
    });
  });
}

function loadList() {
  var empty = $('side-empty');
  if (empty) empty.textContent = '加载中…';
  if (state.abort !== null) state.abort.abort();
  var ctl = new AbortController();
  state.abort = ctl;
  var qs = [];
  if (state.provider) qs.push('provider=' + encodeURIComponent(state.provider));
  if (state.query) qs.push('query=' + encodeURIComponent(state.query));
  var url = API + '/sources' + (qs.length ? '?' + qs.join('&') : '');
  fetch(url, { signal: ctl.signal })
    .then(function (r) { return r.json(); })
    .then(function (body) {
      if (state.abort !== ctl) return;
      if (!body.ok) { toast('err', body.error || '加载失败'); return; }
      state.rows = body.data || [];
      $('count').textContent = state.rows.length + ' 个来源';
      renderList();
    })
    .catch(function (e) {
      if (e && e.name === 'AbortError') return;
      toast('err', String(e));
    })
    .finally(function () { if (state.abort === ctl) state.abort = null; });
}

/* ── detail ── */
function select(row) {
  state.selected = row.sourceId;
  renderList();
  var detail = $('detail');
  clear(detail);
  detail.appendChild(el('div', { class: 'spin' }));
  fetch(API + '/preview?provider=' + encodeURIComponent(row.provider) + '&sourceId=' + encodeURIComponent(row.sourceId))
    .then(function (r) { return r.json(); })
    .then(function (body) {
      if (!body.ok) { renderDetailError(detail, body.error || '读取失败'); return; }
      renderDetail(detail, row, body.data);
    })
    .catch(function (e) { renderDetailError(detail, String(e)); });
}

function renderDetailError(detail, msg) {
  clear(detail);
  detail.appendChild(el('div', { class: 'placeholder' }, [
    el('div', { class: 'big', text: '⚠' }),
    el('div', { class: 't', text: msg }),
  ]));
}

function makeMsgBubble(m) {
  var inner = el('div', { class: 'bubble' }, [document.createTextNode(m.text)]);
  if (m.toolCalls && m.toolCalls.length) {
    var tools = el('div', { class: 'tools' });
    m.toolCalls.forEach(function (t) {
      tools.appendChild(el('span', { class: 'tool', text: '🔧 ' + t.name }));
    });
    inner.appendChild(tools);
  }
  var bits = [inner];
  if (m.at) bits.push(el('div', { class: 'time', text: fmtClock(m.at) }));
  return el('div', { class: 'msg ' + m.role }, bits);
}

function renderDetail(detail, row, pv) {
  var meta = PROVIDERS[row.provider] || FALLBACK_META;
  var subBits = [el('span', { style: { color: meta.color }, text: meta.label })];
  if (pv.model) subBits.push(el('span', { class: 'mono', text: pv.model }));
  subBits.push(el('span', { text: pv.messages.length + (pv.hasMore ? '+' : '') + ' 条消息' }));
  subBits.push(el('span', { text: pv.totalToolCalls + ' 次工具调用' }));
  if (pv.startedAt) subBits.push(el('span', { text: fmtTime(pv.startedAt, true) }));
  var titleBits = el('div', { style: { flex: '1', minWidth: '0' } }, [
    el('div', { class: 'dh-title', text: pv.title || row.sourceId }),
    el('div', { class: 'dh-sub' }, subBits),
  ]);
  var btn = el('button', { class: 'btn primary', id: 'do-import', text: row.imported ? '⟳ 重新导入' : '导入到 harness' });
  btn.addEventListener('click', function () { doImport(row, btn, row.imported); });
  var head = el('div', { class: 'detail-head' }, [
    el('div', { class: 'logo', style: { background: meta.color }, text: meta.short }),
    titleBits,
    btn,
  ]);
  var inner = el('div', { class: 'thread-inner' });
  pv.messages.forEach(function (m) { inner.appendChild(makeMsgBubble(m)); });
  if (pv.hasMore) {
    inner.appendChild(el('div', { class: 'more', text: '仅显示前 ' + pv.messages.length + ' 条 · 全部 ' + pv.totalEntries + ' 个条目，导入后可查看完整历史' }));
  }
  var thread = el('div', { class: 'thread' }, [inner]);
  clear(detail);
  detail.appendChild(head);
  detail.appendChild(thread);
}

function doImport(row, btn, force) {
  btn.disabled = true;
  btn.textContent = force ? '重新导入中…' : '导入中…';
  state.importing = true;
  fetch(API + '/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: row.provider, sourceId: row.sourceId, ...(force ? { force: true } : {}) }),
  })
    .then(function (r) { return r.json(); })
    .then(function (body) {
      state.importing = false;
      if (!body.ok) {
        btn.disabled = false;
        btn.textContent = force ? '⟳ 重新导入' : '导入到 harness';
        toast('err', body.error || '导入失败');
        return;
      }
      var o = body.data;
      if (o.status === 'imported') {
        btn.textContent = '⟳ 重新导入';
        toast('ok', (force ? '已重新导入为新版本：' : '导入成功：') + o.sessionId + '，可在 harness 会话列表中打开续跑');
      } else if (o.status === 'up-to-date') {
        btn.textContent = '⟳ 重新导入';
        toast('ok', '来源无变化，目标会话已是最新');
      } else {
        btn.textContent = '⟳ 重新导入';
        toast('err', '来源已变化且目标已存在（conflict），未被覆盖；点「重新导入」可另存新版本');
      }
      loadList();
    })
    .catch(function (e) {
      state.importing = false;
      btn.disabled = false;
      btn.textContent = '导入到 harness';
      toast('err', String(e));
    });
}

// 「同步全部」只把各 code agent 的会话刷新进左侧列表——重新发现全部来源并
// 重绘，绝不导入。导入永远只在点开某个会话后按「导入到 harness」发生。
$('sync').addEventListener('click', function () {
  if (state.selectMode) setSelectMode(false);
  var b = $('sync');
  b.disabled = true;
  b.textContent = '⟳ 同步中…';
  $('sync-note').textContent = '';
  state.provider = null;
  renderChips();
  loadList();
  setTimeout(function () {
    b.disabled = false;
    b.textContent = '⟳ 同步全部';
    $('sync-note').textContent = '已刷新 ' + state.rows.length + ' 个会话（未导入任何内容）';
  }, 600);
});
$('multi').addEventListener('click', function () { setSelectMode(!state.selectMode); });
$('q').addEventListener('input', function (e) {
  state.query = e.target.value.trim();
  clearTimeout(window.__t);
  window.__t = setTimeout(loadList, 280);
});
renderChips();
loadList();
`

/**
 * The console document served verbatim at `/session-import-console`.
 */
export const CONSOLE_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>会话导入控制台</title>
<style>
  :root {
    --bg: #0d0f15; --panel: #141823; --panel-2: #171c29; --border: #262b38; --border-soft: #1e2331;
    --text: #d7dde8; --muted: #8a94a8; --faint: #5b6577;
    --accent: #6e56cf; --accent-2: #5b8def; --ok: #3ddba0; --warn: #f4b860;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body { font-family: 'PingFang SC','Microsoft YaHei',-apple-system,sans-serif; background: var(--bg); color: var(--text); overflow: hidden; }
  .app { display: flex; height: 100vh; }

  /* ── Sidebar ─────────────────────────────────────────── */
  .side { width: 340px; min-width: 340px; background: var(--panel); border-right: 1px solid var(--border); display: flex; flex-direction: column; }
  .side-head { padding: 16px 16px 10px; }
  .side-head h1 { font-size: 15px; font-weight: 600; color: #fff; display: flex; align-items: center; gap: 8px; }
  .side-head .count { font-size: 11px; color: var(--faint); font-weight: 400; }
  .search { position: relative; margin: 4px 12px 10px; }
  .search input { width: 100%; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 12.5px; padding: 7px 12px 7px 30px; }
  .search input::placeholder { color: var(--faint); }
  .search .icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); font-size: 12px; color: var(--faint); }
  .syncrow { display: flex; align-items: center; gap: 10px; padding: 0 12px 10px; }
  .syncrow .btn.sync { font-size: 11.5px; padding: 4px 12px; border-radius: 7px; }
  .sync-note { font-size: 11px; color: var(--faint); }
  .chips { display: flex; gap: 6px; padding: 0 12px 10px; flex-wrap: wrap; }
  .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--muted); background: transparent; border: 1px solid var(--border); border-radius: 99px; padding: 3.5px 11px; cursor: pointer; }
  .chip .dot { width: 7px; height: 7px; border-radius: 50%; }
  .chip.on { color: #fff; border-color: var(--accent); background: rgba(110,86,207,.16); }
  .groups { flex: 1; overflow-y: auto; }
  .group-label { font-size: 11px; color: var(--faint); padding: 10px 16px 5px; position: sticky; top: 0; background: var(--panel); z-index: 2; }
  .item { display: flex; gap: 10px; padding: 9px 14px; cursor: pointer; border-left: 2px solid transparent; }
  .item:hover { background: rgba(255,255,255,.03); }
  .item.on { background: rgba(110,86,207,.12); border-left-color: var(--accent); }
  .item.checked { background: rgba(61,219,160,.08); border-left-color: var(--ok); }
  .row-check { width: 16px; height: 16px; margin: 8px 0 0 2px; cursor: pointer; accent-color: var(--accent); flex-shrink: 0; }
  .logo { width: 30px; height: 30px; border-radius: 9px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; color: #fff; margin-top: 2px; }
  .item-body { flex: 1; min-width: 0; }
  .item-title { font-size: 13px; font-weight: 540; color: #e8edf5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .item-meta { font-size: 10.5px; color: var(--faint); margin-top: 3px; display: flex; gap: 8px; align-items: center; }
  .item-meta .time { font-variant-numeric: tabular-nums; }
  .badge-in { color: var(--ok); font-size: 10px; border: 1px solid rgba(61,219,160,.35); border-radius: 99px; padding: 0 7px; }
  .side-empty { padding: 30px 16px; text-align: center; color: var(--faint); font-size: 12.5px; }

  /* ── Detail ──────────────────────────────────────────── */
  .detail { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .detail-head { display: flex; align-items: center; gap: 12px; padding: 13px 22px; border-bottom: 1px solid var(--border); background: var(--panel); }
  .detail-head .logo { width: 34px; height: 34px; font-size: 14px; }
  .dh-title { font-size: 14.5px; font-weight: 600; color: #fff; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dh-sub { font-size: 11px; color: var(--muted); margin-top: 2px; display: flex; gap: 10px; flex-wrap: wrap; }
  .dh-sub .mono { font-family: ui-monospace,'SF Mono',monospace; }
  .btn { border-radius: 8px; font-size: 12.5px; padding: 7px 16px; cursor: pointer; border: 1px solid var(--border); background: var(--panel-2); color: var(--text); white-space: nowrap; }
  .btn.primary { background: linear-gradient(135deg, var(--accent), var(--accent-2)); border: none; color: #fff; font-weight: 600; }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.primary:disabled { opacity: .45; cursor: default; }
  .thread { flex: 1; overflow-y: auto; padding: 22px 26px; }
  .thread-inner { max-width: 860px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
  .msg { display: flex; }
  .msg.user { justify-content: flex-end; }
  .msg .bubble { max-width: 78%; border-radius: 14px; padding: 9px 14px; font-size: 13px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
  .msg.user .bubble { background: linear-gradient(135deg, #6e56cf, #4f7bd9); color: #fff; border-bottom-right-radius: 5px; }
  .msg.assistant { justify-content: flex-start; }
  .msg.assistant .bubble { background: var(--panel-2); border: 1px solid var(--border-soft); color: #dbe2ee; border-bottom-left-radius: 5px; }
  .tools { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }
  .tool { font-size: 11px; color: var(--muted); background: rgba(255,255,255,.035); border: 1px solid var(--border-soft); border-radius: 6px; padding: 2px 8px; font-family: ui-monospace,'SF Mono',monospace; }
  .time { font-size: 10px; color: var(--faint); margin-top: 4px; }
  .msg.user .time { text-align: right; }
  .more { text-align: center; color: var(--faint); font-size: 12px; padding: 10px 0 2px; }
  .placeholder { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--faint); }
  .placeholder .big { font-size: 42px; opacity: .5; }
  .placeholder .t { font-size: 13.5px; }
  .msg-note { text-align:center; color: var(--faint); font-size: 12px; padding: 6px 0; }
  .spin { width: 26px; height: 26px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: r 0.8s linear infinite; margin: 40px auto; }
  @keyframes r { to { transform: rotate(360deg); } }
  .toast { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); font-size: 12.5px; padding: 9px 18px; border-radius: 10px; display: none; z-index: 9; max-width: 80vw; }
  .toast.ok { display: block; background: #12331f; color: var(--ok); border: 1px solid #1e5c36; }
  .toast.err { display: block; background: #3a1c1c; color: #e08a8a; border: 1px solid #66292e; }

  /* ── Batch bar ────────────────────────────────────── */
  .batch-bar { display: flex; align-items: center; gap: 10px; padding: 10px 22px; border-top: 1px solid var(--border); background: var(--panel); }
  .batch-bar:empty { display: none; }
  .batch-bar .batch-note { font-size: 12px; color: var(--muted); flex: 1; }
  .btn.on { background: rgba(110,86,207,.18); border-color: var(--accent); color: #fff; }
</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="side-head"><h1>对话 <span class="count" id="count"></span></h1></div>
    <div class="search"><span class="icon">⌕</span><input id="q" placeholder="搜索对话内容" /></div>
    <div class="syncrow"><button class="btn sync" id="sync">⟳ 同步全部</button><button class="btn" id="multi">☐ 多选</button><span id="sync-note" class="sync-note"></span></div>
    <div class="chips" id="chips"></div>
    <div class="groups" id="groups"><div class="side-empty" id="side-empty">加载中…</div></div>
  </aside>
  <section class="detail" id="detail">
    <div class="placeholder"><div class="big">⇄</div><div class="t">选择左侧对话查看内容</div></div>
  </section>
  <div class="batch-bar" id="batch-bar"></div>
</div>
<div class="toast" id="toast"></div>
<script>
${PAGE_SCRIPT}
</script>
</body>
</html>
`
