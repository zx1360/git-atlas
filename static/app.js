/* Git Atlas. No third-party scripts, network services, or client dependencies. */
'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const number = value => new Intl.NumberFormat('en-US').format(value || 0);
const compact = value => Math.abs(value) >= 1e9 ? (value / 1e9).toFixed(2) + 'b' : Math.abs(value) >= 1e6 ? (value / 1e6).toFixed(2) + 'm' : number(value);
const signed = value => (value > 0 ? '+' : value < 0 ? '−' : '') + compact(Math.abs(value));
const dayMs = 86400000;
const toTime = day => Date.parse(day + 'T00:00:00Z');
const toDay = time => new Date(time).toISOString().slice(0, 10);
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const dotted = day => (day || '—').replaceAll('-', '.');
const colors = ['#9cceab','#8fa9cf','#cfb389','#b394bf','#7ab5b0','#c58c79','#a8b97c','#b1b8af'];
const languageColors = {TypeScript:'#82afc9',JavaScript:'#cabb7f',Python:'#8ab793',CSS:'#b39bc8',HTML:'#c99177',Rust:'#b78b76',Go:'#80b5b6',Markdown:'#a6bd92',JSON:'#c3b494',YAML:'#a6a6be','C / C++':'#9baaca'};
const state = {repo:null,job:null,data:null,branch:'',mainline:false,view:'overview',from:'',to:'',q:'',author:'',preset:'all',grain:'auto',year:null,
  offset:0,pageSize:60,order:'desc',total:0,scanSeq:0,dataSeq:0,listSeq:0,detailSeq:0,loading:false,series:[],chart:null,replay:1000,playing:false,speed:1,
  hovered:-1,drag:null,recent:[],analyticsController:null,listController:null,dataPending:false,successful:null};
const token = $('meta[name="git-atlas-session"]').content;
let toastTimer, searchTimer;

async function api(path, body, options = {}) {
  const response = await fetch(path, {...options, method:body === undefined ? 'GET' : 'POST',
    headers:{'X-Git-Atlas':token,...(body === undefined ? {} : {'Content-Type':'application/json'})},
    ...(body === undefined ? {} : {body:JSON.stringify(body)})});
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || `请求失败 (${response.status})`); }
  return response.json();
}
function toast(message, error = false) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.toggle('error', error); $('#toast').classList.remove('hidden');
  toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), error ? 6000 : 3200);
}
function queryString(extra = {}) {
  const values = {job:state.job?.id,from:state.from,to:state.to,q:state.q,author:state.author,...extra};
  return new URLSearchParams(Object.entries(values).filter(([,v]) => v !== '' && v != null)).toString();
}
function setLoading(active, job) {
  state.loading = active; $('#loading-overlay').classList.toggle('hidden', !active);
  $('#refresh-button').disabled = active; $('#export-button').disabled = active || state.dataPending || !state.data;
  $('#branch-select').disabled = active; $('#mainline').disabled = active || state.branch === '__all__';
  $('#mobile-branch-select').disabled = active;
  $('#refresh-button svg').classList.toggle('spin', active);
  if (job) {
    const percent = job.total ? Math.min(99, Math.round(job.processed / job.total * 100)) : 0;
    $('#loading-stage').textContent = job.stage || '正在读取本地历史';
    $('#loading-count').textContent = `${number(job.processed)}${job.total ? ' / '+number(job.total) : ''} 条提交`;
    $('#loading-percent').textContent = job.total ? percent + '%' : '…'; $('#loading-progress').style.width = Math.max(3, percent) + '%';
  }
}
function populateRepository() {
  const repo = state.repo;
  $('#side-repo-name').textContent = repo.name; $('#side-repo-name').title = repo.path;
  $('#side-repo-status').textContent = repo.demo ? 'DEMO REPOSITORY' : repo.shallow ? 'SHALLOW REPOSITORY' : repo.bare ? 'BARE REPOSITORY' : 'LOCAL REPOSITORY';
  $('#top-repo-name').textContent = repo.name; $('#top-repo-name').title = repo.path;
  $('#demo-badge').textContent = repo.demo ? '演示数据' : repo.shallow ? '浅克隆 · 部分历史' : '';
  $('#demo-badge').classList.toggle('hidden', !repo.demo && !repo.shallow);
  const local = repo.branches.filter(b => !b.remote), remote = repo.branches.filter(b => b.remote);
  const options = list => list.map(b => `<option value="${esc(b.ref)}">${esc(b.name)}${b.current ? ' · HEAD' : ''}</option>`).join('');
  const html = `<optgroup label="单分支">${options(local)}</optgroup>${remote.length ? `<optgroup label="远程跟踪分支">${options(remote)}</optgroup>` : ''}<optgroup label="全景"> <option value="__all__">所有分支 · 去重浏览</option></optgroup>`;
  $('#branch-select').innerHTML = html; $('#branch-select').value = state.branch;
  $('#mobile-branch-select').innerHTML = html; $('#mobile-branch-select').value = state.branch;
  $('#scope-name').textContent = state.branch === '__all__' ? '所有分支' : repo.branches.find(b => b.ref === state.branch)?.name || 'HEAD';
  $('#branch-explainer').innerHTML = state.branch === '__all__' ? '合并所有分支的可达历史，<br>同一提交只计算一次。' : state.mainline ? '只沿第一父提交回溯，<br>包含合并带来的文本增删。' : '包含此分支可达的全部提交，<br>无需切换工作区中的分支。';
  $('#mainline').checked = state.mainline; $('#mainline').disabled = state.branch === '__all__' || state.loading;
  document.title = `${repo.name} · Git Atlas`;
}
async function openRepository(path, demo = false) {
  $('#open-submit').disabled = true; $('#open-error').classList.add('hidden');
  try {
    const repo = await api('/api/open', {path,demo});
    state.repo = repo; state.branch = repo.defaultBranch; state.mainline = false; state.year = null;
    state.from = state.to = state.q = state.author = ''; state.preset = 'all'; state.offset = 0;
    $('#history-search').value = ''; $('#open-dialog').close();
    populateRepository();
    await scanRepository();
    const session = await api('/api/session'); state.recent = session.recent; renderRecentRepositories();
  } catch (error) {
    if ($('#open-dialog').open) { $('#open-error').textContent = error.message; $('#open-error').classList.remove('hidden'); }
    else toast(error.message, true);
  } finally { $('#open-submit').disabled = false; }
}
async function scanRepository(refresh = false) {
  pauseReplay(true); const seq = ++state.scanSeq; ++state.dataSeq; ++state.listSeq;
  window.scrollTo({top:0});
  state.analyticsController?.abort(); state.listController?.abort();
  setLoading(true, {processed:0,total:0,stage:'正在准备本地历史'});
  try {
    let job = await api('/api/scan', {repo:state.repo.id,branch:state.branch,mainline:state.mainline,refresh});
    while (job.status === 'loading') {
      if (seq !== state.scanSeq) return;
      setLoading(true, job); await new Promise(resolve => setTimeout(resolve, 420));
      job = await api('/api/jobs/' + job.id);
    }
    if (seq !== state.scanSeq) return;
    if (job.status === 'error') throw new Error(job.error || '解析失败，请重试。');
    state.job = job; state.repo = job.repo; state.mainline = job.mainline; state.offset = 0;
    populateRepository();
    await loadData(true);
    if (seq !== state.scanSeq) return;
    $('#cache-status').textContent = job.cached ? '缓存已命中 · 仓库只读' : `解析 ${job.elapsed || 0}s · 仓库只读`;
    setLoading(false);
  } catch (error) { if (seq === state.scanSeq) { state.dataPending=false; restoreSuccessful(); setLoading(false); toast(error.message, true); } }
}
async function refreshRepository() {
  if (!state.repo || state.loading) return;
  try {
    if (!state.repo.demo) {
      state.repo = await api('/api/open', {path:state.repo.path});
      if (state.branch !== '__all__' && !state.repo.branches.some(b => b.ref === state.branch)) state.branch = state.repo.defaultBranch;
      populateRepository();
    }
    await scanRepository(true);
  } catch (error) { toast(error.message, true); }
}
async function loadData(required = false) {
  if (!state.job) return;
  const seq = ++state.dataSeq;
  state.dataPending=true;$('#export-button').disabled=true;
  state.analyticsController?.abort(); state.analyticsController = new AbortController();
  try {
    const data = await api('/api/analytics?' + queryString(), undefined, {signal:state.analyticsController.signal});
    if (seq !== state.dataSeq) return;
    state.data = data; pauseReplay(true); renderAll();
    state.successful=Object.fromEntries(['repo','job','data','branch','mainline','from','to','q','author','preset','year'].map(k=>[k,state[k]]));
    if (state.view === 'history') await loadCommits();
  } catch (error) { if (error.name !== 'AbortError' && seq===state.dataSeq) { if (required) throw error; restoreSuccessful();toast(error.message, true); } }
  finally{if(seq===state.dataSeq){state.dataPending=false;$('#export-button').disabled=state.loading||!state.data;}}
}
function restoreSuccessful(){if(!state.successful)return;Object.assign(state,state.successful);$('#history-search').value=state.q;populateRepository();renderAll();if(state.view==='history')loadCommits();}
function renderAll() {
  renderFilters(); renderStats(); renderMilestones(); renderCalendar(); renderLanguages(); renderAuthors(); renderRecent(); renderRhythm();
  const selectedAuthor = state.author;
  $('#author-filter').innerHTML = '<option value="">全部作者</option>' + state.data.authorOptions.map(a => `<option value="${esc(a.email)}">${esc(a.name)} · ${esc(a.email)}</option>`).join('');
  $('#author-filter').value = selectedAuthor;
  state.series = buildSeries(); state.hovered = -1; $('#growth-tooltip').classList.add('hidden'); drawGrowth();
}
function renderFilters() {
  const s = state.data.summary;
  $('#date-description').textContent = s.first ? `${dotted(state.from || s.first)} — ${dotted(state.to || s.last)}` : state.from || state.to ? `${dotted(state.from || state.data.scope.first)} — ${dotted(state.to || state.data.scope.last)}` : '这段历史还是一张白纸';
  $$('.range-segments button').forEach(b => b.classList.toggle('active', b.dataset.range === state.preset));
  $('#filter-reset').classList.toggle('hidden', !(state.from || state.to || state.q || state.author));
  $('#date-from').value = state.from; $('#date-to').value = state.to;
  const chips = [];
  if(state.author)chips.push(`<button data-clear-filter="author" title="清除作者筛选">作者：${esc(state.data.authorOptions.find(a=>a.email===state.author)?.name||state.author)} <span>×</span></button>`);
  if(state.q)chips.push(`<button data-clear-filter="q" title="清除搜索筛选">搜索：${esc(state.q)} <span>×</span></button>`);
  $('#active-filters').innerHTML=chips.join('');$('#active-filters').classList.toggle('hidden',!chips.length);
}
function renderStats() {
  const s = state.data.summary;
  const stats = [
    ['commit','提交总数',compact(s.commits),`${number(s.merges)} 次合并提交`,'',s.commits],
    ['plus','新增代码行',compact(s.additions),'所有文本文件的新增行','green',s.additions],
    ['minus','删除代码行',compact(s.deletions),'每一次删减，也是进步','orange',s.deletions],
    ['code','累计净变更',signed(s.net),'新增 − 删除 · 非当前总行数',s.net < 0 ? 'orange' : 'green',s.net],
    ['calendar','投入的日子',compact(s.activeDays),`跨越 ${number(s.spanDays)} 个自然日`,'',s.activeDays],
    ['users','留下足迹的人',compact(s.authors),'按提交作者邮箱去重','',s.authors],
  ];
  $('#stat-grid').innerHTML = stats.map(([i,label,value,sub,color,raw]) => `<article class="stat-card"><div class="stat-label">${icon(i)}${label}</div><div class="stat-value ${color}" title="${number(raw)}">${value}</div><div class="stat-sub">${sub}</div></article>`).join('');
}
function renderMilestones() {
  const d = state.data, s = d.summary;
  if (!s.commits) { $('#milestones').innerHTML = '<div class="empty-state">故事，等待第一笔。</div>'; $('#journey-caption').textContent = '试试其他分支或日期范围。'; return; }
  const milestones = [
    [d.firstCommit.date.slice(0,10),'第一颗种子',esc(d.firstCommit.subject)],
    [s.peakDay.day,'最投入的一天',`留下 <b>${number(s.peakDay.commits)}</b> 次提交，灵感在生长。`],
    [d.largestCommit.date.slice(0,10),'一次大步向前',`<b>+${number(d.largestCommit.additions)}</b> / <span class="change-del">−${number(d.largestCommit.deletions)}</span> 行文本变更`],
    [s.last,'最近的落笔',esc(d.recent[0]?.subject || '')],
  ];
  $('#milestones').innerHTML = milestones.map(([day,title,body]) => `<div class="milestone"><time>${dotted(day)}</time><h3>${title}</h3><p>${body}</p></div>`).join('');
  $('#journey-caption').textContent = `${number(s.spanDays)} 天的跨度，${number(s.commits)} 个微小而具体的瞬间。`;
}
function heatLevel(count, max) { return !count ? 0 : Math.min(4, Math.max(1, Math.ceil(Math.sqrt(count / Math.max(1,max)) * 4))); }
function renderCalendar() {
  const daily = state.data.daily, map = new Map(daily.map(d => [d.day,d]));
  const yearSet = new Set(daily.map(d => +d.day.slice(0,4)));
  if (state.data.scope.first) { yearSet.add(+state.data.scope.first.slice(0,4)); yearSet.add(+state.data.scope.last.slice(0,4)); }
  if (!yearSet.size) yearSet.add(new Date().getFullYear());
  if (state.year) yearSet.add(+state.year);
  const years = [...yearSet].sort((a,b) => b-a);
  if (!state.year) state.year = years[0];
  $('#calendar-year').innerHTML = years.map(year => `<option value="${year}">${year}</option>`).join(''); $('#calendar-year').value = state.year;
  const items = daily.filter(d => +d.day.slice(0,4) === +state.year), max = Math.max(1,...items.map(d => d.commits));
  const first = Date.UTC(state.year,0,1), last = Date.UTC(state.year,11,31), offset = (new Date(first).getUTCDay()+6)%7;
  const start = first-offset*dayMs, weeks = Math.ceil(((last-first)/dayMs+1+offset)/7);
  const labels = ['','一','','三','','五','','日'];
  let html = labels.map(l => `<span class="calendar-label">${l}</span>`).join('');
  const today = localToday();
  for (let week=0;week<weeks;week++) {
    let month = '';
    for (let day=0;day<7;day++) { const dt = new Date(start+(week*7+day)*dayMs); if (dt.getUTCFullYear()===+state.year && (dt.getUTCDate()===1 || (week===0 && dt.getUTCDate()===2))) { month = (dt.getUTCMonth()+1)+'月'; break; } }
    html += `<span class="calendar-month">${month}</span>`;
    for (let day=0;day<7;day++) {
      const time = start+(week*7+day)*dayMs, value = toDay(time);
      if (time<first || time>last) { html += '<span class="calendar-cell empty"></span>'; continue; }
      const item = map.get(value), count = item?.commits || 0;
      const description = `${dotted(value)} · ${number(count)} 次提交${item ? ` · +${number(item.additions)} / −${number(item.deletions)} 行` : ''}`;
      html += `<button class="calendar-cell level${heatLevel(count,max)}${value > today ? ' future' : ''}${state.from===value && state.to===value ? ' filtered' : ''}" data-day="${value}" data-tip="${esc(description)}" aria-label="${esc(description)}"></button>`;
    }
  }
  $('#calendar').style.gridTemplateColumns = `22px repeat(${weeks},minmax(9px,1fr))`; $('#calendar').innerHTML = html;
  let streak=0,longest=0,previous=null;
  for(const item of items){const time=toTime(item.day);streak=previous!==null&&time-previous===dayMs?streak+1:1;longest=Math.max(longest,streak);previous=time;}
  $('#calendar-days').textContent = number(items.length); $('#calendar-streak').textContent = number(longest);
  $('#calendar-caption').textContent = ` / ${state.year}`;
}
function renderLanguages() {
  const languages = state.data.languages.filter(l => l.additions+l.deletions>0), total = languages.reduce((a,l) => a+l.additions+l.deletions,0);
  if (!total) { $('#languages').innerHTML = '<div class="empty-state">这个范围内没有文本行变更。</div>'; return; }
  const color = (l,i) => languageColors[l.name] || colors[i%colors.length];
  const maxLanguages = languages.slice(0,8);
  $('#languages').innerHTML = `<div class="language-stack">${languages.map((l,i) => `<i style="width:${(l.additions+l.deletions)/total*100}%;background:${color(l,i)}" data-tip="${esc(l.name)} · ${number(l.additions+l.deletions)} 行变更"></i>`).join('')}</div><div class="language-rows">${maxLanguages.map((l,i) => `<div class="language-row"><i style="background:${color(l,i)}"></i><span>${esc(l.name)}</span><b>${((l.additions+l.deletions)/total*100).toFixed(1)}%</b><small>+${number(l.additions)} / −${number(l.deletions)} 行</small></div>`).join('')}</div>`;
}
function avatar(name, email='') {
  let hash = 0; for (const c of email || name) hash = (hash*31+c.charCodeAt(0))|0;
  const color = colors[Math.abs(hash)%colors.length];
  const initials = name.trim().split(/\s+/).map(w => [...w][0]).slice(0,2).join('').toUpperCase() || '?';
  return `<span class="avatar" style="color:${color};background:${color}13">${esc(initials)}</span>`;
}
function renderAuthors() {
  const authors = state.data.authors, max = authors[0]?.commits || 1;
  $('#authors-count').textContent = state.data.summary.authors ? `${number(state.data.summary.authors)} 位贡献者` : '';
  $('#authors').innerHTML = authors.length ? `<div class="author-list">${authors.slice(0,4).map(a => `<button class="author-row" data-author="${esc(a.email)}" title="查看 ${esc(a.name)} 的提交">${avatar(a.name,a.email)}<span class="author-meta"><strong>${esc(a.name)}</strong><span class="author-track"><i style="width:${a.commits/max*100}%"></i></span></span><span class="author-number">${number(a.commits)}<small>commits</small></span></button>`).join('')}${state.data.summary.authors>4 ? `<p class="author-extra">还有 ${number(state.data.summary.authors-4)} 位作者。提交长卷中可查看与筛选全部作者。</p>` : ''}</div>` : '<div class="empty-state">等待有人留下第一行。</div>';
}
function changeCount(c) { return `<span class="change-count"><span class="change-add">+${compact(c.additions)}</span><span class="change-del">−${compact(c.deletions)}</span></span>`; }
function renderRecent() {
  $('#recent-commits').innerHTML = state.data.recent.length ? state.data.recent.map(c => `<button class="recent-row" data-hash="${c.hash}"><span class="recent-dot"></span><span class="recent-subject"><strong>${esc(c.subject || '(无提交说明)')}</strong><small>${c.hash.slice(0,7)} <span>·</span> ${esc(c.author)}</small></span><span class="recent-date">${dotted(c.day)}</span>${changeCount(c)}</button>`).join('') : '<div class="empty-state">这个筛选范围没有提交。试试放宽条件。</div>';
}
function renderRhythm() {
  const hours = state.data.hours, max = Math.max(1,...hours.map(h => h.commits));
  const hourMap = new Map(hours.map(h => [`${h.weekday}-${h.hour}`,h.commits]));
  const weekdays = ['一','二','三','四','五','六','日'], totals = Array(7).fill(0), byHour = Array(24).fill(0);
  let grid = '<span></span>' + Array.from({length:24},(_,h) => `<span class="hour-label">${h%3===0 ? String(h).padStart(2,'0') : ''}</span>`).join('');
  weekdays.forEach((day,w) => { grid += `<span class="hour-day-label">周${day}</span>`; for(let h=0;h<24;h++) { const count=hourMap.get(`${w}-${h}`)||0; totals[w]+=count; byHour[h]+=count; grid+=`<div class="hour-cell level${heatLevel(count,max)}" data-tip="周${day} ${String(h).padStart(2,'0')}:00–${String(h).padStart(2,'0')}:59 · ${number(count)} 次提交" role="img" aria-label="周${day} ${h} 点 ${number(count)} 次提交"></div>`; } });
  $('#hours-grid').innerHTML = grid;
  const peakHour = byHour.indexOf(Math.max(...byHour)), peakWeek = totals.indexOf(Math.max(...totals)), commits = state.data.summary.commits;
  const night = byHour.reduce((s,n,h) => s+(h>=22 || h<6 ? n : 0),0);
  $('#hours-summary').innerHTML = commits ? `<span>灵感高峰 <b>${String(peakHour).padStart(2,'0')}:00</b></span><span>最常出现 <b>周${weekdays[peakWeek]}</b></span><span>深夜提交 <b>${(night/commits*100).toFixed(1)}%</b></span>` : '这个范围还没有可观察的开发节律。';
  const maxWeek = Math.max(1,...totals);
  $('#weekday-bars').innerHTML = totals.map((n,w) => `<div class="weekday-row"><span>周${weekdays[w]}</span><div><i style="width:${n/maxWeek*100}%"></i></div><b>${compact(n)}</b></div>`).join('');
  const months = new Map();
  for (const item of state.data.daily) { const month = item.day.slice(0,7), value = months.get(month)||{commits:0,additions:0,deletions:0}; for(const key of ['commits','additions','deletions']) value[key]+=item[key]; months.set(month,value); }
  const keys = [...months.keys()];
  if (keys.length) {
    const first = new Date(keys[0]+'-01T00:00:00Z'), last = new Date(keys.at(-1)+'-01T00:00:00Z');
    for (const d = new Date(first); d<=last; d.setUTCMonth(d.getUTCMonth()+1)) { const key=d.toISOString().slice(0,7); if(!months.has(key)) months.set(key,{commits:0,additions:0,deletions:0}); }
  }
  const monthList = [...months].sort(([a],[b]) => a.localeCompare(b)), maxMonth = Math.max(1,...monthList.map(([,v])=>v.commits));
  $('#monthly-bars').style.minWidth = Math.max(550,monthList.length*38)+'px';
  $('#monthly-bars').innerHTML = monthList.length ? monthList.map(([month,n]) => `<button class="month-bar" data-month="${month}" data-tip="${month} · ${number(n.commits)} 次提交 · +${number(n.additions)} / −${number(n.deletions)} 行" aria-label="查看 ${month} 的提交"><span class="month-value">${compact(n.commits)}</span><span class="bar" style="height:${n.commits/maxMonth*145}px"></span><span class="month-name">${month.slice(2).replace('-','.')}</span></button>`).join('') : '<div class="empty-state">还没有月份可以回顾。</div>';
  const s = state.data.summary;
  $('#rhythm-facts').innerHTML = `<article class="rhythm-fact"><span>最长连续投入</span><strong>${number(s.longestStreak)}<small>天</small></strong><p>把一个想法，连续多天放在心上。</p></article><article class="rhythm-fact"><span>最长一段留白</span><strong>${number(s.longestBreak)}<small>天</small></strong><p>两次活跃日期之间，也有生活在发生。</p></article><article class="rhythm-fact"><span>每个活跃日，平均</span><strong>${s.activeDays ? (s.commits/s.activeDays).toFixed(1) : '0'}<small>次提交</small></strong><p>这些数字记录节律，并不衡量投入的价值。</p></article>`;
}

function buildSeries() {
  const daily = state.data?.daily || []; if (!daily.length) return [];
  const span=(toTime(daily.at(-1).day)-toTime(daily[0].day))/dayMs;
  let grain = state.grain==='auto' ? (span>3650 ? 'year' : span>900 ? 'month' : span>150 ? 'week' : 'day') : state.grain;
  const keyFor = value => { if(grain==='month') return value.slice(0,7)+'-01'; if(grain==='year') return value.slice(0,4)+'-01-01'; if(grain==='week') { const t=toTime(value), weekday=(new Date(t).getUTCDay()+6)%7; return toDay(t-weekday*dayMs); } return value; };
  const buckets = new Map();
  for(const item of daily) { const key=keyFor(item.day), bucket=buckets.get(key)||{day:key,commits:0,additions:0,deletions:0,lastDay:item.day}; for(const metric of ['commits','additions','deletions']) bucket[metric]+=item[metric]; bucket.lastDay=item.day; buckets.set(key,bucket); }
  const start=keyFor(daily[0].day), end=keyFor(daily.at(-1).day);
  for(let d=new Date(toTime(start));d<=new Date(toTime(end));) { const key=toDay(d.getTime()); if(!buckets.has(key)) buckets.set(key,{day:key,lastDay:key,commits:0,additions:0,deletions:0}); if(grain==='year') d.setUTCFullYear(d.getUTCFullYear()+1); else if(grain==='month') d.setUTCMonth(d.getUTCMonth()+1); else d.setUTCDate(d.getUTCDate()+(grain==='week'?7:1)); }
  let net=0, total=0;
  const series=[...buckets.values()].sort((a,b)=>a.day.localeCompare(b.day)).map(item=>{net+=item.additions-item.deletions;total+=item.commits;return {...item,net,total,time:toTime(item.day)};});
  $('#chart-granularity').textContent = ({day:'按日聚合',week:'按周聚合',month:'按月聚合',year:'按年聚合'})[grain];
  return series;
}
function traceCurve(ctx, points) {
  if(!points.length)return;
  ctx.moveTo(points[0].x,points[0].y);
  for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],middle=(a.x+b.x)/2;ctx.bezierCurveTo(middle,a.y,middle,b.y,b.x,b.y);}
}
function drawGrowth(forExport = false) {
  const canvas=$('#growth-chart'), rect=canvas.getBoundingClientRect(); if((!rect.width && !forExport) || !state.data)return;
  const dpr=Math.min(window.devicePixelRatio||1,2), width=rect.width || 900, height=rect.height || 270;
  canvas.width=Math.round(width*dpr); canvas.height=Math.round(height*dpr);
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const css=getComputedStyle(document.documentElement), color=name=>css.getPropertyValue(name).trim();
  const series=state.series, left=48,right=14,top=18,bottom=height*.65,barTop=height*.72,baseline=height*.815,barBottom=height-28;
  const plotWidth=width-left-right;
  const first=series[0]?.time||0,last=series.at(-1)?.time||first+dayMs, minTime=first-(series.length===1?dayMs/2:0), maxTime=last+(series.length===1?dayMs/2:0);
  const x=t=>left+(t-minTime)/Math.max(dayMs/2,maxTime-minTime)*plotWidth;
  let min=Math.min(0,...series.map(d=>d.net)),max=Math.max(0,...series.map(d=>d.net));
  if(max===min)max=min+10;
  const extent=max-min,step=Math.pow(10,Math.floor(Math.log10(extent/3))),niceStep=[1,2,2.5,5,10].map(v=>v*step).find(v=>v>=extent/3)||step*10;
  min=Math.floor(min/niceStep)*niceStep;max=Math.ceil(max/niceStep)*niceStep;
  const y=value=>bottom-(value-min)/(max-min)*(bottom-top);
  ctx.font='9px Consolas, monospace';ctx.textAlign='right';ctx.textBaseline='middle';
  for(let value=min;value<=max+niceStep/10;value+=niceStep){const py=y(value);ctx.beginPath();ctx.strokeStyle=color('--line-soft');ctx.lineWidth=1;ctx.setLineDash([3,5]);ctx.moveTo(left,py);ctx.lineTo(width-right,py);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=color('--faint');ctx.fillText(Math.abs(value)>=1000?(value/1000).toFixed(Math.abs(value)>=10000?0:1)+'k':String(Math.round(value)),left-10,py);}
  const cutoff=series.length ? Math.round(state.replay/1000*(series.length-1)) : -1, visible=series.slice(0,cutoff+1);
  const points=visible.map(d=>({x:x(d.time),y:y(d.net)}));
  if(points.length){
    ctx.beginPath();traceCurve(ctx,points);ctx.lineTo(points.at(-1).x,y(0));ctx.lineTo(points[0].x,y(0));ctx.closePath();
    const gradient=ctx.createLinearGradient(0,top,0,bottom);gradient.addColorStop(0,color('--accent-strong')+'35');gradient.addColorStop(1,color('--accent-strong')+'02');ctx.fillStyle=gradient;ctx.fill();
    ctx.beginPath();traceCurve(ctx,points);ctx.lineWidth=2;ctx.strokeStyle=color('--accent-strong');ctx.stroke();
    const end=points.at(-1);ctx.beginPath();ctx.arc(end.x,end.y,3,0,Math.PI*2);ctx.fillStyle=color('--accent-text');ctx.fill();ctx.beginPath();ctx.arc(end.x,end.y,6,0,Math.PI*2);ctx.fillStyle=color('--accent-strong')+'20';ctx.fill();
  }
  ctx.beginPath();ctx.moveTo(left,baseline);ctx.lineTo(width-right,baseline);ctx.strokeStyle=color('--line');ctx.lineWidth=1;ctx.stroke();
  const barMax=Math.max(1,...series.map(d=>Math.max(d.additions,d.deletions))),barHeight=Math.min(baseline-barTop,barBottom-baseline),barWidth=Math.max(1,Math.min(10,plotWidth/Math.max(1,series.length)*.62));
  for(const d of visible){const px=x(d.time)-barWidth/2;ctx.fillStyle=color('--accent-strong')+'a0';ctx.fillRect(px,baseline-d.additions/barMax*barHeight,barWidth,Math.max(d.additions?1:0,d.additions/barMax*barHeight));ctx.fillStyle=color('--orange')+'ad';ctx.fillRect(px,baseline+1,barWidth,Math.max(d.deletions?1:0,d.deletions/barMax*barHeight));}
  ctx.fillStyle=color('--faint');ctx.textAlign='right';ctx.font='7px "Segoe UI", sans-serif';ctx.fillText('增 / 删',left-10,baseline);
  const labelCount=Math.min(series.length,Math.max(2,Math.floor(plotWidth/95)));
  for(let i=0;i<labelCount;i++){const index=Math.round(i*(series.length-1)/Math.max(1,labelCount-1)),item=series[index];ctx.font='8px Consolas, monospace';ctx.textAlign=i===0?'left':i===labelCount-1?'right':'center';ctx.fillStyle=color('--faint');const span=(last-first)/dayMs;ctx.fillText(span>250?item.day.slice(0,7).replace('-','.'):item.day.slice(5).replace('-','.'),x(item.time),height-11);}
  if(state.hovered>=0 && state.hovered<=cutoff && series[state.hovered]){
    const d=series[state.hovered],px=x(d.time),py=y(d.net);ctx.beginPath();ctx.setLineDash([3,3]);ctx.moveTo(px,top);ctx.lineTo(px,barBottom);ctx.strokeStyle=color('--faint');ctx.lineWidth=1;ctx.stroke();ctx.setLineDash([]);ctx.beginPath();ctx.arc(px,py,4,0,Math.PI*2);ctx.fillStyle=color('--panel');ctx.fill();ctx.strokeStyle=color('--accent-text');ctx.stroke();
  }
  if(state.drag){const a=Math.min(state.drag.start,state.drag.current),b=Math.max(state.drag.start,state.drag.current);ctx.fillStyle=color('--accent-strong')+'25';ctx.fillRect(a,top,b-a,barBottom-top);ctx.strokeStyle=color('--accent-strong');ctx.lineWidth=1;ctx.strokeRect(a,top,b-a,barBottom-top);}
  const current=visible.at(-1);$('#chart-net').textContent=signed(current?.net||0);$('#growth-empty').classList.toggle('hidden',!!series.length);
  $('#replay-title').textContent=state.replay<1000?'回到 '+dotted(current?.lastDay):'重播这段历程';
  $('#replay-date').textContent=state.replay<1000?`已留下 ${number(current?.total||0)} 次提交`:'从第一行，到此刻。';
  $('#replay-end').textContent=dotted(state.data.summary.last).slice(2);
  state.chart={left,right,top,bottom,width,height,minTime,maxTime,x,y,cutoff};
}
function showChartTooltip(event) {
  if(!state.chart || !state.series.length)return;
  const rect=$('#growth-chart').getBoundingClientRect(),px=event.clientX-rect.left;
  const chart=state.chart,t=chart.minTime+(px-chart.left)/(chart.width-chart.left-chart.right)*(chart.maxTime-chart.minTime);
  let lo=0,hi=state.series.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(state.series[mid].time<t)lo=mid+1;else hi=mid;}
  let index=lo;if(index>0 && Math.abs(state.series[index-1].time-t)<Math.abs(state.series[index].time-t))index--;
  if(px<chart.left || px>chart.width-chart.right || index>chart.cutoff){hideChartTooltip();return;}
  state.hovered=index;const item=state.series[index],tip=$('#growth-tooltip');
  tip.innerHTML=`<b>${dotted(item.day)}${item.lastDay!==item.day?' — '+dotted(item.lastDay).slice(5):''}</b>累计净变更 <span>${signed(item.net)}</span><br>新增 <span class="change-add">+${number(item.additions)}</span><br>删除 <span class="change-del">−${number(item.deletions)}</span><br>提交 <span>${number(item.commits)}</span>`;
  tip.classList.remove('hidden');tip.style.left=Math.max(5,Math.min(px+14,chart.width-tip.offsetWidth-6))+'px';tip.style.top=Math.max(3,Math.min(event.clientY-rect.top-tip.offsetHeight/2,chart.height-tip.offsetHeight-3))+'px';drawGrowth();
}
function hideChartTooltip(){state.hovered=-1;$('#growth-tooltip').classList.add('hidden');drawGrowth();}
function pauseReplay(reset=false){state.playing=false;$('#replay-play').innerHTML=icon('play');$('#replay-play').setAttribute('aria-label','播放开发历程');if(reset){state.replay=1000;$('#replay-slider').value=1000;}}
function toggleReplay(){
  if(!state.series.length){toast('这个范围还没有可播放的提交。');return;}
  if(state.playing){pauseReplay();return;}
  if(state.replay>=1000)state.replay=0;
  state.playing=true;$('#replay-play').innerHTML=icon('pause');$('#replay-play').setAttribute('aria-label','暂停开发历程');
  let last=performance.now(),lastDraw=0;
  function frame(now){if(!state.playing)return;const delta=now-last;last=now;state.replay=Math.min(1000,state.replay+delta/20*state.speed);if(now-lastDraw>65 || state.replay===1000){lastDraw=now;$('#replay-slider').value=state.replay;drawGrowth();}if(state.replay>=1000)pauseReplay();else requestAnimationFrame(frame);}
  requestAnimationFrame(frame);
}

function setView(view){
  if(!['overview','history','rhythm'].includes(view))view='overview';const changed=state.view!==view;state.view=view;
  for(const name of ['overview','history','rhythm'])$('#'+name+'-view').classList.toggle('hidden',name!==view);
  $$('.nav-item').forEach(b=>{b.classList.toggle('active',b.dataset.view===view);if(b.dataset.view===view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  const titles={overview:['每一行，都有来处','在代码的年轮里，重逢每一个创造的瞬间。'],history:['把时间，慢慢展开','那些细小的修改，最终成了今天的模样。'],rhythm:['创造，自有它的节律','不只有代码的数量，还有你投入的时间与心情。']};
  $('#page-title').innerHTML=titles[view][0]+'<span class="heading-dot">.</span>';$('#page-subtitle').textContent=titles[view][1];
  history.replaceState(null,'','#'+view);
  if(changed)window.scrollTo({top:0});
  if(view==='overview')requestAnimationFrame(drawGrowth);else if(view==='history' && state.job && state.data)loadCommits();
}
async function loadCommits(){
  if(!state.job)return;
  const seq=++state.listSeq;state.listController?.abort();state.listController=new AbortController();
  $('#commit-list').setAttribute('aria-busy','true');$('#previous-page').disabled=$('#next-page').disabled=true;
  try {
    const result=await api('/api/commits?'+queryString({offset:state.offset,limit:state.pageSize,order:state.order}),undefined,{signal:state.listController.signal});
    if(seq!==state.listSeq)return;
    state.total=result.total;
    $('#commit-list').innerHTML=result.commits.length?result.commits.map(c=>`<button class="commit-row" data-hash="${c.hash}"><div><strong title="${esc(c.subject)}">${esc(c.subject||'(无提交说明)')}</strong><span class="commit-hash">${c.hash.slice(0,8)}</span>${c.is_merge?'<small class="commit-type">merge</small>':''}</div><span class="commit-author">${avatar(c.author,c.email)}<span title="${esc(c.email)}">${esc(c.author)}</span></span><time class="commit-time">${dotted(c.day)}<small>${esc(c.date.slice(11,16))} ${esc(c.date.slice(19))}</small></time>${changeCount(c)}${icon('arrow')}</button>`).join(''):`<div class="empty-state">${icon('search')}没有找到符合条件的提交。<br>试试缩短关键词、切换作者或清除日期筛选。</div>`;
    $('#history-total').textContent=`${state.q||state.author||state.from||state.to?'筛选结果':'这段历史'} · ${number(result.total)} 次提交`;
    $('#page-description').textContent=result.total?`第 ${number(result.offset+1)}–${number(Math.min(result.offset+result.limit,result.total))} 条 · 每页 ${result.limit} 条`:'0 条提交';
    $('#page-number').textContent=`${result.total?Math.floor(result.offset/result.limit)+1:0} / ${Math.ceil(result.total/result.limit)}`;
    $('#previous-page').disabled=state.offset===0;$('#next-page').disabled=state.offset+state.pageSize>=result.total;
  }catch(error){if(error.name!=='AbortError')toast(error.message,true);}finally{if(seq===state.listSeq)$('#commit-list').removeAttribute('aria-busy');}
}
async function showCommit(sha){
  if(!state.job)return;const seq=++state.detailSeq,dialog=$('#commit-dialog');
  $('#commit-detail').innerHTML='<div class="empty-state">正在回到那个瞬间…</div>';if(!dialog.open)dialog.showModal();
  try {
    const c=await api('/api/commit?'+queryString({hash:sha}));if(seq!==state.detailSeq)return;
    $('#commit-detail').innerHTML=`<div class="eyebrow detail-eyebrow">${icon('commit')} A MOMENT IN YOUR HISTORY ${state.repo.demo?'· 演示数据':''}</div><h2 class="detail-subject">${esc(c.subject||'(无提交说明)')}</h2><div class="detail-hash">${c.hash}<button class="icon-button" data-copy="${c.hash}" aria-label="复制完整提交 ID">${icon('copy')}</button></div><div class="detail-meta">${avatar(c.author,c.email)}<div>${esc(c.author)}<small>${esc(c.email)}</small></div><time>${esc(c.date.replace('T',' '))}</time></div><div class="detail-changes"><span class="change-add">+${number(c.additions)}</span><span class="change-del">−${number(c.deletions)}</span><small>${number(c.files)} 个文件${c.binary?` · ${number(c.binary)} 个二进制文件`:''}</small></div><pre class="detail-message">${esc(c.message)}</pre>${c.is_merge&&!state.mainline?'<p class="detail-note">这是一次合并提交。当前完整历史模式保留记录，不重复累加合入的文件变更。</p>':''}<div class="detail-files-title"><span>这次修改，落在了这些地方</span><span>${number(c.changedFiles.length)} 个文件</span></div>${c.changedFiles.length?`<div class="detail-files">${c.changedFiles.map(f=>`<div class="detail-file"><span>${esc(f.path)}</span>${f.binary?'<small class="detail-note">binary</small>':changeCount(f)}</div>`).join('')}</div>`:'<p class="detail-note">没有计入文本变更的文件。</p>'}${c.filesTruncated?'<p class="detail-note">文件过多，此处展示前 3,000 个文件。</p>':''}<p class="detail-parent">PARENT ${esc(c.parents||'初始提交 · 没有父提交')}</p>`;
  }catch(error){if(seq===state.detailSeq)$('#commit-detail').innerHTML=`<div class="empty-state">${esc(error.message)}</div>`;}
}
function applyDateRange(from,to,preset='custom'){
  if(from&&to&&from>to){toast('开始日期不能晚于结束日期。',true);return;}
  state.from=from;state.to=to;state.preset=from||to?preset:'all';state.offset=0;$('#date-popover').classList.add('hidden');loadData();
}
function resetFilters(){state.from=state.to=state.q=state.author='';state.preset='all';state.offset=0;$('#history-search').value='';$('#author-filter').value='';loadData();}
function openDialog(){renderRecentRepositories();$('#open-error').classList.add('hidden');$('#open-dialog').showModal();setTimeout(()=>$('#repo-path').focus(),30);}
function renderRecentRepositories(){
  $('#recent-repositories').classList.toggle('hidden',!state.recent.length);
  $('#recent-repository-list').innerHTML=state.recent.slice(0,4).map(r=>`<button type="button" class="recent-repository" data-repo-path="${esc(r.path)}">${icon('folder')}<div><strong>${esc(r.name)}</strong><small>${esc(r.path)}</small></div>${icon('arrow')}</button>`).join('');
}
function download(blob,filename){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
async function exportCSV(){
  if(!state.job)return;$('#export-menu').classList.add('hidden');toast('正在准备这段历史的 CSV…');
  try{const response=await fetch('/api/export?'+queryString(),{headers:{'X-Git-Atlas':token}});if(!response.ok)throw new Error('导出失败，请稍后重试。');download(await response.blob(),`git-atlas-${state.repo.name.replace(/[^\w\-\u4e00-\u9fff]/g,'_')}-${localToday()}.csv`);toast('CSV 已导出，包含当前筛选的全部提交。');}catch(error){toast(error.message,true);}
}
async function exportHTML(){
  if(!state.data)return;if(state.dataPending){toast('正在更新筛选结果，请稍后再导出。');return;}$('#export-menu').classList.add('hidden');pauseReplay(true);drawGrowth(true);
  try {
    const css=await (await fetch('/style.css')).text();
    const theme=document.documentElement.dataset.theme,repo=esc(state.repo.name),s=state.data.summary;
    const staticHTML=selector=>$(selector).innerHTML.replace(/<button\b/g,'<div').replace(/<\/button>/g,'</div>');
    const filterLabel=[state.from||state.to?`${state.from||'起点'} → ${state.to||'最近'}`:'全部历程',state.author?`作者：${state.author}`:'',state.q?`搜索：${state.q}`:''].filter(Boolean).join(' · ');
    const report=`<!doctype html><html lang="zh-CN" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${repo} · 开发历程</title><style>${css}\nbody{margin:0}.report{max-width:1180px;margin:auto;padding:45px 32px}.report .panel{margin-bottom:20px}.report .stat-grid{margin-top:26px}.report h1{font-size:34px}.report .report-meta{font-size:11px;color:var(--muted);line-height:2}.report .calendar{min-width:790px}.report-chart{width:100%;height:auto;display:block}.report .lower-grid{align-items:start}.report .lower-grid>.panel{height:100%;margin:0}.report .author-row{cursor:default}.report-footer{font-size:10px;color:var(--muted);line-height:2;border-top:1px solid var(--line);padding-top:24px}.report .milestones{display:grid;grid-template-columns:repeat(4,1fr);gap:20px}.report .milestone:after{display:none}.report .hours-grid{margin:24px}.report .monthly-bars{margin:20px}.report .calendar-footer{display:block}.report .commit-row{cursor:default}@media(max-width:650px){.report{padding:25px 18px}.report .lower-grid{grid-template-columns:1fr}.report .milestones{grid-template-columns:1fr 1fr}.report h1{font-size:25px}}@media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact}.report{padding:0}.panel,.stat-grid{break-inside:avoid}.report-chart{max-height:280px;object-fit:contain}}</style></head><body><article class="report"><div class="eyebrow">GIT ATLAS · A LITTLE HISTORY. A LOT OF BUILDING.</div><h1>${repo}，一路走来<span class="heading-dot">.</span></h1><div class="report-meta">${state.repo.demo?'<b>演示数据 · 以下为虚构的演示开发历程</b><br>':''}${state.repo.shallow?'浅克隆 · 仅包含本地已有历史<br>':''}分支：${esc($('#scope-name').textContent)} · ${state.mainline?'仅第一父链':'完整可达历史'}<br>${esc(filterLabel)}<br>${dotted(s.first)} — ${dotted(s.last)} · 导出于 ${esc(new Date().toLocaleString('zh-CN'))}</div><div class="stat-grid">${$('#stat-grid').innerHTML}</div><section class="panel"><div class="panel-heading"><div><div class="section-eyebrow">LINES OVER TIME</div><h2>代码生长的形状 · 累计净变更 ${signed(s.net)} 行</h2></div></div><img class="report-chart" alt="代码净变更和文本增删趋势" src="${$('#growth-chart').toDataURL('image/png')}"><div class="chart-footer">绿色曲线：累计净变更 · 绿色柱：新增 · 橙色柱：删除 · ${$('#chart-granularity').textContent}</div></section><section class="panel"><div class="panel-heading"><h2>旅程中的刻度</h2></div><div class="milestones">${$('#milestones').innerHTML}</div></section><section class="panel"><div class="panel-heading"><h2>那些写下代码的日子 · ${state.year}</h2></div><div class="calendar-scroll"><div class="calendar" style="${esc($('#calendar').getAttribute('style'))}">${staticHTML('#calendar')}</div></div><div class="calendar-footer">${esc($('#calendar-days').textContent)} 个该年活跃日 · ${esc($('#calendar-streak').textContent)} 天该年最长连续 · 日期按作者原始时区</div></section><div class="lower-grid"><section class="panel"><div class="panel-heading"><h2>构建这一切的语言 · 按文本增删量</h2></div>${staticHTML('#languages')}</section><section class="panel"><div class="panel-heading"><h2>一起走过的人</h2></div>${staticHTML('#authors')}</section></div><section class="panel"><div class="panel-heading"><h2>你的创造时区</h2></div><div class="hours-scroll"><div class="hours-grid">${$('#hours-grid').innerHTML}</div></div><div class="hours-summary">${$('#hours-summary').innerHTML}</div></section><section class="panel"><div class="panel-heading"><h2>最近留下的足迹</h2></div><div style="padding:10px 23px">${staticHTML('#recent-commits')}</div></section><footer class="report-footer">这份报告由本地 Git Atlas 生成，包含当前筛选的统计和当前选中的活动日历年份。<br>文本增删基于 Git numstat，包含代码、文档、配置、锁文件与已提交的生成文件；二进制不计行数；重命名按删除和新增处理。<br>累计净变更 = 新增 − 删除，不等于当前代码总行数。${state.mainline?'第一父链模式包含合并相对第一父提交的变更。':'完整历史模式保留合并提交记录，不重复累加其文件增删。'}<br>所有分支取本地分支、远程跟踪分支和 HEAD 的可达提交并集。日期按 Git 作者原始时区。实际工作时长无法从提交记录推算。<br>git atlas · 留下代码，也留下时间。</footer></article></body></html>`;
    download(new Blob([report],{type:'text/html;charset=utf-8'}),`git-atlas-${state.repo.name.replace(/[^\w\-\u4e00-\u9fff]/g,'_')}-${localToday()}.html`);toast('可视化报告已保存，可独立离线打开。');
  }catch(error){toast('报告导出失败：'+error.message,true);}
}

// Events
$$('.nav-item').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.view)));
$('#open-button').addEventListener('click',openDialog);$('#repo-card').addEventListener('click',openDialog);
$('#open-form').addEventListener('submit',event=>{event.preventDefault();openRepository($('#repo-path').value);});
$('#demo-button').addEventListener('click',()=>openRepository('',true));
$('#browse-button').addEventListener('click',async()=>{const button=$('#browse-button');button.disabled=true;try{const result=await api('/api/browse',{});if(result.path)$('#repo-path').value=result.path;}catch(error){$('#open-error').textContent=error.message;$('#open-error').classList.remove('hidden');}finally{button.disabled=false;}});
$$('[data-close]').forEach(button=>button.addEventListener('click',()=>$('#'+button.dataset.close).close()));
$$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}}));
for(const id of ['method-button','footer-method'])$('#'+id).addEventListener('click',()=>$('#method-dialog').showModal());
function selectBranch(event){state.branch=event.target.value;if(state.branch==='__all__')state.mainline=false;populateRepository();scanRepository();}
$('#branch-select').addEventListener('change',selectBranch);$('#mobile-branch-select').addEventListener('change',selectBranch);
$('#mainline').addEventListener('change',()=>{state.mainline=$('#mainline').checked;populateRepository();scanRepository();});
$('#refresh-button').addEventListener('click',refreshRepository);
$$('.range-segments button').forEach(button=>button.addEventListener('click',()=>{const range=button.dataset.range;if(range==='custom'){$('#date-popover').classList.toggle('hidden');return;}if(range==='all')applyDateRange('','','all');else{const today=localToday();applyDateRange(toDay(toTime(today)-(+range-1)*dayMs),today,range);}}));
$('#apply-dates').addEventListener('click',()=>applyDateRange($('#date-from').value,$('#date-to').value));$('#filter-reset').addEventListener('click',resetFilters);
$$('.chart-select button').forEach(button=>button.addEventListener('click',()=>{state.grain=button.dataset.grain;$$('.chart-select button').forEach(b=>b.classList.toggle('active',b===button));pauseReplay(true);state.series=buildSeries();drawGrowth();}));
$('#calendar-year').addEventListener('change',()=>{state.year=+$('#calendar-year').value;renderCalendar();});
$('#replay-play').addEventListener('click',toggleReplay);$('#replay-slider').addEventListener('input',()=>{pauseReplay();state.replay=+$('#replay-slider').value;state.hovered=-1;$('#growth-tooltip').classList.add('hidden');drawGrowth();});
$('#replay-speed').addEventListener('click',()=>{state.speed=state.speed===4?1:state.speed*2;$('#replay-speed').textContent=state.speed+'×';});
const canvas=$('#growth-chart');
canvas.addEventListener('pointermove',event=>{if(state.drag){const rect=canvas.getBoundingClientRect();state.drag.current=Math.min(state.chart.width-state.chart.right,Math.max(state.chart.left,event.clientX-rect.left));drawGrowth();}else showChartTooltip(event);});
canvas.addEventListener('pointerleave',()=>{if(!state.drag)hideChartTooltip();});
canvas.addEventListener('pointerdown',event=>{if(!state.series.length||event.button!==0)return;pauseReplay();const px=event.clientX-canvas.getBoundingClientRect().left;if(px<state.chart.left||px>state.chart.width-state.chart.right)return;state.drag={start:px,current:px};canvas.setPointerCapture(event.pointerId);$('#growth-tooltip').classList.add('hidden');});
canvas.addEventListener('pointerup',event=>{if(!state.drag)return;const drag=state.drag,chart=state.chart;state.drag=null;canvas.releasePointerCapture(event.pointerId);if(Math.abs(drag.current-drag.start)>10){const dateAt=x=>toDay(chart.minTime+(x-chart.left)/(chart.width-chart.left-chart.right)*(chart.maxTime-chart.minTime));applyDateRange(dateAt(Math.min(drag.start,drag.current)),dateAt(Math.max(drag.start,drag.current)));}else drawGrowth();});
canvas.addEventListener('pointercancel',()=>{state.drag=null;drawGrowth();});canvas.addEventListener('dblclick',()=>applyDateRange('','','all'));
$('#view-all-commits').addEventListener('click',()=>{setView('history');window.scrollTo({top:0,behavior:'smooth'});});
function focusSearch(){setView('history');requestAnimationFrame(()=>$('#history-search').focus());}
$('#search-trigger').addEventListener('click',focusSearch);document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();if(!$$('dialog').some(d=>d.open))focusSearch();}if(event.key==='Escape'){$('#export-menu').classList.add('hidden');$('#date-popover').classList.add('hidden');}});
$('#history-search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.q=$('#history-search').value.trim();state.offset=0;loadData();},260);});
$('#author-filter').addEventListener('change',()=>{state.author=$('#author-filter').value;state.offset=0;loadData();});
$('#sort-order').addEventListener('change',()=>{state.order=$('#sort-order').value;state.offset=0;loadCommits();});
$('#previous-page').addEventListener('click',()=>{state.offset=Math.max(0,state.offset-state.pageSize);loadCommits();$('.history-panel').scrollIntoView({behavior:'smooth',block:'start'});});
$('#next-page').addEventListener('click',()=>{state.offset+=state.pageSize;loadCommits();$('.history-panel').scrollIntoView({behavior:'smooth',block:'start'});});
$('#theme-toggle').addEventListener('click',()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';try{localStorage.setItem('git-atlas-theme',document.documentElement.dataset.theme);}catch{}drawGrowth();});
$('#export-button').addEventListener('click',()=>$('#export-menu').classList.toggle('hidden'));$('#export-html').addEventListener('click',exportHTML);$('#export-csv').addEventListener('click',exportCSV);
document.addEventListener('click',async event=>{
  const hash=event.target.closest('[data-hash]');if(hash)showCommit(hash.dataset.hash);
  const author=event.target.closest('[data-author]');if(author){state.author=author.dataset.author;state.offset=0;setView('history');loadData();window.scrollTo({top:0,behavior:'smooth'});}
  const day=event.target.closest('[data-day]');if(day){state.from=day.dataset.day;state.to=day.dataset.day;state.preset='custom';state.offset=0;setView('history');loadData();$('#heat-tooltip').classList.add('hidden');window.scrollTo({top:0,behavior:'smooth'});}
  const month=event.target.closest('[data-month]');if(month){const key=month.dataset.month,first=key+'-01',next=new Date(first+'T00:00:00Z');next.setUTCMonth(next.getUTCMonth()+1);applyDateRange(first,toDay(next.getTime()-dayMs));}
  const recent=event.target.closest('[data-repo-path]');if(recent){$('#repo-path').value=recent.dataset.repoPath;openRepository(recent.dataset.repoPath);}
  const copy=event.target.closest('[data-copy]');if(copy){try{await navigator.clipboard.writeText(copy.dataset.copy);toast('提交 ID 已复制。');}catch{toast('复制不可用，请选中提交 ID 手动复制。',true);}}
  const clear=event.target.closest('[data-clear-filter]');if(clear){state[clear.dataset.clearFilter]='';if(clear.dataset.clearFilter==='q')$('#history-search').value='';state.offset=0;loadData();}
  if(!event.target.closest('.export-wrap'))$('#export-menu').classList.add('hidden');
  if(!event.target.closest('#date-popover')&&!event.target.closest('#custom-range-button'))$('#date-popover').classList.add('hidden');
});
document.addEventListener('pointerover',event=>{const target=event.target.closest('[data-tip]');if(!target)return;const tip=$('#heat-tooltip'),r=target.getBoundingClientRect();tip.textContent=target.dataset.tip;tip.classList.remove('hidden');tip.style.left=Math.max(8,Math.min(r.left+r.width/2-tip.offsetWidth/2,window.innerWidth-tip.offsetWidth-8))+'px';tip.style.top=Math.max(8,r.top-tip.offsetHeight-8)+'px';});
document.addEventListener('pointerout',event=>{if(event.target.closest('[data-tip]'))$('#heat-tooltip').classList.add('hidden');});
window.addEventListener('scroll',()=>$('#heat-tooltip').classList.add('hidden'),{passive:true});
new ResizeObserver(()=>{if(state.view==='overview')drawGrowth();}).observe($('.growth-chart-wrap'));
window.addEventListener('hashchange',()=>setView(location.hash.slice(1)));

async function init(){
  try{const theme=localStorage.getItem('git-atlas-theme');if(['dark','light'].includes(theme))document.documentElement.dataset.theme=theme;}catch{}
  setView(location.hash.slice(1)||'overview');
  try{const session=await api('/api/session');state.recent=session.recent;renderRecentRepositories();if(session.startupRepo){state.repo=session.startupRepo;state.branch=state.repo.defaultBranch;populateRepository();await scanRepository();}else await openRepository('',true);}catch(error){setLoading(false);toast(error.message,true);}
}
init();
