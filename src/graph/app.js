const ROW = 32, LANE = 20, REFW = 190, MAXLANES = 22;
const COLORS = ['#15a0bf','#0669f7','#8e00c2','#c517b6','#d90171','#cd0101','#f25d2e','#f2ca33','#7bd938','#2ece9d'];
const ICON = {
  local: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="8" rx="1"/><path d="M5 14h6"/></svg>',
  remote: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4.5 12.5h7.5a2.5 2.5 0 0 0 .3-5A4 4 0 0 0 4.6 6.6 3 3 0 0 0 4.5 12.5z"/></svg>',
  tag: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 2h6l6 6-6 6-6-6z"/><circle cx="5.5" cy="5.5" r="1"/></svg>',
  branch: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="4" cy="3" r="1.6"/><circle cx="4" cy="13" r="1.6"/><circle cx="12" cy="5" r="1.6"/><path d="M4 4.6v6.8M12 6.6c0 3-8 1.5-8 4.8"/></svg>',
  stash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="3"/><path d="M3 6v7h10V6M6.5 9h3"/></svg>',
};

const S = { repo: null, repos: [], repoName: null, all: [], filter: { author: '', branch: '', days: 0 },
  hide: lsGet('hide') === '1', list: [], refs: null, status: null, nodes: [], sel: -1, cache: new Map(),
  ctx: null, fileIdx: -1, mode: lsGet('mode') || 'hunk', matches: [], mi: -1, sig: null };
const $ = id => document.getElementById(id);

function lsGet(k) { try { return localStorage.getItem('kl.' + k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem('kl.' + k, v); } catch {} }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2200); }
// The same UI runs in two places: served by server.py (fetch /api/...), and as
// Repo Radar's History window, where Tauri commands named kl_<cmd> do the work.
const TAURI = window.__TAURI_INTERNALS__;
const PARAMS = new URLSearchParams(location.search);
const APP_NAME = document.title;
async function api(cmd, args = {}) {
  if (TAURI) {
    try { return await TAURI.invoke('kl_' + cmd, { root: PARAMS.get('root'), ...args }); }
    catch (e) { throw new Error(String(e)); }
  }
  const q = new URLSearchParams(Object.entries(args).filter(([, v]) => v != null));
  const r = await fetch(`/api/${cmd}?${q}`); const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText); return j;
}
const repoApi = (cmd, args = {}) => api(cmd, { repo: S.repoName, ...args });
function initials(name) {
  const p = (name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : (p[0][1] || ''))).toUpperCase();
}
function hashColor(s) { let h = 0; for (const c of s || '') h = (h * 31 + c.charCodeAt(0)) | 0; return COLORS[Math.abs(h) % COLORS.length]; }
function relTime(t) {
  const d = Date.now() / 1000 - t;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  if (d < 86400 * 7) return Math.floor(d / 86400) + 'd ago';
  return new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function fullTime(t) { return new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }

/* ---------- Loading ---------- */
async function loadAll(keep) {
  const prevHash = keep && S.list[S.sel] ? S.list[S.sel].hash : null;
  const [repo, lg, st] = await Promise.all([repoApi('repo'), repoApi('log'), repoApi('status')]);
  S.repo = repo; S.refs = lg.refs; S.status = st;
  if (!keep) S.cache.clear();
  const dirty = st.staged.length + st.unstaged.length > 0;
  S.all = (dirty ? [{ hash: 'WIP', wip: true, parents: repo.head ? [repo.head] : [], subject: '// WIP',
    author: '', time: Date.now() / 1000, refs: [] }] : []).concat(lg.commits);
  S.allIndex = new Map(S.all.map((c, i) => [c.hash, i]));
  S.cache.delete('WIP');
  renderHeader(); renderSide(); renderFilterBar();
  applyFilters(prevHash ?? (dirty ? 'WIP' : repo.head), !keep);
  if (!S.all.length) $('details').innerHTML = '<div class="empty">No commits yet.</div>';
}

/* ---------- Filters ---------- */
// Dim mode keeps the full graph and fades commits that don't match. Hide mode
// drops them and reconnects each kept commit to its nearest kept ancestors,
// the way `git log --author=...` rewrites parents.
function passes(c) {
  if (c.wip) return true;
  const f = S.filter;
  return (!f.author || c.author === f.author)
    && (!f.days || c.time >= Date.now() / 1000 - f.days * 86400)
    && (!f.branch || S.reach.has(c.hash));
}
function filtering() { const f = S.filter; return !!(f.author || f.branch || f.days); }

function reachable(tip) {
  const seen = new Set(), stack = [tip];
  while (stack.length) {
    const h = stack.pop(), i = S.allIndex.get(h);
    if (i === undefined || seen.has(h)) continue;
    seen.add(h); stack.push(...S.all[i].parents);
  }
  return seen;
}

function rewriteParents(kept) {
  const memo = new Map();
  const nearest = h => {
    if (kept.has(h)) return [h];
    const i = S.allIndex.get(h);
    if (i === undefined) return [];  // beyond the loaded history, through a hidden commit
    if (memo.has(h)) return memo.get(h);
    memo.set(h, []);
    const r = [...new Set(S.all[i].parents.flatMap(nearest))];
    memo.set(h, r); return r;
  };
  const list = S.all.filter(c => kept.has(c.hash)).map(c => ({ ...c,
    parents: [...new Set(c.parents.flatMap(p => S.allIndex.has(p) ? nearest(p) : [p]))] }));
  // Drop a parent that is already an ancestor of another parent: it adds a
  // redundant line (and usually a whole extra lane) without adding information.
  const byHash = new Map(list.map(c => [c.hash, c]));
  const reaches = (from, target) => {
    const seen = new Set(), stack = [from];
    while (stack.length) {
      const h = stack.pop();
      if (h === target) return true;
      if (seen.has(h)) continue;
      seen.add(h); stack.push(...(byHash.get(h)?.parents || []));
    }
    return false;
  };
  for (const c of list) {
    if (c.parents.length > 1)
      c.parents = c.parents.filter(p => !c.parents.some(q => q !== p && reaches(q, p)));
  }
  return list;
}

function applyFilters(selectHash, scroll = true) {
  const prev = selectHash ?? S.list[S.sel]?.hash;
  const on = filtering();
  S.pass = new Set(S.all.filter(passes).map(c => c.hash));
  S.list = on && S.hide ? rewriteParents(S.pass) : S.all;
  S.index = new Map(S.list.map((c, i) => [c.hash, i]));
  renderGraph(); runSearch(false);
  const shown = S.all.filter(c => !c.wip && S.pass.has(c.hash)).length, total = S.all.filter(c => !c.wip).length;
  $('fCount').textContent = on ? `${shown} of ${total} commits` : `${total} commits`;
  $('fClear').hidden = !on;
  document.querySelectorAll('.fbar .seg button').forEach(b => b.classList.toggle('on', (b.dataset.fmode === 'hide') === S.hide));
  let i = S.index.get(prev);
  if (i === undefined || !S.pass.has(prev)) i = S.list.findIndex(c => S.pass.has(c.hash));
  S.sel = -1;
  if (i >= 0) select(i, { scroll, center: scroll });
  else $('details').innerHTML = '<div class="empty">No commits match these filters.</div>';
}

function renderFilterBar() {
  const counts = new Map();
  for (const c of S.all) if (!c.wip) counts.set(c.author, (counts.get(c.author) || 0) + 1);
  const authors = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const f = S.filter;
  if (f.author && !counts.has(f.author)) f.author = '';
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  $('fAuthor').innerHTML = opt('', 'Everyone', f.author) + authors.map(([a, n]) => opt(a, `${a} (${n})`, f.author)).join('');
  const R = S.refs, names = [...R.local.map(b => b.name), ...R.remote.map(b => b.name)];
  if (f.branch && !names.includes(f.branch)) f.branch = '';
  $('fBranch').innerHTML = opt('', 'All branches', f.branch)
    + (R.local.length ? `<optgroup label="Local">${R.local.map(b => opt(b.name, b.name, f.branch)).join('')}</optgroup>` : '')
    + (R.remote.length ? `<optgroup label="Remote">${R.remote.map(b => opt(b.name, b.name, f.branch)).join('')}</optgroup>` : '');
  $('fDays').value = String(f.days);
  setBranchReach();
}
function setBranchReach() {
  const f = S.filter, R = S.refs;
  const tip = f.branch && [...R.local, ...R.remote].find(b => b.name === f.branch)?.hash;
  S.reach = tip ? reachable(tip) : new Set();
}
function setFilter(patch) {
  Object.assign(S.filter, patch);
  if ('branch' in patch) setBranchReach();
  renderFilterBar(); applyFilters();
}
$('fAuthor').onchange = e => setFilter({ author: e.target.value });
$('fBranch').onchange = e => setFilter({ branch: e.target.value });
$('fDays').onchange = e => setFilter({ days: +e.target.value });
$('fClear').onclick = () => setFilter({ author: '', branch: '', days: 0 });
document.querySelectorAll('.fbar .seg button').forEach(b => b.onclick = () => {
  S.hide = b.dataset.fmode === 'hide'; lsSet('hide', S.hide ? '1' : '0'); applyFilters();
});

function renderHeader() {
  const r = S.repo;
  $('repoSel').innerHTML = S.repos.map(n => `<option ${n === r.name ? 'selected' : ''}>${esc(n)}</option>`).join('');
  $('branchPill').innerHTML = ICON.branch + esc(r.branch === 'HEAD' ? 'detached @ ' + r.head.slice(0, 7) : r.branch);
  document.title = `${r.name} — ${APP_NAME}`;
}

/* ---------- Sidebar ---------- */
function renderSide() {
  const R = S.refs, head = S.repo.branch;
  const trk = t => { if (!t) return ''; const a = /ahead (\d+)/.exec(t), b = /behind (\d+)/.exec(t);
    return `<span class="trk">${a ? '↑' + a[1] : ''}${a && b ? ' ' : ''}${b ? '↓' + b[1] : ''}</span>`; };
  const item = (icon, name, hash, extra = '', cls = '') =>
    `<div class="ref ${cls}" data-hash="${hash}" title="${esc(name)}">${icon}<span class="nm">${esc(name)}</span>${extra}</div>`;
  const byRemote = {};
  for (const r of R.remote) { const k = r.name.split('/')[0]; (byRemote[k] ||= []).push(r); }
  const sec = (title, n, body, open = true) =>
    `<details class="sec" ${open ? 'open' : ''}><summary>${title}<span class="n">${n}</span></summary>${body}</details>`;
  let html = '';
  if (S.list[0]?.wip) {
    const n = S.status.staged.length + S.status.unstaged.length;
    html += `<div class="ref" data-hash="WIP" style="padding-left:12px">${ICON.stash}<span class="nm">Uncommitted changes</span><span class="trk">${n}</span></div>`;
  }
  html += sec('Local', R.local.length, R.local.map(b => item(ICON.local, b.name, b.hash, trk(b.track), b.name === head ? 'head' : '')).join(''));
  html += sec('Remote', R.remote.length, Object.entries(byRemote).map(([k, list]) =>
    `<div class="subhead">${esc(k)}</div>` + list.map(b => item(ICON.remote, b.name.slice(k.length + 1), b.hash)).join('')).join(''));
  html += sec('Tags', R.tags.length, R.tags.map(t => item(ICON.tag, t.name, t.hash)).join(''), R.tags.length < 15);
  if (R.stashes) html += sec('Stashes', R.stashes, '<div class="subhead">Shown in graph as “stash”</div>', false);
  $('side').innerHTML = html;
}
$('side').addEventListener('click', e => {
  const el = e.target.closest('.ref'); if (!el) return;
  const i = S.index.get(el.dataset.hash);
  if (i === undefined) toast(S.allIndex.has(el.dataset.hash) ? 'That commit is hidden by the filters' : 'That commit is older than the loaded history');
  else select(i, { scroll: true, center: true });
});

/* ---------- Graph layout ---------- */
function layout(list) {
  const lanes = []; let colorN = 0, maxL = 1;
  const nodes = [], paths = {};
  const X = c => LANE / 2 + c * LANE + 4, Y = i => i * ROW + ROW / 2;
  const seg = (c1, r1, c2, r2, color) => {
    const x1 = X(c1), y1 = Y(r1), x2 = X(c2), y2 = Y(r2);
    paths[color] = (paths[color] || '') + (x1 === x2 ? `M${x1} ${y1}V${y2}`
      : `M${x1} ${y1}C${x1} ${y1 + ROW * .55} ${x2} ${y2 - ROW * .55} ${x2} ${y2}`);
  };
  list.forEach((c, i) => {
    let col = lanes.findIndex(l => l && l.hash === c.hash), color;
    if (col < 0) {
      col = lanes.indexOf(null); if (col < 0) { col = lanes.length; lanes.push(null); }
      color = colorN++ % COLORS.length;
    } else color = lanes[col].color;
    // edges from the previous row into this one
    lanes.forEach((l, j) => { if (l) seg(l.from, i - 1, l.hash === c.hash ? col : j, i, l.color); });
    lanes.forEach((l, j) => { if (l && l.hash === c.hash) lanes[j] = null; else if (l) l.from = j; });
    nodes.push({ col, color });
    c.parents.forEach((p, k) => {
      if (k === 0) { lanes[col] = { hash: p, color, from: col }; return; }
      const existing = lanes.find(l => l && l.hash === p);
      let j = lanes.indexOf(null); if (j < 0) { j = lanes.length; lanes.push(null); }
      lanes[j] = { hash: p, color: existing ? existing.color : colorN++ % COLORS.length, from: col };
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    maxL = Math.max(maxL, lanes.length, col + 1);
  });
  // lanes that continue past the loaded history fade out downward
  lanes.forEach((l, j) => { if (l) seg(l.from, list.length - 1, j, list.length - .5, l.color); });
  return { nodes, paths, maxL, X, Y };
}

function renderGraph() {
  const { nodes, paths, maxL, X, Y } = layout(S.list);
  S.nodes = nodes;
  const gw = Math.min(maxL, MAXLANES) * LANE + 12;
  $('center').style.setProperty('--gw', gw + 'px');
  const svg = $('svg'), h = S.list.length * ROW;
  svg.setAttribute('width', gw); svg.setAttribute('height', h); svg.setAttribute('viewBox', `0 0 ${gw} ${h}`);
  let g = Object.entries(paths).map(([c, d]) =>
    `<path d="${d}" stroke="${COLORS[c]}" stroke-width="2" fill="none" stroke-linecap="round"/>`).join('');
  const faded = c => filtering() && !S.hide && !S.pass.has(c.hash);
  S.list.forEach((c, i) => {
    const n = nodes[i], col = COLORS[n.color], x = X(n.col), y = Y(i);
    if (faded(c)) g += `<g opacity=".25">`;
    if (c.wip) g += `<circle cx="${x}" cy="${y}" r="9" fill="#1b1d23" stroke="${col}" stroke-width="2" stroke-dasharray="3 2.5"/>`;
    else if (c.parents.length > 1) g += `<circle cx="${x}" cy="${y}" r="5" fill="${col}" stroke="#1b1d23" stroke-width="2"/>`;
    else g += `<circle cx="${x}" cy="${y}" r="10" fill="${col}" stroke="#1b1d23" stroke-width="2"/>`
      + `<text x="${x}" y="${y + 3.3}" text-anchor="middle" font-size="9" font-weight="700" fill="#fff" font-family="system-ui">${esc(initials(c.author))}</text>`;
    if (faded(c)) g += '</g>';
  });
  svg.innerHTML = g;
  const local = new Set(S.refs.local.map(b => b.name));
  $('rows').innerHTML = S.list.map((c, i) => {
    const lc = COLORS[nodes[i].color];
    return `<div class="row ${faded(c) ? 'fdim' : ''}" data-i="${i}" style="--lc:${lc}" title="${c.wip ? '' : c.hash.slice(0, 10)}">`
      + `<div class="c-refs">${refPills(c, local)}</div><div></div>`
      + `<div class="c-msg ${c.wip ? 'wip' : ''}">${esc(c.wip ? wipLabel() : c.subject)}</div>`
      + `<div class="c-author">${esc(c.author)}</div>`
      + `<div class="c-date" title="${fullTime(c.time)}">${c.wip ? '' : relTime(c.time)}</div></div>`;
  }).join('');
}
function wipLabel() {
  const s = S.status, parts = [];
  if (s.unstaged.length) parts.push(`${s.unstaged.length} unstaged`);
  if (s.staged.length) parts.push(`${s.staged.length} staged`);
  return '// WIP — ' + parts.join(', ');
}
function refPills(c, local) {
  const groups = new Map(), tags = [];
  const g = n => groups.get(n) || (groups.set(n, { name: n, local: false, remote: false, head: false }), groups.get(n));
  for (const r of c.refs) {
    if (r === 'HEAD' || r.endsWith('/HEAD')) continue;
    if (r.startsWith('HEAD -> ')) { const b = g(r.slice(8)); b.local = b.head = true; }
    else if (r.startsWith('tag: ')) tags.push(r.slice(5));
    else if (r === 'refs/stash') g('stash').stash = true;
    else if (local.has(r)) g(r).local = true;
    else g(r.includes('/') ? r.slice(r.indexOf('/') + 1) : r).remote = true;
  }
  const all = [...groups.values()].sort((a, b) => b.head - a.head)
    .map(b => `<span class="pill ${b.head ? 'head' : ''}" title="${esc(b.name)}">${b.stash ? ICON.stash : ''}${b.local ? ICON.local : ''}${b.remote ? ICON.remote : ''}<span>${esc(b.name)}</span></span>`)
    .concat(tags.map(t => `<span class="pill tag" title="tag ${esc(t)}">${ICON.tag}<span>${esc(t)}</span></span>`));
  if (all.length <= 1) return all.join('');
  return all[0] + `<span class="pill more" title="${esc([...groups.keys(), ...tags].join(', '))}">+${all.length - 1}</span>`;
}

/* ---------- Selection & details ---------- */
$('rows').addEventListener('click', e => { const r = e.target.closest('.row'); if (r) select(+r.dataset.i); });

async function select(i, opt = {}) {
  if (i < 0 || i >= S.list.length) return;
  const rows = $('rows').children;
  rows[S.sel]?.classList.remove('sel');
  S.sel = i; rows[i].classList.add('sel');
  if (opt.scroll) {
    const sc = $('scroll'), top = i * ROW;
    if (opt.center) sc.scrollTop = top - sc.clientHeight / 2;
    else if (top < sc.scrollTop || top + ROW > sc.scrollTop + sc.clientHeight) sc.scrollTop = top - sc.clientHeight / 3;
  }
  const c = S.list[i];
  if (c.wip) return renderWip();
  let d = S.cache.get(c.hash);
  if (!d) {
    $('details').innerHTML = '<div class="empty">Loading…</div>';
    try { d = await repoApi('commit', { sha: c.hash }); } catch (e) { $('details').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    S.cache.set(c.hash, d);
    if (S.list[S.sel] !== c) return;
  }
  renderCommit(d);
}

function fileRow(f, i, ctx) {
  const slash = f.path.lastIndexOf('/');
  const dir = slash >= 0 ? f.path.slice(0, slash + 1) : '', name = f.path.slice(slash + 1);
  const total = (f.add || 0) + (f.del || 0), boxes = Math.min(5, total);
  const na = total ? Math.round(boxes * (f.add || 0) / total) : 0;
  const bar = f.add == null ? `<span class="ad" style="color:var(--muted)">${f.status === '?' ? 'new' : 'bin'}</span>`
    : `<span class="ad"><span class="a">+${f.add}</span> <span class="d">−${f.del}</span><span class="bar">${'<i class="a"></i>'.repeat(na)}${'<i class="d"></i>'.repeat(boxes - na)}${'<i></i>'.repeat(5 - boxes)}</span></span>`;
  return `<div class="file" data-ctx="${ctx}" data-i="${i}" title="${esc(f.oldPath ? f.oldPath + ' → ' + f.path : f.path)}">`
    + `<span class="st ${f.status}">${f.status === '?' ? '+' : f.status}</span>`
    + `<span class="fp"><bdi><span class="dir">${esc(dir)}</span>${esc(name)}</bdi></span>${f.status === 'D' && f.add == null ? '' : bar}</div>`;
}
function summary(files) {
  const n = k => files.filter(f => k.includes(f.status)).length;
  const a = files.reduce((s, f) => s + (f.add || 0), 0), d = files.reduce((s, f) => s + (f.del || 0), 0);
  const bits = [['M', 'modified'], ['A?', 'added'], ['D', 'deleted'], ['RC', 'renamed']]
    .filter(([k]) => n(k)).map(([k, w]) => `<span><span class="st ${k[0]}" style="display:inline-grid;vertical-align:-3px">${k[0] === '?' ? '+' : k[0]}</span> <b>${n(k)}</b> ${w}</span>`);
  return `<div class="d-sum">${bits.join('')}<span class="ad" style="margin-left:auto"><span class="a">+${a}</span> <span class="d">−${d}</span></span></div>`;
}

function renderCommit(d) {
  const [subj, ...rest] = d.message.split('\n');
  const body = rest.join('\n').trim();
  S.ctxs = { c: { kind: 'commit', sha: d.hash, base: d.base, files: d.files } };
  $('details').innerHTML = `<div class="d-pad">
      <div class="d-sha">commit ${d.hash.slice(0, 10)} <button data-copy="${d.hash}">copy SHA</button></div>
      <div class="d-subj">${esc(subj)}</div>${body ? `<div class="d-body">${esc(body)}</div>` : ''}
      <div class="d-author"><div class="av" style="background:${hashColor(d.email)}">${esc(initials(d.author))}</div>
        <div><div>${esc(d.author)} <a class="flink" data-author="${esc(d.author)}" title="Show only this author's commits">filter</a></div><div class="when">authored ${relTime(d.time)} · ${fullTime(d.time)}</div></div></div>
      ${d.parents.length ? `<div class="d-parents">parent${d.parents.length > 1 ? 's' : ''}:${d.parents.map(p => `<a data-jump="${p}">${p.slice(0, 7)}</a>`).join('')}</div>` : ''}
    </div>
    ${d.parents.length > 1 ? '<div class="d-note">Merge commit — showing changes compared to the first parent.</div>' : ''}
    ${summary(d.files)}
    <div class="fh">Changed files<span class="n">${d.files.length}</span></div>
    ${d.files.map((f, i) => fileRow(f, i, 'c')).join('') || '<div class="empty">No file changes</div>'}`;
  markActiveFile();
}

function renderWip() {
  const s = S.status;
  S.ctxs = { u: { kind: 'unstaged', files: s.unstaged }, s: { kind: 'staged', files: s.staged } };
  const all = s.unstaged.concat(s.staged);
  $('details').innerHTML = `<div class="d-pad"><div class="d-subj">Uncommitted changes</div>
      <div class="d-body">On branch <b>${esc(S.repo.branch)}</b>. Click a file to see what changed.</div></div>
    ${summary(all)}
    <div class="fh">Unstaged files<span class="n">${s.unstaged.length}</span></div>
    ${s.unstaged.map((f, i) => fileRow(f, i, 'u')).join('') || '<div class="subhead">Nothing unstaged</div>'}
    <div class="fh">Staged files<span class="n">${s.staged.length}</span></div>
    ${s.staged.map((f, i) => fileRow(f, i, 's')).join('') || '<div class="subhead">Nothing staged</div>'}`;
  markActiveFile();
}

$('details').addEventListener('click', e => {
  const f = e.target.closest('.file');
  if (f) return openDiff(S.ctxs[f.dataset.ctx], +f.dataset.i);
  const fa = e.target.closest('[data-author]');
  if (fa) return setFilter({ author: fa.dataset.author });
  const j = e.target.closest('[data-jump]');
  if (j) { const i = S.index.get(j.dataset.jump); i === undefined ? toast('Parent is older than the loaded history') : select(i, { scroll: true, center: true }); }
  const cp = e.target.closest('[data-copy]');
  if (cp) navigator.clipboard.writeText(cp.dataset.copy).then(() => toast('SHA copied'), () => toast('Copy failed'));
});
function markActiveFile() {
  document.querySelectorAll('.file').forEach(el => el.classList.toggle('active',
    $('diff').classList.contains('open') && S.ctxs?.[el.dataset.ctx] === S.ctx && +el.dataset.i === S.fileIdx));
}

/* ---------- Diff ---------- */
function parseDiff(text) {
  const hunks = []; let h = null, o = 0, n = 0, binary = false;
  for (const l of text.split('\n')) {
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)/.exec(l);
      if (!m) continue;
      o = +m[1]; n = +m[2]; h = { head: l.slice(0, l.indexOf('@@', 2) + 2), ctx: m[3], lines: [] }; hunks.push(h); continue;
    }
    if (!h) { if (l.startsWith('Binary files')) binary = true; continue; }
    const t = l[0], s = l.slice(1);
    if (t === '+') h.lines.push({ t: 'add', s, n: n++ });
    else if (t === '-') h.lines.push({ t: 'del', s, o: o++ });
    else if (t === ' ') h.lines.push({ t: 'ctx', s, o: o++, n: n++ });
    else if (t === '\\') h.lines.push({ t: 'meta', s: l.slice(2) });
  }
  // word-level highlight for paired -/+ runs
  for (const hk of hunks) {
    const L = hk.lines;
    for (let i = 0; i < L.length;) {
      if (L[i].t !== 'del') { i++; continue; }
      let j = i; while (j < L.length && L[j].t === 'del') j++;
      let k = j; while (k < L.length && L[k].t === 'add') k++;
      for (let p = 0; p < Math.min(j - i, k - j); p++) inline(L[i + p], L[j + p]);
      i = k;
    }
  }
  return { hunks, binary };
}
function inline(a, b) {
  const x = a.s, y = b.s; let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  const changed = Math.max(x.length, y.length) - p - s;
  if (changed <= 0 || changed > Math.max(x.length, y.length) * 0.7) return;
  a.hl = [p, x.length - s]; b.hl = [p, y.length - s];
}
function code(l) {
  if (!l.hl) return esc(l.s) || ' ';
  const [a, b] = l.hl;
  return esc(l.s.slice(0, a)) + (b > a ? `<mark>${esc(l.s.slice(a, b))}</mark>` : '') + esc(l.s.slice(b));
}
const sign = { add: '+', del: '−', ctx: ' ', meta: '' };

function renderHunk(h) {
  return `<table class="code">${h.lines.map(l => `<tr class="${l.t}"><td class="ln">${l.o ?? ''}</td><td class="ln">${l.n ?? ''}</td><td class="sg">${sign[l.t]}</td><td>${l.t === 'meta' ? esc(l.s) : code(l)}</td></tr>`).join('')}</table>`;
}
function renderSplit(h) {
  const rows = [], L = h.lines;
  const side = (l, which) => !l ? `<td class="ln nil"></td><td class="sg nil"></td><td class="nil ${which}"></td>`
    : `<td class="ln ${l.t}">${which === 'sp' ? l.n : l.o}</td><td class="sg ${l.t}">${sign[l.t]}</td><td class="${l.t} ${which}">${code(l)}</td>`;
  for (let i = 0; i < L.length;) {
    const l = L[i];
    if (l.t === 'meta') { rows.push(`<tr class="meta"><td colspan="6">${esc(l.s)}</td></tr>`); i++; continue; }
    if (l.t === 'ctx') {
      rows.push(`<tr><td class="ln">${l.o}</td><td class="sg"></td><td>${code(l)}</td><td class="ln sp">${l.n}</td><td class="sg"></td><td>${code(l)}</td></tr>`);
      i++; continue;
    }
    const dels = [], adds = [];
    while (i < L.length && L[i].t === 'del') dels.push(L[i++]);
    while (i < L.length && L[i].t === 'add') adds.push(L[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++)
      rows.push(`<tr>${side(dels[k], '')}${side(adds[k], 'sp').replace('class="ln', 'class="ln sp')}</tr>`);
  }
  return `<table class="code"><colgroup><col style="width:52px"><col style="width:18px"><col><col style="width:52px"><col style="width:18px"><col></colgroup>${rows.join('')}</table>`;
}

async function openDiff(ctx, i) {
  if (!ctx || i < 0 || i >= ctx.files.length) return;
  S.ctx = ctx; S.fileIdx = i;
  const f = ctx.files[i];
  $('diff').classList.add('open'); markActiveFile();
  $('dSt').className = 'st ' + f.status; $('dSt').textContent = f.status === '?' ? '+' : f.status;
  $('dPath').textContent = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
  $('dAd').innerHTML = f.add == null ? '' : `<span class="a">+${f.add}</span> <span class="d">−${f.del}</span>`;
  $('dPrev').disabled = i === 0; $('dNext').disabled = i === ctx.files.length - 1;
  $('dbody').innerHTML = '<div class="empty">Loading…</div>';
  const args = { path: f.path, kind: f.status === '?' ? 'untracked' : ctx.kind, oldPath: f.oldPath };
  if (ctx.kind === 'commit') Object.assign(args, { sha: ctx.sha, base: ctx.base });
  let res;
  try { res = await repoApi('diff', args); } catch (e) { $('dbody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (S.ctx !== ctx || S.fileIdx !== i) return;
  S.parsed = parseDiff(res.diff); drawDiff(); $('dbody').scrollTop = 0;
}
function drawDiff() {
  const { hunks, binary } = S.parsed;
  document.querySelectorAll('.dh .seg button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
  if (binary) return $('dbody').innerHTML = '<div class="empty">Binary file — no text diff to show.</div>';
  if (!hunks.length) return $('dbody').innerHTML = '<div class="empty">No content changes (rename or mode change only).</div>';
  let budget = 6000, out = '';
  for (const h of hunks) {
    if (budget <= 0) { out += '<div class="empty">Diff truncated — file is very large.</div>'; break; }
    budget -= h.lines.length;
    out += `<div class="hunk"><div class="hh">${esc(h.head)} <b>${esc(h.ctx)}</b></div>${S.mode === 'split' ? renderSplit(h) : renderHunk(h)}</div>`;
  }
  $('dbody').innerHTML = out;
}
function closeDiff() { $('diff').classList.remove('open'); S.ctx = null; markActiveFile(); }
$('dBack').onclick = closeDiff;
$('dPrev').onclick = () => openDiff(S.ctx, S.fileIdx - 1);
$('dNext').onclick = () => openDiff(S.ctx, S.fileIdx + 1);
document.querySelectorAll('.dh .seg button').forEach(b => b.onclick = () => { S.mode = b.dataset.mode; lsSet('mode', S.mode); if (S.parsed) drawDiff(); });

/* ---------- Search ---------- */
function runSearch(jump) {
  const q = $('q').value.trim().toLowerCase(), rows = $('rows').children;
  S.matches = [];
  S.list.forEach((c, i) => {
    const hit = S.pass.has(c.hash) && (c.subject.toLowerCase().includes(q) || (c.author || '').toLowerCase().includes(q)
      || (!c.wip && c.hash.startsWith(q)) || c.refs.some(r => r.toLowerCase().includes(q)));
    rows[i].classList.toggle('dim', !!q && !hit);
    if (q && hit) S.matches.push(i);
  });
  $('qc').textContent = q ? `${S.matches.length ? S.mi + 1 + '/' : ''}${S.matches.length}` : '';
  if (jump && S.matches.length) { S.mi = 0; select(S.matches[0], { scroll: true, center: true }); $('qc').textContent = `1/${S.matches.length}`; }
}
$('q').addEventListener('input', () => { S.mi = -1; runSearch(true); });
$('q').addEventListener('keydown', e => {
  if (e.key === 'Enter' && S.matches.length) {
    S.mi = (S.mi + (e.shiftKey ? -1 : 1) + S.matches.length) % S.matches.length;
    select(S.matches[S.mi], { scroll: true, center: true }); $('qc').textContent = `${S.mi + 1}/${S.matches.length}`;
  }
  if (e.key === 'Escape') { $('q').value = ''; runSearch(false); $('q').blur(); }
});

/* ---------- Keyboard, repo switching, live refresh ---------- */
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey) return;
  const open = $('diff').classList.contains('open');
  if (e.key === 'Escape' && open) closeDiff();
  else if (open && e.key === '[') openDiff(S.ctx, S.fileIdx - 1);
  else if (open && e.key === ']') openDiff(S.ctx, S.fileIdx + 1);
  else if (!open && (e.key === 'ArrowDown' || e.key === 'j')) { e.preventDefault(); select(S.sel + 1, { scroll: true }); }
  else if (!open && (e.key === 'ArrowUp' || e.key === 'k')) { e.preventDefault(); select(S.sel - 1, { scroll: true }); }
  else if (e.key === '/') { e.preventDefault(); $('q').focus(); }
  else if (e.key === 'r') loadAll(true);
});
$('refresh').onclick = () => loadAll(true).then(() => toast('Refreshed'));
$('repoSel').onchange = e => openRepo(e.target.value);
async function openRepo(name) {
  S.repoName = name; S.sig = null; S.filter = { author: '', branch: '', days: 0 };
  PARAMS.set('repo', name); history.replaceState(null, '', '?' + PARAMS);
  closeDiff(); $('q').value = '';
  try { await loadAll(false); repoApi('signature').then(r => S.sig = r.sig, () => {}); }
  catch (err) { toast(err.message); }
}
async function checkLive() {
  if (document.hidden || !S.repoName) return;
  try {
    const { sig } = await repoApi('signature');
    if (S.sig && sig !== S.sig) { S.sig = sig; await loadAll(true); }
    S.sig = sig;
  } catch {}
}
setInterval(checkLive, 2500);
document.addEventListener('visibilitychange', checkLive);

api('repos').then(r => {
  S.repos = r.repos;
  if (!r.repos.length) throw new Error(`No git repos found in ${r.root}`);
  const want = PARAMS.get('repo');
  return openRepo(r.repos.includes(want) ? want : r.default || r.repos[0]);
}).catch(e => { $('details').innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
