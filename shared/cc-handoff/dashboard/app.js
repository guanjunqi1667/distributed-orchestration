// Handoff dashboard — client-side renderer.
// Polls /api every 6s and incrementally updates the three board columns
// (queue / in-progress / done) WITHOUT rebuilding existing cards, so the
// per-6s description flicker is gone and any expanded card stays expanded.
var H = '';   // 相对路径，自动适配当前访问地址
var POLL_MS = 6000;
var NODE_MAP = {};  // nodes.json 加载后的映射表

// 从服务端加载节点注册表
fetch(H+'/api/nodes').then(function(r){return r.json()}).then(function(d){
  d.nodes.forEach(function(n){
    NODE_MAP[n.id]=n.display;
    (n.aliases||[]).forEach(function(a){NODE_MAP[a]=n.display});
  });
}).catch(function(){});

// ── existing helpers (preserved verbatim) ──────────────────────────────────
function ago(i){if(!i)return'--';var s=(Date.now()-new Date(i).getTime())/1000;return s<60?'刚刚':s<3600?Math.round(s/60)+'分':s<86400?Math.round(s/3600)+'小时':Math.round(s/86400)+'天'}
function on(n){return n[0]=='P'&&n[1]=='0'?'p0':n[0]=='P'&&n[1]=='1'?'p1':'p2'}
function a(n){if(!n)return'';var raw=n.split(/[\s(]/)[0].toLowerCase();return NODE_MAP[raw]||n}
function tc(el){el.classList.toggle('open')}

// ── small render helpers ───────────────────────────────────────────────────
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
// 切分 token: ~1.3M（说明文字）→ {val:'~1.3M',note:'说明文字'}
function splitToken(tk){if(!tk)return{val:'',note:''};var m=tk.match(/^([^（(]+)[（(](.+)[）)]$/)||tk.match(/^(.+?)\s*[—–-]\s*(.+)$/);return m?{val:m[1].trim(),note:m[2].trim()}:{val:tk.trim(),note:''}}
// 名称 + 短 token（仅数值，括号内的放入描述）
function cardName(t,col){var s=esc(t.name.replace(/\.md$/,''));var tk=splitToken(t.tokens);if(tk.val)s+=' <span class="tk">'+esc(tk.val)+'</span>';return s}
function pad(x){return(x<10?'0':'')+x}
function clockStr(){var d=new Date();return pad(d.getHours())+':'+pad(d.getMinutes())}
// time row: relative time + node name badge
function tmHTML(t){var s='<span>'+ago(t.mtime)+'</span>';if(t.by)s+='<span class="by">'+esc(a(t.by))+'</span>';return s}
// 描述 + token 括号内说明文字
function descHTML(t){var s=esc(t.desc||'(无描述)');var tk=splitToken(t.tokens);if(tk.note)s+=' <span class="tk-note">——'+esc(tk.note)+'</span>';return s}
function cardHTML(t,col){return '<div class="nm">'+cardName(t,col)+'</div><div class="tm">'+tmHTML(t)+'</div><div class="desc">'+descHTML(t)+'</div>'}

// ── one-time column scaffolding: .col-hd (title + count) + .col-bd (cards) ─
var TITLES={q:'队列',p:'处理中',d:'已完成'};
function buildCols(){
  ['q','p','d'].forEach(function(id){
    var col=document.getElementById(id);
    col.innerHTML='<div class="col-hd"><span>'+TITLES[id]+'</span><span class="ct2" data-cnt>0</span></div><div class="col-bd"></div>';
    // delegate click → toggle expand (survives incremental card updates)
    col.querySelector('.col-bd').addEventListener('click',function(e){
      var cd=e.target.closest('.cd');if(cd)tc(cd);
    });
  });
}

// ── incremental column render: only mutate time/count, reuse card nodes ────
function renderCol(colId,items,emptyText){
  var col=document.getElementById(colId);
  var body=col.querySelector('.col-bd');
  col.querySelector('[data-cnt]').textContent=items.length;
  var existing={};
  Array.prototype.forEach.call(body.children,function(c){
    if(c.classList.contains('cd'))existing[c.getAttribute('data-id')]=c;
  });
  var seen={},sig;
  items.forEach(function(t){
    var id=t.name;seen[id]=1;
    var card=existing[id];
    sig=(t.desc||'')+'|'+(t.tokens||'')+'|'+splitToken(t.tokens).note;
    if(!card){                                   // new card
      card=document.createElement('div');
      card.className='cd '+on(t.name);
      card.setAttribute('data-id',id);
      card.setAttribute('data-sig',sig);
      card.innerHTML=cardHTML(t,colId);
      body.appendChild(card);                    // only NEW cards enter/move here
    }else{                                       // existing → mutate only what actually changed
      var tmEl=card.querySelector('.tm');
      var tmNew=tmHTML(t);
      if(tmEl.innerHTML!==tmNew) tmEl.innerHTML=tmNew;   // time text changed only
      if(card.getAttribute('data-sig')!==sig){   // desc/tokens rarely change
        card.querySelector('.desc').innerHTML=descHTML(t);
        card.setAttribute('data-sig',sig);
      }
      // NOTE: no appendChild on existing cards → no per-6s reflow/flicker
    }
  });
  Object.keys(existing).forEach(function(id){if(!seen[id])existing[id].remove();});
  var emp=body.querySelector('.emp');
  if(emp)emp.remove();
  if(!items.length){
    emp=document.createElement('div');emp.className='emp';emp.textContent=emptyText;body.appendChild(emp);
  }
}

function renderStatus(d){
  // 状态栏由服务端动态渲染（{{NODES}}），此处仅尝试验证队列计数
  var badge=document.getElementById('qbadge');
  if(badge)badge.textContent=d.inbox.length;
  var clk=document.getElementById('clk');
  if(clk)clk.textContent=clockStr();
}

// ── render + poll ──────────────────────────────────────────────────────────
function rd(d){
  renderStatus(d);
  renderCol('q',d.inbox,'队列为空');
  renderCol('p',d.in_progress,'暂无处理');
  renderCol('d',d.done,'暂无已完成');
}
function pl(){fetch(H+'/api').then(function(r){return r.json()}).then(rd).catch(function(){})}

buildCols();
pl();
setInterval(pl,POLL_MS);
