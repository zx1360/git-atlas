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
  hovered:-1,drag:null,recent:[],analyticsController:null,listController:null,dataPending:false,successful:null,scopeData:null,inspector:null,context:null,selectedHash:null,inspectorOrigin:null,detailController:null,commitCache:new Map(),brush:null,calendarFocus:null,openSeq:0};
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
  state.loading=active;
  $('#loading-overlay').classList.toggle('hidden',!active);
  $('#refresh-button').disabled=active;
  $('#export-button').disabled=active||state.dataPending||!state.data;
  $$('#scope-bar input, #scope-bar select, #scope-bar button').forEach(control=>control.disabled=active);
  $('#mainline').disabled=active||state.branch==='__all__';
  $('#refresh-button svg').classList.toggle('spin',active);
  if(job){
    const percent=job.total?Math.min(99,Math.round(job.processed/job.total*100)):0;
    $('#loading-stage').textContent=job.stage||'读取提交';
    $('#loading-count').textContent=`${number(job.processed)}${job.total?' / '+number(job.total):''} 条提交`;
    $('#loading-percent').textContent=job.total?percent+'%':'…';
    $('#loading-progress').style.width=Math.max(3,percent)+'%';
  }
}
function populateRepository(){
  const repo=state.repo;
  $('#top-repo-name').textContent=repo.name;
  $('#repo-card').title=repo.path;
  $('#repo-card').setAttribute('aria-label','切换仓库：'+repo.name);
  $('#demo-badge').textContent=repo.demo?'演示':repo.shallow?'浅克隆':'';
  $('#demo-badge').classList.toggle('hidden',!repo.demo&&!repo.shallow);
  $('#open-button').classList.toggle('hidden',!repo.demo);
  const options=items=>items.map(b=>`<option value="${esc(b.ref)}">${esc(b.name)}${b.current?' · HEAD':''}</option>`).join('');
  const local=repo.branches.filter(b=>!b.remote),remote=repo.branches.filter(b=>b.remote);
  $('#branch-select').innerHTML=`<optgroup label="本地分支">${options(local)}</optgroup>${remote.length?`<optgroup label="远程跟踪分支">${options(remote)}</optgroup>`:''}<option value="__all__">所有分支</option>`;
  $('#branch-select').value=state.branch;
  $('#branch-select').title=branchName();
  $('.mainline-option').title=state.branch==='__all__'?'所有分支使用完整历史':'只沿第一父提交回溯，合并按相对第一父提交的变更计数';
  $('#mainline').checked=state.mainline;
  $('#mainline').disabled=state.loading||state.branch==='__all__';
  document.title=`${repo.name} · Git Atlas`;
}
function branchName(){return state.branch==='__all__'?'所有分支':state.repo?.branches.find(b=>b.ref===state.branch)?.name||'HEAD';}
function rememberRepository(){
  if(!state.repo)return;
  try{localStorage.setItem('git-atlas-last-repo',JSON.stringify({path:state.repo.path,demo:state.repo.demo,branch:state.branch,mainline:state.mainline}));}catch{}
}
async function openRepository(path,demo=false){
  const sequence=++state.openSeq;
  $('#open-submit').disabled=true;$('#demo-button').disabled=true;$('#open-error').classList.add('hidden');
  try{
    const repo=await api('/api/open',{path,demo});
    if(sequence!==state.openSeq)return false;
    state.repo=repo;state.branch=repo.defaultBranch;state.mainline=false;state.year=null;
    try{
      const saved=JSON.parse(localStorage.getItem('git-atlas-last-repo')||'null');
      if(saved&&saved.demo===repo.demo&&(demo||saved.path===repo.path)){
        if(saved.branch==='__all__'||repo.branches.some(b=>b.ref===saved.branch))state.branch=saved.branch;
        state.mainline=state.branch!=='__all__'&&!!saved.mainline;
      }
    }catch{}
    state.from=state.to=state.q=state.author='';state.preset='all';state.offset=0;
    $('#history-search').value='';$('#open-dialog').close();
    closeInspector(false);populateRepository();
    const ready=await scanRepository();
    if(!ready||sequence!==state.openSeq)return false;
    const session=await api('/api/session');state.recent=session.recent;renderRecentRepositories();
    return true;
  }catch(error){
    if(sequence!==state.openSeq)return false;
    if($('#open-dialog').open){$('#open-error').textContent=error.message;$('#open-error').classList.remove('hidden');}
    else toast(error.message,true);
    return false;
  }finally{if(sequence===state.openSeq){$('#open-submit').disabled=false;$('#demo-button').disabled=false;}}
}
async function scanRepository(refresh=false){
  pauseReplay(true);closeInspector(false);
  const seq=++state.scanSeq;++state.dataSeq;++state.listSeq;
  clearTimeout(searchTimer);state.analyticsController?.abort();state.listController?.abort();
  state.dataPending=false;window.scrollTo({top:0});closeDatePopover();
  setLoading(true,{processed:0,total:0,stage:'准备中'});
  try{
    let job=await api('/api/scan',{repo:state.repo.id,branch:state.branch,mainline:state.mainline,refresh});
    while(job.status==='loading'){
      if(seq!==state.scanSeq)return false;
      setLoading(true,job);await new Promise(resolve=>setTimeout(resolve,350));
      job=await api('/api/jobs/'+job.id);
    }
    if(seq!==state.scanSeq)return false;
    if(job.status==='error')throw new Error(job.error||'无法读取历史');
    state.job=job;state.repo=job.repo;state.mainline=job.mainline;state.offset=0;state.commitCache.clear();
    const full=api('/api/analytics?'+new URLSearchParams({job:job.id}));
    const filtered=state.from||state.to||state.q||state.author?api('/api/analytics?'+queryString()):full;
    const [scopeData,initialData]=await Promise.all([full,filtered]);
    if(seq!==state.scanSeq)return false;
    state.scopeData=scopeData;populateRepository();
    await loadData(true,initialData);
    if(seq!==state.scanSeq)return false;
    $('#cache-status').textContent='本地 · 只读';
    $('#cache-status').title=job.cached?'已读取缓存':`历史解析 ${job.elapsed||0} 秒`;
    setLoading(false);rememberRepository();return true;
  }catch(error){
    if(seq===state.scanSeq){state.dataPending=false;restoreSuccessful();setLoading(false);toast(error.message,true);}
    return false;
  }
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
async function loadData(required=false,preloaded=null){
  if(!state.job)return;
  clearTimeout(searchTimer);state.searchQueued=false;
  const seq=++state.dataSeq;closeInspector(false);
  state.dataPending=true;$('#export-button').disabled=true;
  $('.views').setAttribute('aria-busy','true');$('#stat-grid').setAttribute('aria-busy','true');
  state.analyticsController?.abort();state.analyticsController=new AbortController();
  try{
    const data=preloaded||await api('/api/analytics?'+queryString(),undefined,{signal:state.analyticsController.signal});
    if(seq!==state.dataSeq)return;
    state.data=data;pauseReplay(true);renderAll();
    state.successful=Object.fromEntries(['repo','job','data','scopeData','branch','mainline','from','to','q','author','preset','year'].map(k=>[k,state[k]]));
    if(state.view==='history')await loadCommits();
  }catch(error){
    if(error.name!=='AbortError'&&seq===state.dataSeq){if(required)throw error;restoreSuccessful();toast(error.message,true);}
  }finally{
    if(seq===state.dataSeq){state.dataPending=false;$('#export-button').disabled=state.loading||!state.data;$('.views').removeAttribute('aria-busy');$('#stat-grid').removeAttribute('aria-busy');}
  }
}
function restoreSuccessful(){
  if(!state.successful)return;
  Object.assign(state,state.successful);$('#history-search').value=state.q;
  populateRepository();renderAll();if(state.view==='history')loadCommits();
}
function renderAll(){
  const selectedAuthor=state.author;
  $('#author-filter').innerHTML='<option value="">全部作者</option>'+state.data.authorOptions.map(a=>`<option value="${esc(a.email)}">${esc(a.name)}</option>`).join('');
  $('#author-filter').value=selectedAuthor;
  renderFilters();renderStats();renderMilestones();renderCalendar();renderLanguages();renderAuthors();renderRecent();renderRhythm();
  state.series=buildSeries();state.hovered=-1;$('#growth-tooltip').classList.add('hidden');
  renderNavigator();drawGrowth();
}
function renderFilters(){
  const scope=state.scopeData?.scope||state.data.scope;
  const first=state.from||scope.first,last=state.to||scope.last;
  $('#date-description').textContent=first?`${dotted(first)} — ${dotted(last)}`:'全部日期';
  const hasDate=!!(state.from||state.to),hasAny=!!(hasDate||state.q||state.author);
  $('#date-range-button').classList.toggle('is-filtered',hasDate);
  $('#author-filter').classList.toggle('is-filtered',!!state.author);
  $('#author-filter').title=state.author||'全部作者';
  $('.search-field').classList.toggle('has-value',!!state.q);
  $('#search-clear').classList.toggle('hidden',!$('#history-search').value);
  $('#filter-reset').classList.toggle('hidden',!hasAny);
  $$('.range-segments button').forEach(b=>{const active=b.dataset.range===state.preset;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  $('#date-from').value=state.from||scope.first||'';$('#date-to').value=state.to||scope.last||'';
  $('#range-reset').classList.toggle('hidden',!hasDate);
}
function renderStats(){
  const s=state.data.summary,scope=state.data.scope;
  const rangeFirst=state.from||scope.first,rangeLast=state.to||scope.last;
  const rangeDays=rangeFirst&&rangeLast?Math.max(0,Math.round((toTime(rangeLast)-toTime(rangeFirst))/dayMs)+1):0;
  const entries=[['commit','提交',s.commits,''],['plus','新增行数',s.additions,'green'],['minus','删除行数',s.deletions,'orange'],['code','累计净变更',s.net,s.net<0?'orange':'green'],['calendar','活跃 / 总天数',s.activeDays,''],['users','贡献者',s.authors,'']];
  $('#stat-grid').innerHTML=entries.map(([i,label,value,color])=>{
    const display=i==='code'?signed(value):compact(value);
    const denominator=i==='commit'&&s.commits!==scope.commits?`<small>/ ${compact(scope.commits)}</small>`:i==='calendar'&&rangeDays?`<small>/ ${number(rangeDays)}</small>`:'';
    const help=i==='code'?`<button class="help" data-show-method aria-label="累计净变更的含义" title="新增减去删除；不是仓库当前总行数">${icon('info')}</button>`:'';
    return `<article class="stat-card"><div class="stat-label">${icon(i)}${label}${help}</div><div class="stat-value ${color}" title="${number(value)}">${display}${denominator}</div></article>`;
  }).join('');
}
function renderMilestones(){
  const d=state.data,s=d.summary;
  if(!s.commits){$('#milestones').innerHTML='<div class="empty-state">无匹配提交</div>';return;}
  const items=[
    {day:d.firstCommit.day,title:'最早提交',body:esc(d.firstCommit.subject),hash:d.firstCommit.hash},
    {day:s.peakDay.day,title:'提交最多的一天',body:`<b>${number(s.peakDay.commits)}</b> 次提交`,dayLink:true},
    {day:d.largestCommit.day,title:'最大变更',body:`<b>+${number(d.largestCommit.additions)}</b> <span class="change-del">−${number(d.largestCommit.deletions)}</span>`,hash:d.largestCommit.hash},
    {day:d.recent[0].day,title:'最近提交',body:esc(d.recent[0].subject),hash:d.recent[0].hash}
  ];
  $('#milestones').innerHTML=items.map(m=>`<button class="milestone" ${m.hash?`data-hash="${m.hash}"`:`data-day="${m.day}"`}><time>${dotted(m.day)}</time><h3>${m.title}${icon('arrow')}</h3><p>${m.body}</p></button>`).join('');
}
function heatLevel(count, max) { return !count ? 0 : Math.min(4, Math.max(1, Math.ceil(Math.sqrt(count / Math.max(1,max)) * 4))); }
function renderCalendar(){
  const daily=state.data.daily,map=new Map(daily.map(d=>[d.day,d])),scope=state.scopeData?.scope||state.data.scope;
  const yearSet=new Set(daily.map(d=>+d.day.slice(0,4)));
  if(scope.first&&scope.last)for(let year=+scope.first.slice(0,4);year<=+scope.last.slice(0,4);year++)yearSet.add(year);
  if(!yearSet.size)yearSet.add(new Date().getFullYear());
  if(state.year)yearSet.add(+state.year);
  const years=[...yearSet].sort((a,b)=>b-a);if(!state.year)state.year=years[0];
  $('#calendar-year').innerHTML=years.map(y=>`<option value="${y}">${y}</option>`).join('');$('#calendar-year').value=state.year;
  const items=daily.filter(d=>+d.day.slice(0,4)===+state.year),max=Math.max(1,...items.map(d=>d.commits));
  const first=toTime(`${state.year}-01-01`),last=toTime(`${state.year}-12-31`),offset=(new Date(first).getUTCDay()+6)%7,start=first-offset*dayMs,weeks=Math.ceil(((last-first)/dayMs+1+offset)/7);
  let html=['','一','','三','','五','','日'].map(l=>`<span class="calendar-label">${l}</span>`).join('');
  const low=state.from||scope.first,high=state.to||scope.last;
  const focus=state.calendarFocus&&state.calendarFocus.slice(0,4)===String(state.year)?state.calendarFocus:items.at(-1)?.day||`${state.year}-01-01`;
  for(let week=0;week<weeks;week++){
    let month='';for(let day=0;day<7;day++){const dt=new Date(start+(week*7+day)*dayMs);if(dt.getUTCFullYear()===+state.year&&dt.getUTCDate()===1){month=dt.getUTCMonth()+1+'月';break;}}
    html+=`<span class="calendar-month">${month}</span>`;
    for(let day=0;day<7;day++){
      const time=start+(week*7+day)*dayMs,value=toDay(time);
      if(time<first||time>last){html+='<span class="calendar-cell empty"></span>';continue;}
      const item=map.get(value),count=item?.commits||0,outside=(low&&value<low)||(high&&value>high)||!scope.commits;
      const tip=`${dotted(value)} · ${number(count)} 次提交${item?` · +${number(item.additions)} / −${number(item.deletions)} 行`:''}`;
      html+=`<button class="calendar-cell level${heatLevel(count,max)}${outside?' outside':''}" data-day="${value}" data-tip="${esc(tip)}" aria-label="${esc(tip)}" aria-pressed="false" tabindex="${value===focus&&!outside?'0':'-1'}" ${outside?'disabled':''}></button>`;
    }
  }
  $('#calendar').style.gridTemplateColumns=`22px repeat(${weeks},minmax(9px,1fr))`;$('#calendar').innerHTML=html;
  if(!$('#calendar [tabindex="0"]'))$('#calendar [data-day]:not(:disabled)')?.setAttribute('tabindex','0');
  let streak=0,longest=0,previous=null;
  for(const d of items){const t=toTime(d.day);streak=previous!==null&&t-previous===dayMs?streak+1:1;longest=Math.max(longest,streak);previous=t;}
  $('#calendar-days').textContent=number(items.length);$('#calendar-streak').textContent=number(longest);
  syncSelection();
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
function renderAuthors(){
  const authors=state.data.authors,max=authors[0]?.commits||1;
  $('#authors-count').textContent=state.data.summary.authors?`${number(state.data.summary.authors)} 人`:'';
  $('#authors').innerHTML=authors.length?`<div class="author-list">${authors.slice(0,4).map(a=>`<button class="author-row" data-author="${esc(a.email)}" title="筛选 ${esc(a.name)}">${avatar(a.name,a.email)}<span class="author-meta"><strong>${esc(a.name)}</strong><span class="author-track"><i style="width:${a.commits/max*100}%"></i></span></span><span class="author-number">${number(a.commits)}</span></button>`).join('')}${state.data.summary.authors>4?`<button class="author-extra" id="all-authors">全部 ${number(state.data.summary.authors)} 位作者 →</button>`:''}</div>`:'<div class="empty-state">无匹配作者</div>';
}
function changeCount(c) { return `<span class="change-count"><span class="change-add">+${compact(c.additions)}</span><span class="change-del">−${compact(c.deletions)}</span></span>`; }
function renderRecent() {
  $('#recent-commits').innerHTML = state.data.recent.length ? state.data.recent.map(c => `<button class="recent-row" data-hash="${c.hash}"><span class="recent-dot"></span><span class="recent-subject"><strong>${esc(c.subject || '(无提交说明)')}</strong><small>${c.hash.slice(0,7)} <span>·</span> ${esc(c.author)}</small></span><span class="recent-date">${dotted(c.day)}</span>${changeCount(c)}</button>`).join('') : '<div class="empty-state">无匹配提交</div>';
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
  $('#hours-summary').innerHTML = commits ? `<span>高峰时段 <b>${String(peakHour).padStart(2,'0')}:00</b></span><span>最多提交 <b>周${weekdays[peakWeek]}</b></span><span>深夜提交 <b>${(night/commits*100).toFixed(1)}%</b></span>` : '无匹配提交';
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
  $('#monthly-bars').innerHTML = monthList.length ? monthList.map(([month,n]) => `<button class="month-bar" data-month="${month}" data-tip="${month} · ${number(n.commits)} 次提交 · +${number(n.additions)} / −${number(n.deletions)} 行" aria-label="查看 ${month} 的提交"><span class="month-value">${compact(n.commits)}</span><span class="bar" style="height:${n.commits/maxMonth*145}px"></span><span class="month-name">${month.slice(2).replace('-','.')}</span></button>`).join('') : '<div class="empty-state">无匹配提交</div>';
  const s = state.data.summary;
  $('#rhythm-facts').innerHTML=`<article class="rhythm-fact"><span>最长连续活跃</span><strong>${number(s.longestStreak)}<small>天</small></strong></article><article class="rhythm-fact"><span>最长间隔</span><strong>${number(s.longestBreak)}<small>天</small></strong></article><article class="rhythm-fact"><span>每活跃日平均</span><strong>${s.activeDays?(s.commits/s.activeDays).toFixed(1):'0'}<small>次提交</small></strong></article>`;
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
  state.resolvedGrain=grain;
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
  ctx.font='10px Consolas, monospace';ctx.textAlign='right';ctx.textBaseline='middle';
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
  ctx.fillStyle=color('--faint');ctx.textAlign='right';ctx.font='7px "Segoe UI", sans-serif';ctx.fillText('行',left-10,baseline);
  const labelCount=Math.min(series.length,Math.max(2,Math.floor(plotWidth/95)));
  for(let i=0;i<labelCount;i++){const index=Math.round(i*(series.length-1)/Math.max(1,labelCount-1)),item=series[index];ctx.font='9px Consolas, monospace';ctx.textAlign=i===0?'left':i===labelCount-1?'right':'center';ctx.fillStyle=color('--faint');const span=(last-first)/dayMs;ctx.fillText(span>250?item.day.slice(0,7).replace('-','.'):item.day.slice(5).replace('-','.'),x(item.time),height-11);}
  if(state.hovered>=0 && state.hovered<=cutoff && series[state.hovered]){
    const d=series[state.hovered],px=x(d.time),py=y(d.net);ctx.beginPath();ctx.setLineDash([3,3]);ctx.moveTo(px,top);ctx.lineTo(px,barBottom);ctx.strokeStyle=color('--faint');ctx.lineWidth=1;ctx.stroke();ctx.setLineDash([]);ctx.beginPath();ctx.arc(px,py,4,0,Math.PI*2);ctx.fillStyle=color('--panel');ctx.fill();ctx.strokeStyle=color('--accent-text');ctx.stroke();
  }
  if(state.drag){const a=Math.min(state.drag.start,state.drag.current),b=Math.max(state.drag.start,state.drag.current);ctx.fillStyle=color('--accent-strong')+'25';ctx.fillRect(a,top,b-a,barBottom-top);ctx.strokeStyle=color('--accent-strong');ctx.lineWidth=1;ctx.strokeRect(a,top,b-a,barBottom-top);}
  const current=visible.at(-1);$('#growth-empty').classList.toggle('hidden',!!series.length);
  $('#replay-date').textContent=current?dotted(current.lastDay):'—';
  $('#replay-value').textContent=state.replay<1000?`${signed(current?.net||0)} 行`:'';$('#replay-slider').setAttribute('aria-valuetext',`${current?.lastDay||''}，净变更 ${current?.net||0} 行`);
  $('#replay-play').disabled=!series.length;
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
function pauseReplay(reset=false){
  state.playing=false;$('#replay-play').innerHTML=icon('play');$('#replay-play').setAttribute('aria-label','播放历程');$('#replay-play').title='播放历程';
  if(reset){state.replay=1000;$('#replay-slider').value=1000;}
}
function toggleReplay(){
  if(!state.series.length){toast('当前范围没有提交');return;}
  if(state.playing){pauseReplay();return;}
  if(state.replay>=1000)state.replay=0;
  state.playing=true;$('#replay-play').title='暂停历程';$('#replay-play').innerHTML=icon('pause');$('#replay-play').setAttribute('aria-label','暂停历程');
  let last=performance.now(),lastDraw=0;
  function frame(now){if(!state.playing)return;const delta=now-last;last=now;state.replay=Math.min(1000,state.replay+delta/20*state.speed);if(now-lastDraw>65 || state.replay===1000){lastDraw=now;$('#replay-slider').value=state.replay;drawGrowth();}if(state.replay>=1000)pauseReplay();else requestAnimationFrame(frame);}
  requestAnimationFrame(frame);
}

function setView(view,syncUrl=true){
  if(!['overview','history','rhythm'].includes(view))view='overview';
  const changed=state.view!==view;
  if(changed){closeInspector(false);pauseReplay();}
  state.view=view;
  for(const name of ['overview','history','rhythm'])$('#'+name+'-view').classList.toggle('hidden',name!==view);
  $$('.nav-item').forEach(button=>{const active=button.dataset.view===view;button.classList.toggle('active',active);if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
  if(syncUrl&&location.hash!=='#'+view)history.pushState(null,'','#'+view);
  if(changed)window.scrollTo({top:0});
  if(view==='overview')requestAnimationFrame(()=>{drawGrowth();drawNavigator();});
  if(view==='history'&&state.job&&state.data&&!state.dataPending)loadCommits();
}
async function loadCommits(){
  if(!state.job)return;
  const seq=++state.listSeq;state.listController?.abort();state.listController=new AbortController();
  $('#commit-list').setAttribute('aria-busy','true');$('#previous-page').disabled=$('#next-page').disabled=$('#page-input').disabled=true;
  try{
    const result=await api('/api/commits?'+queryString({offset:state.offset,limit:state.pageSize,order:state.order}),undefined,{signal:state.listController.signal});
    if(seq!==state.listSeq)return;
    state.total=result.total;
    $('#commit-list').innerHTML=result.commits.length?result.commits.map(c=>`<button class="commit-row" data-hash="${c.hash}" aria-pressed="false"><span class="commit-subject"><strong title="${esc(c.subject)}">${esc(c.subject||'(无说明)')}</strong><span class="commit-hash">${c.hash.slice(0,8)}</span>${c.is_merge?'<small class="commit-type">merge</small>':''}</span><span class="commit-author">${avatar(c.author,c.email)}<span title="${esc(c.email)}">${esc(c.author)}</span></span><time class="commit-time">${dotted(c.day)}<small>${esc(c.date.slice(11,16))}</small></time>${changeCount(c)}</button>`).join(''):`<div class="empty-state">${icon('search')}无匹配提交<button class="button secondary small" data-reset-filters>重置筛选</button></div>`;
    const pages=Math.max(1,Math.ceil(result.total/result.limit));
    $('#history-total').textContent=`${number(result.total)} 次提交`;
    $('#page-description').textContent=result.total?`${number(result.offset+1)}–${number(Math.min(result.offset+result.limit,result.total))}`:'';
    $('#page-number').textContent='/ '+number(pages);$('#page-input').value=Math.floor(result.offset/result.limit)+1;$('#page-input').max=pages;
    $('#previous-page').disabled=state.offset===0;$('#next-page').disabled=state.offset+state.pageSize>=result.total;$('#page-input').disabled=!result.total;
    $('#commit-list').scrollTop=0;syncSelection();
  }catch(error){if(error.name!=='AbortError')toast(error.message,true);}
  finally{if(seq===state.listSeq)$('#commit-list').removeAttribute('aria-busy');}
}
function changePage(page){
  const pages=Math.max(1,Math.ceil(state.total/state.pageSize)),target=Math.min(pages,Math.max(1,Number.isFinite(page)?Math.trunc(page):1));
  const offset=(target-1)*state.pageSize;
  if(offset===state.offset){$('#page-input').value=target;return;}
  closeInspector(false);state.offset=offset;loadCommits();
}
async function showCommit(sha,keepContext=false){
  if(!state.job)return;
  if(!keepContext)state.context=null;
  const seq=++state.detailSeq;state.detailController?.abort();state.detailController=new AbortController();
  state.selectedHash=sha;state.inspector='commit';state.currentCommit=null;
  openInspector('提交详情',keepContext&&!!state.context);
  $('#commit-detail').innerHTML='<div class="empty-state">读取提交…</div>';syncSelection();
  try{
    const key=state.job.id+':'+sha;
    const c=state.commitCache.get(key)||await api('/api/commit?'+queryString({hash:sha}),undefined,{signal:state.detailController.signal});
    if(seq!==state.detailSeq)return;
    state.commitCache.set(key,c);if(state.commitCache.size>80)state.commitCache.delete(state.commitCache.keys().next().value);
    state.currentCommit=c;
    const lines=c.message.split(/\r?\n/);if(lines[0]?.trim()===c.subject.trim())lines.shift();const body=lines.join('\n').trim();
    $('#commit-detail').innerHTML=`<h3 class="detail-subject">${esc(c.subject||'(无说明)')}</h3><div class="detail-hash"><span>${c.hash}</span><button class="icon-button" data-copy="${c.hash}" aria-label="复制提交 ID" title="复制提交 ID">${icon('copy')}</button></div><div class="detail-meta">${avatar(c.author,c.email)}<span class="detail-author" title="${esc(c.email)}">${esc(c.author)}</span>${state.repo.demo?'<span class="demo-badge">演示</span>':''}</div><time class="detail-date" title="${esc(c.date)}">${dotted(c.day)} · ${esc(c.date.slice(11,16))} ${esc(c.date.slice(19))}</time><div class="detail-changes"><span class="change-add">+${number(c.additions)}</span><span class="change-del">−${number(c.deletions)}</span><small>${number(c.files)} 个文件</small></div>${body?`<pre class="detail-message">${esc(body)}</pre>`:''}${c.is_merge&&!state.mainline?'<p class="detail-note">合并提交：完整历史模式不重复累加合入的文本增删。</p>':''}<div class="detail-files-title">文件${c.binary?`<span>${number(c.binary)} 个二进制</span>`:''}</div>${c.changedFiles.length>10?'<input class="detail-file-search" data-filter-files placeholder="筛选文件" aria-label="筛选文件">':''}<div class="detail-files" id="detail-files"></div>${c.filesTruncated?'<p class="detail-note">显示前 3,000 个文件。</p>':''}<p class="detail-parent">${c.parents?'父提交 '+esc(c.parents):'初始提交'}</p>`;
    renderDetailFiles();syncSelection();
  }catch(error){if(error.name!=='AbortError'&&seq===state.detailSeq)$('#commit-detail').innerHTML=`<div class="empty-state">${esc(error.message)}</div>`;}
}
function renderDetailFiles(q=''){
  const commit=state.currentCommit;if(!commit||!$('#detail-files'))return;
  const files=commit.changedFiles.filter(f=>f.path.toLocaleLowerCase().includes(q.toLocaleLowerCase()));
  $('#detail-files').innerHTML=files.length?files.map(f=>`<div class="detail-file"><span>${esc(f.path)}</span>${f.binary?'<small class="panel-unit">binary</small>':changeCount(f)}</div>`).join(''):'<p class="detail-note">无匹配文件</p>';
}
function openInspector(title,back=false){
  if($('#inspector').classList.contains('hidden'))state.inspectorOrigin=document.activeElement;
  $('#inspector-title').textContent=title;$('#inspector-back').classList.toggle('hidden',!back);
  $('#inspector').classList.remove('hidden');$('#workspace').classList.add('with-inspector');
  $('#commit-detail').scrollTop=0;syncInspectorLayout();
  requestAnimationFrame(()=>{const cell=$('#calendar .selected'),scroll=$('.calendar-scroll');if(!cell||!scroll)return;const c=cell.getBoundingClientRect(),r=scroll.getBoundingClientRect();if(c.right>r.right-18)scroll.scrollLeft+=c.right-r.right+18;else if(c.left<r.left+18)scroll.scrollLeft-=r.left+18-c.left;});
  if(window.matchMedia('(max-width:980px)').matches)$('#commit-detail').focus({preventScroll:true});
}
function closeInspector(restoreFocus=true){
  ++state.detailSeq;state.detailController?.abort();clearTimeout(state.selectionTimer);
  const origin=state.inspectorOrigin;
  state.inspector=null;state.context=null;state.selectedHash=null;state.currentCommit=null;state.inspectorOrigin=null;
  $('#inspector').classList.add('hidden');$('#workspace').classList.remove('with-inspector');
  syncInspectorLayout();syncSelection();
  if(restoreFocus&&origin?.isConnected)origin.focus({preventScroll:true});
}
function syncInspectorLayout(){
  const mobile=!!state.inspector&&window.matchMedia('(max-width:980px)').matches;
  $('#inspector-scrim').classList.toggle('hidden',!mobile);document.body.classList.toggle('inspecting',mobile);
  for(const element of [$('.app-header'),$('#scope-bar'),$('#stat-grid'),$('.views')])element.inert=mobile;
  $('#inspector').setAttribute('role',mobile?'dialog':'complementary');
  $('#inspector').setAttribute('aria-labelledby','inspector-title');
  if(mobile)$('#inspector').setAttribute('aria-modal','true');else $('#inspector').removeAttribute('aria-modal');
}
function syncSelection(){
  $$('[data-hash]').forEach(button=>{const active=button.dataset.hash===state.selectedHash;button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active));});
  const day=state.context?.kind==='day'?state.context.from:null;
  $$('#calendar [data-day]').forEach(button=>{const active=button.dataset.day===day;button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active));});
  $$('.month-bar').forEach(button=>{const active=state.context?.kind==='month'&&button.dataset.month===state.context.label;button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active));});
  const item=day?state.data?.daily.find(d=>d.day===day):null;
  $('#calendar-selection').textContent=day?`${dotted(day)} · ${number(item?.commits||0)} 次提交`:'';
}
async function showPeriod(from,to,label,kind='day',offset=0){
  const scope=state.scopeData?.scope||state.data.scope;
  from=[from,state.from||scope.first].filter(Boolean).sort().at(-1);to=[to,state.to||scope.last].filter(Boolean).sort()[0];
  if(!from||!to||from>to)return;
  const context={from,to,label,kind,offset};state.context=context;state.inspector='period';state.selectedHash=null;
  const seq=++state.detailSeq;state.detailController?.abort();state.detailController=new AbortController();
  openInspector(kind==='day'?dotted(label):label.replace('-','.'),false);syncSelection();
  $('#commit-detail').innerHTML='<div class="empty-state">读取提交…</div>';
  try{
    const page=await api('/api/commits?'+queryString({from,to,offset,limit:60,order:'desc'}),undefined,{signal:state.detailController.signal});
    if(seq!==state.detailSeq)return;
    context.total=page.total;
    $('#commit-detail').innerHTML=`<div class="context-summary"><strong>${number(page.total)}<small class="panel-unit"> 次提交</small></strong><span>${page.total>60?`${number(offset+1)}–${number(Math.min(offset+60,page.total))}`:''}</span></div>${kind==='month'?`<p class="detail-date">${dotted(from)} — ${dotted(to)}</p>`:''}${page.commits.map(c=>`<button class="context-commit" data-hash="${c.hash}"><strong>${esc(c.subject||'(无说明)')}</strong><span class="context-meta"><span>${esc(c.author)} · ${kind==='day'?c.date.slice(11,16):c.day.slice(5)}</span>${changeCount(c)}</span></button>`).join('')||'<div class="empty-state">当天无提交</div>'}${page.total>60?`<div class="context-more"><button class="button secondary small" data-context-page="${Math.max(0,offset-60)}" ${offset===0?'disabled':''}>上一页</button> <button class="button secondary small" data-context-page="${offset+60}" ${offset+60>=page.total?'disabled':''}>下一页</button></div>`:''}`;
  }catch(error){if(error.name!=='AbortError'&&seq===state.detailSeq)$('#commit-detail').innerHTML=`<div class="empty-state">${esc(error.message)}</div>`;}
}
function applyDateRange(from,to,preset='custom'){
  if(from&&to&&from>to){toast('开始日期不能晚于结束日期',true);return;}
  const scope=state.scopeData?.scope;
  if(scope&&from===scope.first&&to===scope.last){from=to='';preset='all';}
  state.from=from;state.to=to;state.preset=from||to?preset:'all';state.offset=0;closeDatePopover();loadData();
}
function closeDatePopover(){
  $('#date-popover').classList.add('hidden');$('#date-range-button').setAttribute('aria-expanded','false');
}
function resetFilters(){
  clearTimeout(searchTimer);state.from=state.to=state.q=state.author='';state.preset='all';state.offset=0;
  $('#history-search').value='';$('#author-filter').value='';closeDatePopover();loadData();
}
function openDialog(){renderRecentRepositories();$('#open-error').classList.add('hidden');$('#open-dialog').showModal();setTimeout(()=>$('#repo-path').focus(),30);}
function renderRecentRepositories(){
  $('#recent-repositories').classList.toggle('hidden',!state.recent.length);
  $('#recent-repository-list').innerHTML=state.recent.slice(0,4).map(r=>`<button type="button" class="recent-repository" data-repo-path="${esc(r.path)}">${icon('folder')}<div><strong>${esc(r.name)}</strong><small>${esc(r.path)}</small></div>${icon('arrow')}</button>`).join('');
}
function download(blob,filename){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
async function exportCSV(){
  if(!state.job||state.dataPending||state.loading)return;
  closeExportMenu();
  try{
    const response=await fetch('/api/export?'+queryString(),{headers:{'X-Git-Atlas':token}});
    if(!response.ok)throw new Error('导出失败');
    download(await response.blob(),`git-atlas-${state.repo.name.replace(/[^\w\-\u4e00-\u9fff]/g,'_')}-${localToday()}.csv`);toast('CSV 已导出');
  }catch(error){toast(error.message,true);}
}
async function exportHTML(){
  if(!state.data||state.dataPending||state.loading)return;
  closeExportMenu();pauseReplay(true);drawGrowth(true);
  const staticHTML=selector=>{
    const clone=$(selector).cloneNode(true);
    clone.querySelectorAll('[data-show-method],.author-extra,[data-reset-filters]').forEach(node=>node.remove());
    clone.querySelectorAll('.selected').forEach(node=>node.classList.remove('selected'));
    clone.querySelectorAll('button').forEach(button=>{const replacement=document.createElement(button.classList.contains('calendar-cell')?'span':'div');for(const attribute of button.attributes){if(['class','style','aria-label'].includes(attribute.name))replacement.setAttribute(attribute.name,attribute.value);}if(button.dataset.tip)replacement.title=button.dataset.tip;replacement.innerHTML=button.innerHTML;button.replaceWith(replacement);});
    return clone.innerHTML;
  };
  const snapshot={repo:state.repo.name,demo:state.repo.demo,shallow:state.repo.shallow,branch:branchName(),mainline:state.mainline,theme:document.documentElement.dataset.theme,first:state.from||state.data.scope.first,last:state.to||state.data.scope.last,q:state.q,author:state.author,year:state.year,days:$('#calendar-days').textContent,streak:$('#calendar-streak').textContent,stats:staticHTML('#stat-grid'),milestones:staticHTML('#milestones'),calendar:staticHTML('#calendar'),calendarStyle:$('#calendar').getAttribute('style'),languages:staticHTML('#languages'),authors:staticHTML('#authors'),hours:staticHTML('#hours-grid'),hoursSummary:staticHTML('#hours-summary'),recent:staticHTML('#recent-commits'),chart:$('#growth-chart').toDataURL('image/png'),sprite:$('.sprite').outerHTML,grain:({day:'日',week:'周',month:'月',year:'年'})[state.resolvedGrain]||'日'};
  try{
    const css=await(await fetch('/style.css')).text(),repo=esc(snapshot.repo);
    const report=`<!doctype html><html lang="zh-CN" data-theme="${snapshot.theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${repo} · Git Atlas</title><style>${css}\n.report{max-width:1180px;padding:36px 28px;margin:auto}.report h1{font-size:26px;line-height:1.5;font-weight:600;margin:0 0 8px}.report-meta{font-size:12px;color:var(--muted);line-height:2;margin-bottom:25px}.report .panel{margin-bottom:16px}.report .stat-grid{margin-bottom:20px}.report-chart{width:100%;display:block;height:auto}.report .calendar{min-width:780px}.report .milestones{display:grid;grid-template-columns:repeat(4,1fr);gap:20px}.report .milestone{border:0;pointer-events:none}.report .milestone h3 svg{display:none}.report .lower-grid>.panel{margin-bottom:0}.report-footer{font-size:11px;color:var(--muted);line-height:1.9;border-top:1px solid var(--line);padding-top:18px}.report .hours-grid{margin-bottom:20px}.report .recent-row{cursor:default}.report .author-row{cursor:default}@media(max-width:760px){.report{padding:25px 18px}.report .milestones{grid-template-columns:1fr 1fr}.report h1{font-size:22px}}@media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact}.report{padding:0}.report .panel,.report .stat-grid{break-inside:avoid}}</style></head><body>${snapshot.sprite}<article class="report"><h1>${repo}</h1><div class="report-meta">${snapshot.demo?'<b>演示数据</b> · ':''}${snapshot.shallow?'浅克隆 · ':''}${esc(snapshot.branch)} · ${snapshot.mainline?'仅主线':'完整历史'}<br>${dotted(snapshot.first)} — ${dotted(snapshot.last)}${snapshot.author?'<br>作者：'+esc(snapshot.author):''}${snapshot.q?'<br>筛选：'+esc(snapshot.q):''}</div><section class="stat-grid">${snapshot.stats}</section><section class="panel"><div class="panel-heading"><h2>代码变更</h2><span class="panel-unit">按${snapshot.grain}聚合 · 行</span></div><img class="report-chart" src="${snapshot.chart}" alt="累计净变更与增删量"><div class="panel-heading"><span class="chart-legend"><span><i class="legend-line"></i>累计净变更</span><span><i class="green"></i>新增</span><span><i class="orange"></i>删除</span></span></div></section><section class="panel"><div class="panel-heading"><h2>历史节点</h2></div><div class="milestones">${snapshot.milestones}</div></section><section class="panel"><div class="panel-heading"><h2>提交日历 · ${snapshot.year}</h2><span class="panel-unit">${snapshot.days} 天活跃 · 最长连续 ${snapshot.streak} 天</span></div><div class="calendar-scroll"><div class="calendar" style="${esc(snapshot.calendarStyle)}">${snapshot.calendar}</div></div><div class="calendar-footer"></div></section><div class="lower-grid"><section class="panel"><div class="panel-heading"><h2>文件类型</h2><span class="panel-unit">变更行数</span></div>${snapshot.languages}</section><section class="panel"><div class="panel-heading"><h2>贡献者</h2></div>${snapshot.authors}</section></div><section class="panel"><div class="panel-heading"><h2>提交时段</h2></div><div class="hours-scroll"><div class="hours-grid">${snapshot.hours}</div></div><div class="hours-summary">${snapshot.hoursSummary}</div></section><section class="panel"><div class="panel-heading"><h2>最近提交</h2></div><div style="padding:0 20px">${snapshot.recent}</div></section><footer class="report-footer">Git Atlas · ${esc(new Date().toLocaleString('zh-CN'))}<br>累计净变更 = 文本新增 − 删除，不等于当前代码总行数。统计包含文档、配置、锁文件与已提交的生成文件；二进制不计行数，重命名按删除与新增处理。${snapshot.mainline?'仅主线：统计合并相对第一父提交的变化。':'完整历史：合并提交保留记录，不重复累加其文件增删。'}<br>作者日期保留原始时区；无法从提交次数推导实际工作时长。日历仅展示选中的年份。</footer></article></body></html>`;
    download(new Blob([report],{type:'text/html;charset=utf-8'}),`git-atlas-${snapshot.repo.replace(/[^\w\-\u4e00-\u9fff]/g,'_')}-${localToday()}.html`);toast('报告已导出');
  }catch(error){toast('导出失败：'+error.message,true);}
}
function closeExportMenu(){
  $('#export-menu').classList.add('hidden');$('#export-button').setAttribute('aria-expanded','false');
}
function renderNavigator(){
  const scope=state.scopeData?.scope||state.data?.scope;
  const enabled=!!scope?.first&&!!scope?.last;
  const span=enabled?Math.max(0,Math.round((toTime(scope.last)-toTime(scope.first))/dayMs)):0;
  state.brush=enabled?{first:scope.first,last:scope.last,span}:null;
  const clamp=value=>Math.max(0,Math.min(span,value));
  const start=enabled&&state.from?clamp(Math.round((toTime(state.from)-toTime(scope.first))/dayMs)):0;
  const end=enabled&&state.to?clamp(Math.round((toTime(state.to)-toTime(scope.first))/dayMs)):span;
  for(const input of [$('#range-start'),$('#range-end')]){input.max=Math.max(1,span);input.disabled=!enabled||span===0;}
  $('#range-start').value=start;$('#range-end').value=span?end:1;
  updateNavigatorPreview();drawNavigator();
}
function updateNavigatorPreview(source){
  const brush=state.brush,track=$('.navigator-track');
  if(!brush){track.style.setProperty('--range-start','0%');track.style.setProperty('--range-end','100%');$('#navigator-from').textContent=$('#navigator-to').textContent='—';return;}
  let start=+$('#range-start').value,end=+$('#range-end').value;
  if(start>end){if(source==='start')start=end;else end=start;}
  $('#range-start').value=start;$('#range-end').value=end;
  track.style.setProperty('--range-start',(brush.span?start/brush.span*100:0)+'%');
  track.style.setProperty('--range-end',(brush.span?end/brush.span*100:100)+'%');
  const from=toDay(toTime(brush.first)+Math.min(brush.span,start)*dayMs),to=toDay(toTime(brush.first)+Math.min(brush.span,end)*dayMs);
  $('#navigator-from').textContent=dotted(from);$('#navigator-to').textContent=dotted(to);
  $('#range-start').setAttribute('aria-valuetext',from);$('#range-end').setAttribute('aria-valuetext',to);
}
function commitNavigatorRange(){
  if(!state.brush)return;
  const brush=state.brush,from=toDay(toTime(brush.first)+Math.min(brush.span,+$('#range-start').value)*dayMs),to=toDay(toTime(brush.first)+Math.min(brush.span,+$('#range-end').value)*dayMs);
  applyDateRange(from,to);
}
function drawNavigator(){
  const canvas=$('#navigator-chart'),rect=canvas.getBoundingClientRect();if(!rect.width)return;
  const dpr=Math.min(devicePixelRatio||1,2),width=rect.width,height=rect.height;
  canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const daily=state.scopeData?.daily||[],brush=state.brush;if(!daily.length||!brush)return;
  let cumulative=0;const every=Math.max(1,Math.floor(daily.length/1400)),values=[];
  daily.forEach((item,index)=>{cumulative+=item.additions-item.deletions;if(index%every===0||index===daily.length-1)values.push({time:toTime(item.day),net:cumulative});});
  let low=0,high=1;for(const value of values){low=Math.min(low,value.net);high=Math.max(high,value.net);}
  const extent=Math.max(dayMs,toTime(brush.last)-toTime(brush.first));
  const points=values.map(value=>({x:(value.time-toTime(brush.first))/extent*width,y:height-3-(value.net-low)/(high-low)*(height-6)}));
  const accent=getComputedStyle(document.documentElement).getPropertyValue('--accent-strong').trim();
  ctx.beginPath();traceCurve(ctx,points);ctx.lineTo(points.at(-1).x,height);ctx.lineTo(points[0].x,height);ctx.closePath();ctx.fillStyle=accent+'20';ctx.fill();
  ctx.beginPath();traceCurve(ctx,points);ctx.lineWidth=1;ctx.strokeStyle=accent;ctx.stroke();
}

// Interaction wiring: scope controls filter; data marks inspect.
$$('.nav-item').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.view)));
$('#open-button').addEventListener('click',openDialog);$('#repo-card').addEventListener('click',openDialog);
$('#open-form').addEventListener('submit',event=>{event.preventDefault();openRepository($('#repo-path').value);});
$('#demo-button').addEventListener('click',()=>openRepository('',true));
$('#browse-button').addEventListener('click',async()=>{
  const button=$('#browse-button');button.disabled=true;
  try{const result=await api('/api/browse',{});if(result.path){$('#repo-path').value=result.path;$('#repo-path').focus();}}
  catch(error){$('#open-error').textContent=error.message;$('#open-error').classList.remove('hidden');}
  finally{button.disabled=false;}
});
$$('[data-close]').forEach(button=>button.addEventListener('click',()=>$('#'+button.dataset.close).close()));
$$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{
  if(event.target!==dialog)return;const rect=dialog.getBoundingClientRect();
  if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();
}));
for(const id of ['method-button','footer-method','chart-help'])$('#'+id).addEventListener('click',()=>$('#method-dialog').showModal());
$('#branch-select').addEventListener('change',event=>{state.branch=event.target.value;if(state.branch==='__all__')state.mainline=false;populateRepository();scanRepository();});
$('#mainline').addEventListener('change',()=>{state.mainline=$('#mainline').checked;scanRepository();});
$('#refresh-button').addEventListener('click',refreshRepository);
$('#date-range-button').addEventListener('click',()=>{
  const open=$('#date-popover').classList.contains('hidden');
  if(open&&state.data)renderFilters();
  $('#date-popover').classList.toggle('hidden',!open);$('#date-range-button').setAttribute('aria-expanded',String(open));
});
$('#cancel-dates').addEventListener('click',closeDatePopover);
$$('.range-segments button').forEach(button=>button.addEventListener('click',()=>{
  const range=button.dataset.range;
  if(range==='all')applyDateRange('','','all');
  else{const today=localToday();applyDateRange(toDay(toTime(today)-(+range-1)*dayMs),today,range);}
}));
$('#apply-dates').addEventListener('click',()=>applyDateRange($('#date-from').value,$('#date-to').value));
for(const input of [$('#date-from'),$('#date-to')])input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();applyDateRange($('#date-from').value,$('#date-to').value);}});
$('#filter-reset').addEventListener('click',resetFilters);$('#range-reset').addEventListener('click',()=>applyDateRange('','','all'));
for(const [id,source] of [['range-start','start'],['range-end','end']]){
  $('#'+id).addEventListener('input',()=>updateNavigatorPreview(source));
  $('#'+id).addEventListener('change',commitNavigatorRange);
}
$$('.chart-select button').forEach(button=>button.addEventListener('click',()=>{
  state.grain=button.dataset.grain;
  $$('.chart-select button').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});
  pauseReplay(true);state.series=buildSeries();drawGrowth();
}));
$('#calendar-year').addEventListener('change',()=>{state.year=+$('#calendar-year').value;state.calendarFocus=null;renderCalendar();});
$('#calendar').addEventListener('keydown',event=>{
  const cell=event.target.closest('[data-day]');if(!cell)return;
  const deltas={ArrowLeft:-7,ArrowRight:7,ArrowUp:-1,ArrowDown:1};
  if(!(event.key in deltas))return;
  event.preventDefault();const day=toDay(toTime(cell.dataset.day)+deltas[event.key]*dayMs);
  const next=$(`#calendar [data-day="${day}"]:not(:disabled)`);
  if(next){cell.tabIndex=-1;next.tabIndex=0;state.calendarFocus=day;next.focus({preventScroll:true});next.scrollIntoView({block:'nearest',inline:'nearest'});}
});
$('#replay-play').addEventListener('click',toggleReplay);
$('#replay-slider').addEventListener('input',()=>{pauseReplay();state.replay=+$('#replay-slider').value;state.hovered=-1;$('#growth-tooltip').classList.add('hidden');drawGrowth();});
$('#replay-speed').addEventListener('click',()=>{state.speed=state.speed===4?1:state.speed*2;$('#replay-speed').textContent=state.speed+'×';});
const canvas=$('#growth-chart');
canvas.addEventListener('pointermove',event=>{
  if(state.drag){const rect=canvas.getBoundingClientRect();state.drag.current=Math.min(state.chart.width-state.chart.right,Math.max(state.chart.left,event.clientX-rect.left));drawGrowth();}
  else showChartTooltip(event);
});
canvas.addEventListener('pointerleave',()=>{if(!state.drag)hideChartTooltip();});
canvas.addEventListener('pointerdown',event=>{
  if(!state.series.length||event.button!==0||state.dataPending)return;
  pauseReplay();const px=event.clientX-canvas.getBoundingClientRect().left;
  if(px<state.chart.left||px>state.chart.width-state.chart.right)return;
  state.drag={start:px,current:px};canvas.setPointerCapture(event.pointerId);$('#growth-tooltip').classList.add('hidden');
});
canvas.addEventListener('pointerup',event=>{
  if(!state.drag)return;
  const drag=state.drag,chart=state.chart;state.drag=null;canvas.releasePointerCapture(event.pointerId);
  if(Math.abs(drag.current-drag.start)>10){
    const dateAt=x=>toDay(chart.minTime+(x-chart.left)/(chart.width-chart.left-chart.right)*(chart.maxTime-chart.minTime));
    applyDateRange(dateAt(Math.min(drag.start,drag.current)),dateAt(Math.max(drag.start,drag.current)));
  }else drawGrowth();
});
canvas.addEventListener('pointercancel',()=>{state.drag=null;drawGrowth();});
canvas.addEventListener('dblclick',()=>applyDateRange('','','all'));
$('#view-all-commits').addEventListener('click',()=>setView('history'));
$('#history-search').addEventListener('input',()=>{
  clearTimeout(searchTimer);state.q=$('#history-search').value.trim();state.offset=0;state.searchQueued=true;
  ++state.dataSeq;++state.listSeq;state.analyticsController?.abort();state.listController?.abort();closeInspector(false);
  state.dataPending=true;$('#export-button').disabled=true;$('.views').setAttribute('aria-busy','true');$('#stat-grid').setAttribute('aria-busy','true');
  $('.search-field').classList.toggle('has-value',!!state.q);$('#search-clear').classList.toggle('hidden',!$('#history-search').value);
  searchTimer=setTimeout(()=>loadData(),230);
});
$('#history-search').addEventListener('keydown',event=>{
  if(event.key==='Enter'){event.preventDefault();if(state.searchQueued)loadData();setView('history');}
});
$('#search-clear').addEventListener('click',()=>{clearTimeout(searchTimer);state.q='';state.offset=0;$('#history-search').value='';loadData();$('#history-search').focus();});
$('#author-filter').addEventListener('change',()=>{state.author=$('#author-filter').value;state.offset=0;loadData();});
$('#sort-order').addEventListener('change',()=>{state.order=$('#sort-order').value;state.offset=0;closeInspector(false);loadCommits();});
$('#previous-page').addEventListener('click',()=>changePage(Math.floor(state.offset/state.pageSize)));
$('#next-page').addEventListener('click',()=>changePage(Math.floor(state.offset/state.pageSize)+2));
$('#page-input').addEventListener('change',()=>changePage(+$('#page-input').value));
$('#page-input').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();changePage(+$('#page-input').value);}});
$('#commit-list').addEventListener('keydown',event=>{
  if(!['ArrowDown','ArrowUp'].includes(event.key))return;
  const rows=$$('.commit-row'),current=event.target.closest('.commit-row'),index=rows.indexOf(current);
  if(index<0)return;
  const next=rows[Math.max(0,Math.min(rows.length-1,index+(event.key==='ArrowDown'?1:-1)))];
  event.preventDefault();next.focus({preventScroll:true});next.scrollIntoView({block:'nearest'});
  state.selectedHash=next.dataset.hash;syncSelection();clearTimeout(state.selectionTimer);
  state.selectionTimer=setTimeout(()=>showCommit(next.dataset.hash),100);
});
$('#inspector-close').addEventListener('click',()=>closeInspector());
$('#inspector-scrim').addEventListener('click',()=>closeInspector());
$('#inspector-back').addEventListener('click',()=>{const ctx=state.context;if(ctx)showPeriod(ctx.from,ctx.to,ctx.label,ctx.kind,ctx.offset);});
$('#commit-detail').addEventListener('input',event=>{if(event.target.matches('[data-filter-files]'))renderDetailFiles(event.target.value);});
$('#theme-toggle').addEventListener('click',()=>{
  document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';
  try{localStorage.setItem('git-atlas-theme',document.documentElement.dataset.theme);}catch{}
  drawGrowth();drawNavigator();
});
$('#export-button').addEventListener('click',()=>{const open=$('#export-menu').classList.contains('hidden');$('#export-menu').classList.toggle('hidden',!open);$('#export-button').setAttribute('aria-expanded',String(open));});
$('#export-html').addEventListener('click',exportHTML);$('#export-csv').addEventListener('click',exportCSV);
document.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){
    if($$('dialog').some(dialog=>dialog.open))return;
    event.preventDefault();if(state.inspector&&window.matchMedia('(max-width:980px)').matches)closeInspector(false);
    $('#history-search').focus();$('#history-search').select();
  }
  if(event.key==='Escape'&&!$$('dialog').some(dialog=>dialog.open)){
    if(!$('#date-popover').classList.contains('hidden')){closeDatePopover();$('#date-range-button').focus();}
    else if(!$('#export-menu').classList.contains('hidden')){closeExportMenu();$('#export-button').focus();}
    else if(state.inspector)closeInspector();
  }
  if(event.key==='Tab'&&state.inspector&&window.matchMedia('(max-width:980px)').matches){
    const elements=$$('#inspector button:not(:disabled):not(.hidden), #inspector input:not(:disabled)').filter(element=>element.getClientRects().length);
    const first=elements[0],last=elements.at(-1);
    if(event.shiftKey&&(document.activeElement===first||document.activeElement===$('#commit-detail'))){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
});
document.addEventListener('click',async event=>{
  const hash=event.target.closest('[data-hash]');if(hash)showCommit(hash.dataset.hash,!!hash.closest('#commit-detail'));
  const author=event.target.closest('[data-author]');if(author){state.author=author.dataset.author;state.offset=0;loadData();}
  const day=event.target.closest('[data-day]');if(day&&!day.disabled){state.calendarFocus=day.dataset.day;showPeriod(day.dataset.day,day.dataset.day,day.dataset.day);$('#heat-tooltip').classList.add('hidden');}
  const month=event.target.closest('[data-month]');if(month){const first=month.dataset.month+'-01',next=new Date(toTime(first));next.setUTCMonth(next.getUTCMonth()+1);showPeriod(first,toDay(next.getTime()-dayMs),month.dataset.month,'month');}
  const contextPage=event.target.closest('[data-context-page]');if(contextPage&&state.context){const ctx=state.context;showPeriod(ctx.from,ctx.to,ctx.label,ctx.kind,+contextPage.dataset.contextPage);}
  const recent=event.target.closest('[data-repo-path]');if(recent){$('#repo-path').value=recent.dataset.repoPath;openRepository(recent.dataset.repoPath);}
  const copy=event.target.closest('[data-copy]');if(copy){try{await navigator.clipboard.writeText(copy.dataset.copy);toast('已复制提交 ID');}catch{toast('请选中提交 ID 手动复制',true);}}
  if(event.target.closest('[data-reset-filters]'))resetFilters();
  if(event.target.closest('[data-show-method]'))$('#method-dialog').showModal();
  if(event.target.closest('#all-authors')){$('#author-filter').focus();try{$('#author-filter').showPicker?.();}catch{}}
  if(!event.target.closest('.export-wrap'))closeExportMenu();
  if(!event.target.closest('.date-control'))closeDatePopover();
});
document.addEventListener('pointerover',event=>{
  const target=event.target.closest('[data-tip]');if(!target||target.disabled)return;
  const tip=$('#heat-tooltip'),rect=target.getBoundingClientRect();tip.textContent=target.dataset.tip;tip.classList.remove('hidden');
  tip.style.left=Math.max(8,Math.min(rect.left+rect.width/2-tip.offsetWidth/2,innerWidth-tip.offsetWidth-8))+'px';
  tip.style.top=Math.max(8,rect.top-tip.offsetHeight-8)+'px';
});
document.addEventListener('pointerout',event=>{if(event.target.closest('[data-tip]'))$('#heat-tooltip').classList.add('hidden');});
window.addEventListener('scroll',()=>$('#heat-tooltip').classList.add('hidden'),{passive:true});
new ResizeObserver(()=>{if(state.view==='overview'){drawGrowth();drawNavigator();}}).observe($('.growth-chart-wrap'));
new ResizeObserver(()=>{document.documentElement.style.setProperty('--header-height',Math.ceil($('.app-header').getBoundingClientRect().height)+'px');document.documentElement.style.setProperty('--scope-height',Math.ceil($('#scope-bar').getBoundingClientRect().height)+'px');}).observe($('#scope-bar'));
new ResizeObserver(()=>{document.documentElement.style.setProperty('--header-height',Math.ceil($('.app-header').getBoundingClientRect().height)+'px');}).observe($('.app-header'));
window.addEventListener('resize',syncInspectorLayout);
window.addEventListener('hashchange',()=>setView(location.hash.slice(1),false));
async function init(){
  try{const theme=localStorage.getItem('git-atlas-theme');if(['dark','light'].includes(theme))document.documentElement.dataset.theme=theme;}catch{}
  $('#search-shortcut').textContent=navigator.platform.toLowerCase().includes('mac')?'⌘ K':'Ctrl K';
  setView(location.hash.slice(1)||'overview',false);
  try{
    const session=await api('/api/session');state.recent=session.recent;renderRecentRepositories();
    if(session.startupRepo){state.repo=session.startupRepo;state.branch=state.repo.defaultBranch;populateRepository();await scanRepository();}
    else{
      let last=null;try{last=JSON.parse(localStorage.getItem('git-atlas-last-repo')||'null');}catch{}
      if(last&&!last.demo){if(!await openRepository(last.path)){await openRepository('',true);openDialog();}}
      else await openRepository('',true);
    }
  }catch(error){setLoading(false);toast(error.message,true);}
}
init();
