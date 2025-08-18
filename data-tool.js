// JSON/XML to SQL tool – clean rebuild
(function () {
  'use strict';

  // ---- Global state ----
  let parseMode = (localStorage.getItem('jsonxml2sql_parse') || 'auto');
  if (parseMode === 'html') parseMode = 'auto';
  let loadedRows = [];
  let loadedRoot = null;
  let loadedMeta = { source: 'json' };
  let currentFromSource = 'data';
  let lastQueryRows = [];
  let monacoEditor = null;

  // Expose core helpers/state
  window.rowishToObject = rowishToObject;
  window.uniqueKeys = uniqueKeys;
  window.getByPath = getByPath;
  window.loadedRows = loadedRows;
  window.loadedRoot = loadedRoot;
  window.currentFromSource = currentFromSource;
  window.lastQueryRows = lastQueryRows;

  // ---- Theme ----
  function initTheme() {
    const root = document.documentElement;
    const saved = localStorage.getItem('jsonxml2sql_theme') || 'light';
    root.classList.toggle('theme-light', saved === 'light');
    root.classList.toggle('theme-dark', saved === 'dark');
    const sw = document.getElementById('themeSwitch');
    const label = document.querySelector('.theme-toggle-label');
    if (sw) {
      sw.setAttribute('data-on', String(saved === 'dark'));
      sw.setAttribute('aria-checked', String(saved === 'dark'));
    }
    if (label) label.textContent = saved === 'dark' ? 'Dark mode' : 'Light mode';
  }
  function initThemeSwitch() {
    const themeSwitch = document.getElementById('themeSwitch'); if (!themeSwitch) return;
    const toolbar = document.getElementById('mainToolbar');
    const apply = (on) => {
      const root = document.documentElement;
      localStorage.setItem('jsonxml2sql_theme', on ? 'dark' : 'light');
      root.classList.toggle('theme-dark', on);
      root.classList.toggle('theme-light', !on);
      themeSwitch.setAttribute('data-on', on ? 'true' : 'false');
      themeSwitch.setAttribute('aria-checked', on ? 'true' : 'false');
      toolbar?.classList.toggle('dark', on);
      toolbar?.querySelector('.brand-title')?.classList.toggle('dark', on);
      toolbar?.querySelector('.brand-desc')?.classList.toggle('dark', on);
      toolbar?.querySelector('.theme-toggle-label')?.classList.toggle('dark', on);
    };
    const isOn = (localStorage.getItem('jsonxml2sql_theme') || 'light') === 'dark';
    apply(isOn);
    themeSwitch.addEventListener('click', () => apply(themeSwitch.getAttribute('data-on') !== 'true'));
    themeSwitch.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); apply(themeSwitch.getAttribute('data-on') !== 'true'); } });
  }

  // ---- Utils ----
  function debounce(fn, wait) { let t; return function () { clearTimeout(t); t = setTimeout(fn, wait); }; }
  function isPlainObject(o) { return o && typeof o === 'object' && !Array.isArray(o); }
  function rowishToObject(v) { if (v == null) return {}; if (Array.isArray(v)) return { value: v.map(rowishToObject) }; if (typeof v === 'object') return v; return { value: v }; }
  function uniqueKeys(rows) { const set = new Set(); for (const r of rows || []) for (const k of Object.keys(r || {})) set.add(k); return Array.from(set.values()); }
  function safeJsonParse(text) { try { return JSON.parse(text); } catch { return null; } }

  function xmlToJson(xmlText) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'application/xml');
      if (doc.querySelector('parsererror')) return null;
      const toObj = (el) => {
        if (el.nodeType !== 1) return null;
        const obj = {};
        for (const a of el.attributes || []) obj[a.name] = a.value;
        const children = Array.from(el.children || []);
        if (!children.length) {
          const t = el.textContent?.trim();
          if (t && Object.keys(obj).length === 0) return t; // primitive leaf
          if (t) obj['#text'] = t;
          return obj;
        }
        const groups = children.reduce((acc, c) => { (acc[c.tagName] ||= []).push(c); return acc; }, {});
        for (const [tag, els] of Object.entries(groups)) obj[tag] = els.length > 1 ? els.map(toObj) : toObj(els[0]);
        return obj;
      };
      const rootEl = doc.documentElement;
      const res = toObj(rootEl);
      return res && typeof res === 'object' && !Array.isArray(res) ? res : { [rootEl.tagName]: res };
    } catch { return null; }
  }

  function flatten(parsed) {
    if (Array.isArray(parsed)) return parsed.map(rowishToObject);
    if (isPlainObject(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) return v.map(rowishToObject);
        if (isPlainObject(v)) for (const [kk, vv] of Object.entries(v)) if (Array.isArray(vv)) return vv.map(rowishToObject);
      }
      return [rowishToObject(parsed)];
    }
    return [rowishToObject(parsed)];
  }

  function renderPreview(obj) { const prev = document.getElementById('preview'); if (!prev) return; try { prev.textContent = JSON.stringify(obj, null, 2); } catch { prev.textContent = String(obj); } }
  function updateInputInfo() {
    try {
      const info=document.getElementById('inputInfo'); if (!info) return;
      const groups = collectRootArrays();
      const tableCount = groups.length;
      const rowCountTotal = groups.reduce((a,g)=>a + (g.rows?.length||0), 0);
      const src = (loadedMeta.source||'json').toUpperCase();
      info.textContent = tableCount
        ? `Loaded ${tableCount} table(s) and ${rowCountTotal} row(s) from ${src}. Query using FROM data or data.<path>.`
        : `Loaded 0 table(s) from ${src}.`;
    } catch {}
  }

  // ---- SQL engine ----
  function tokenize(sql) {
    const tokens = []; let i = 0;
    const isWS = (c) => /\s/.test(c), isDigit = (c) => /[0-9]/.test(c), isStart = (c)=>/[A-Za-z_]/.test(c), isIdent=(c)=>/[A-Za-z0-9_]/.test(c);
    while (i < sql.length) {
      const c = sql[i];
      if (isWS(c)) { i++; continue; }
      if (c === '\'' || c === '"') { const q=c; i++; let s=''; while (i<sql.length && sql[i]!==q){ if(sql[i]==='\\'&&i+1<sql.length){s+=sql[i+1]; i+=2; continue;} s+=sql[i++]; } i++; tokens.push({type:'string', value:s}); continue; }
      if (isDigit(c) || (c==='.' && isDigit(sql[i+1]||''))) { let n=c; i++; while (i<sql.length && /[0-9\.]/.test(sql[i])) n+=sql[i++]; tokens.push({type:'number', value: parseFloat(n)}); continue; }
      if (isStart(c)) { let id=c; i++; while (i<sql.length && isIdent(sql[i])) id+=sql[i++]; const kw=id.toUpperCase(); const kws=['SELECT','FROM','WHERE','AND','OR','ORDER','BY','ASC','DESC','LIMIT','OFFSET','TRUE','FALSE','NULL','JOIN','LEFT','RIGHT','INNER','FULL','OUTER','ON','AS','GROUP']; if (kws.includes(kw)) tokens.push({type:'kw', value:kw}); else tokens.push({type:'ident', value:id}); continue; }
      const two = sql.slice(i,i+2); if(['>=','<=','!='].includes(two)){ tokens.push({type:'op', value:two}); i+=2; continue; }
      if ('=><(),.*;'.includes(c)) { tokens.push({type:'op', value:c}); i++; continue; }
      throw new Error('Unexpected character: ' + c);
    }
    return tokens;
  }

  function parse(sql) {
    sql = sql.replace(/\.(WHERE|ORDER|LIMIT|OFFSET)\b/gi, ' $1');
    const t = tokenize(sql); let i=0; const peek=()=>t[i]; const eat=(type,val)=>{ const tok=t[i++]; if(!tok||tok.type!==type||(val&&tok.value!==val)) throw new Error('Expected ' + (val||type)); return tok; };
    function parseSelect(){
      function parseDottedName(){
        const first = eat('ident').value;
        let name = first;
        while (peek() && peek().type==='op' && peek().value=== '.'){
          eat('op','.');
          name += '.' + eat('ident').value;
        }
        return name;
      }
      eat('kw','SELECT');
      const cols=[];
      function parseCol(){
        if (peek() && peek().type==='op' && peek().value==='*'){ eat('op','*'); return {kind:'star'}; }
        if (peek() && peek().type==='ident' && t[i+1] && t[i+1].type==='op' && t[i+1].value==='('){
          const func=eat('ident').value.toUpperCase(); eat('op','(');
          let arg=null; if (peek() && peek().type==='op' && peek().value==='*'){ eat('op','*'); arg={kind:'star'}; } else { let p=eat('ident').value; while (peek()&&peek().type==='op'&&peek().value==='.'){ eat('op','.'); p += '.' + eat('ident').value; } arg={kind:'ident', name:p}; }
          eat('op',')'); let alias=null; if (peek()&&peek().type==='kw'&&peek().value==='AS'){ eat('kw','AS'); alias=eat('ident').value; }
          return {kind:'agg', func, arg, alias};
        }
        const idTok=eat('ident'); let name=idTok.value;
        if (peek() && peek().type==='op' && peek().value=== '.'){
          eat('op','.'); if (peek()&&peek().type==='op'&&peek().value==='*'){ eat('op','*'); return {kind:'wild', base:name}; }
          name = name + '.' + eat('ident').value; while (peek()&&peek().type==='op'&&peek().value=== '.'){ eat('op','.'); if (peek()&&peek().type==='op'&&peek().value==='*'){ eat('op','*'); return {kind:'wild', base:name}; } name += '.' + eat('ident').value; }
        }
        let alias=null; if (peek()&&peek().type==='kw'&&peek().value==='AS'){ eat('kw','AS'); alias=eat('ident').value; }
        return {kind:'ident', name, alias};
      }
      cols.push(parseCol()); while (peek()&&peek().value===','){ eat('op',','); cols.push(parseCol()); }
      eat('kw','FROM'); const source=parseDottedName(); let sourceAlias=null; if (peek()&&peek().type==='kw'&&peek().value==='AS'){ eat('kw','AS'); sourceAlias=eat('ident').value; } else if (peek()&&peek().type==='ident'){ sourceAlias=eat('ident').value; }
      const joins=[]; let where=null, order=null, limit=null, offset=null, groupBy=null;
      function parseOnRef(){ const id=eat('ident').value; const parts=id.split('.'); if (parts.length<2) throw new Error('Use alias.field'); const alias=parts.shift(); return {alias, path:parts.join('.')}; }
      while (peek() && peek().type==='kw' && ['JOIN','LEFT','RIGHT','INNER','FULL'].includes(peek().value)){
        let jtype='INNER'; if (peek().value==='LEFT' || peek().value==='RIGHT' || peek().value==='FULL'){ jtype=eat('kw').value; if (peek()&&peek().type==='kw'&&peek().value==='OUTER') eat('kw','OUTER'); eat('kw','JOIN'); } else if (peek().value==='INNER'){ eat('kw','INNER'); eat('kw','JOIN'); } else { eat('kw','JOIN'); }
        const jsource=parseDottedName(); let jalias=null; if (peek()&&peek().type==='kw'&&peek().value==='AS'){ eat('kw','AS'); jalias=eat('ident').value; } else if (peek()&&peek().type==='ident'){ jalias=eat('ident').value; }
        eat('kw','ON'); const left=parseOnRef(); const op=eat('op').value; if (op!=='=') throw new Error('Only equality ON supported'); const right=parseOnRef();
        joins.push({type:jtype, source: jsource, alias: jalias, on:{left, right}});
      }
      while (peek() && peek().type==='kw'){
        if (peek().value==='WHERE' && !where){ eat('kw','WHERE'); where=parseExpr(); continue; }
        if (peek().value==='GROUP' && !groupBy){ eat('kw','GROUP'); eat('kw','BY'); const cols=[]; cols.push(parseDottedName()); while (peek()&&peek().type==='op'&&peek().value===','){ eat('op',','); cols.push(parseDottedName()); } groupBy=cols; continue; }
        if (peek().value==='ORDER' && !order){ eat('kw','ORDER'); eat('kw','BY'); const col=parseDottedName(); let dir='ASC'; if (peek()&&peek().type==='kw'&&(peek().value==='ASC'||peek().value==='DESC')) dir=eat('kw').value; order={col, dir}; continue; }
        if (peek().value==='LIMIT' && limit==null){ eat('kw','LIMIT'); limit=eat('number').value; continue; }
        if (peek().value==='OFFSET' && offset==null){ eat('kw','OFFSET'); offset=eat('number').value; continue; }
        break;
      }
      return { type:'select', cols, source, sourceAlias, joins, where, order, groupBy, limit, offset };
    }
    function parseExpr(){
      function primary(){
        const tok=peek(); if(!tok) throw new Error('Unexpected end of WHERE');
        if(tok.type==='number'||tok.type==='string'){ i++; return {type:'lit', value:tok.value}; }
        if(tok.type==='kw'&&(tok.value==='TRUE'||tok.value==='FALSE'||tok.value==='NULL')){ i++; return {type:'lit', value: tok.value==='TRUE'?true: tok.value==='FALSE'?false:null}; }
        if(tok.type==='ident'){
          // Support dotted identifiers in WHERE, e.g., a.id or data.users.id
          i++; let name = tok.value; while (peek() && peek().type==='op' && peek().value==='.') { eat('op','.'); name += '.' + eat('ident').value; }
          return {type:'col', name};
        }
        if(tok.type==='op'&&tok.value==='('){ i++; const e=parseExpr(); eat('op',')'); return e; }
        throw new Error('Invalid token');
      }
      function cmp(){ let l=primary(); if(peek()&&peek().type==='op'&&['=','!=','>','<','>=','<='].includes(peek().value)){ const op=eat('op').value; const r=primary(); return {type:'cmp', op, left:l, right:r}; } return l; }
      function and(){ let l=cmp(); while(peek()&&peek().type==='kw'&&peek().value==='AND'){ eat('kw','AND'); l={type:'and', left:l, right:cmp()}; } return l; }
      function or(){ let l=and(); while(peek()&&peek().type==='kw'&&peek().value==='OR'){ eat('kw','OR'); l={type:'or', left:l, right:and()}; } return l; }
      return or();
    }
    const ast = parseSelect(); while (i<t.length && t[i].type==='op' && t[i].value===';') i++; if (i!==t.length) throw new Error('Unexpected extra tokens'); return ast;
  }

  function compare(a, op, b){ switch(op){ case '=': return a===b; case '!=': return a!==b; case '>': return a>b; case '>=': return a>=b; case '<': return a<b; case '<=': return a<=b; default: return false; } }
  function getByPath(obj, path){ if(path==='*' || path==null) return obj; if (typeof path !== 'string') return undefined; const parts=path.split('.'); let cur=obj; for (const p of parts){ if (cur==null) return undefined; if (/^\d+$/.test(p)){ cur = cur[Number(p)]; continue; } if (Object.prototype.hasOwnProperty.call(cur, p)){ cur=cur[p]; continue; } const lc=p.toLowerCase(); const found=Object.keys(cur).find(k=>k.toLowerCase()===lc); cur = found!==undefined ? cur[found] : undefined; } return cur; }
  function evalExpr(expr,row,scopePrefix){ switch(expr.type){ case 'lit': return expr.value; case 'col': { let path=expr.name; if (path==='data') return row; if (path.startsWith('data.')) path=path.slice(5); if (scopePrefix && path.startsWith(scopePrefix + '.')) path = path.slice(scopePrefix.length+1); return getByPath(row, path); } case 'cmp': return compare(evalExpr(expr.left,row,scopePrefix), expr.op, evalExpr(expr.right,row,scopePrefix)); case 'and': return !!(evalExpr(expr.left,row,scopePrefix) && evalExpr(expr.right,row,scopePrefix)); case 'or': return !!(evalExpr(expr.left,row,scopePrefix) || evalExpr(expr.right,row,scopePrefix)); default: return null; } }

  function resolveSourceRows(source){ const _rows = loadedRows; const _root = loadedRoot; if (!source || source==='data') return _rows; if (!_root) return _rows; const val = getByPath({data:_root}, source); if (typeof val === 'undefined') return []; if (Array.isArray(val)) return val.map(rowishToObject); if (isPlainObject(val)){ for (const k of Object.keys(val)) if (Array.isArray(val[k])) return val[k].map(rowishToObject); return [rowishToObject(val)]; } return [{ value: val }]; }

  function execute(ast, baseRows){
    let out = baseRows.slice();
    if (ast.joins && ast.joins.length){
      const primaryAlias = ast.sourceAlias || (ast.source ? ast.source.split('.').pop() : 'a') || 'a';
      let current = out.map(r => ({ __aliases: { [primaryAlias]: r } }));
      for (const j of ast.joins){
        const rightRows = resolveSourceRows(j.source);
        const rightAlias = j.alias || (j.source ? j.source.split('.').pop() : undefined) || ('b' + Math.random().toString(36).slice(2,5));
        const matched = []; const matchedRight = new Set();
        const leftAliasKeys = Object.keys(current[0]?.__aliases || {});
        for (let li=0; li<current.length; li++){
          const left = current[li]; let any=false;
          for (let ri=0; ri<rightRows.length; ri++){
            const rrow = rightRows[ri];
            const lval = getByPath(left.__aliases[j.on.left.alias] || {}, j.on.left.path);
            const rval = getByPath(rrow, j.on.right.path);
            const eq=(a,b)=>{ if (a===b) return true; if (a==null || b==null) return false; const an=Number(a), bn=Number(b); if (Number.isFinite(an) && Number.isFinite(bn)) return an===bn; return String(a)===String(b); };
            if (eq(lval, rval)) { any=true; matchedRight.add(ri); matched.push({ __aliases: { ...left.__aliases, [rightAlias]: rrow } }); }
          }
          if (!any && (j.type==='LEFT' || j.type==='FULL')) matched.push({ __aliases: { ...left.__aliases, [rightAlias]: undefined } });
        }
        if (j.type==='RIGHT' || j.type==='FULL'){
          for (let ri=0; ri<rightRows.length; ri++) if (!matchedRight.has(ri)){
            const base={}; for (const k of leftAliasKeys) base[k]=undefined; base[rightAlias]=rightRows[ri]; matched.push({ __aliases: base });
          }
        }
        current = matched;
      }
      out = current.map(item => { const aliases=item.__aliases || {}; const pa = ast.sourceAlias || (ast.source ? ast.source.split('.').pop() : 'a') || 'a'; const r={}; for (const [k,v] of Object.entries(aliases)) r[k]=v; if (aliases[pa] && typeof aliases[pa]==='object') Object.assign(r, aliases[pa]); return r; });
    }
    let scopePrefix=''; if (ast.source && ast.source.startsWith('data.')) scopePrefix = ast.source.slice(5);
    if (ast.where) out = out.filter(r => !!evalExpr(ast.where, r, scopePrefix));
    if (ast.groupBy && ast.groupBy.length){
      const groups = new Map();
      for (const r of out){ const keyValues = ast.groupBy.map(g=>getByPath(r,g)); const key=JSON.stringify(keyValues); let b=groups.get(key); if(!b){ b={rows:[], keyValues}; groups.set(key,b);} b.rows.push(r); }
      const aggOut=[]; for (const {rows: bucketRows, keyValues} of groups.values()){
        const o={};
        for (const c of ast.cols){
          if (c.kind==='agg'){
            const outKey = c.alias || `${c.func}(${c.arg && c.arg.kind==='ident' ? c.arg.name : '*'})`;
            let vals; if (!c.arg || c.arg.kind==='star') vals=bucketRows; else vals = bucketRows.map(r=>getByPath(r, c.arg.name)).filter(v=>v!=null);
            switch (c.func){
              case 'COUNT': o[outKey] = (c.arg && c.arg.kind==='star') ? bucketRows.length : vals.filter(v=>v!=null).length; break;
              case 'SUM': o[outKey] = vals.reduce((a,b)=> a + (isFinite(Number(b))? Number(b):0), 0); break;
              case 'MIN': o[outKey] = vals.reduce((a,b)=> a==null? Number(b): Math.min(a, Number(b)), undefined); break;
              case 'MAX': o[outKey] = vals.reduce((a,b)=> a==null? Number(b): Math.max(a, Number(b)), undefined); break;
              case 'AVG': { const n = vals.filter(v=>isFinite(Number(v))).map(Number); o[outKey] = n.length ? (n.reduce((a,b)=>a+b,0)/n.length) : null; break; }
              default: o[outKey] = null;
            }
          } else if (c.kind==='ident'){
            const outKey = c.alias || c.name; const idx = ast.groupBy.findIndex(g=>g===c.name); o[outKey] = idx>=0 ? keyValues[idx] : getByPath(bucketRows[0]||{}, c.name);
          } else if (c.kind==='wild'){
            const obj = getByPath(bucketRows[0]||{}, c.base); if (obj && typeof obj==='object') for (const [k,v] of Object.entries(obj)) o[`${c.base}.${k}`]=v;
          } else if (c.kind==='star'){
            Object.assign(o, bucketRows[0] || {});
          }
        }
        aggOut.push(o);
      }
      out = aggOut;
    }
    if (ast.order){ const {col,dir}=ast.order; out.sort((a,b)=>{ const va=getByPath(a,col), vb=getByPath(b,col); if (va===vb) return 0; return (va>vb?1:-1) * (dir==='DESC'?-1:1); }); }
    if (ast.offset) out = out.slice(ast.offset);
    if (ast.limit!=null) out = out.slice(0, ast.limit);
    // Projection with support for: * , alias.* , data.path.* , plain dotted idents
    if (!(ast.cols.length===1 && ast.cols[0].kind==='star')){
      out = out.map(r=>{ const o={}; for (const c of ast.cols){ if (c.kind==='star'){ Object.assign(o, r); continue; } if (c.kind==='wild'){ let base=c.base; if (base==='data'){ Object.assign(o,r); continue; } if (scopePrefix && base.startsWith(scopePrefix+'.')) base=base.slice(scopePrefix.length+1); const obj=getByPath(r, base); if (obj && typeof obj==='object') for (const [k,v] of Object.entries(obj)) o[`${base}.${k}`]=v; continue; } let p=c.name; if (scopePrefix && p.startsWith(scopePrefix+'.')) p=p.slice(scopePrefix.length+1); const outKey=c.alias||c.name; o[outKey]=getByPath(r,p);} return o; });
    }
    return out;
  }

  // ---- Rendering ----
  function renderTable(rows){ const table=document.getElementById('resultsTable'); if(!table) return; table.innerHTML=''; if(!rows||!rows.length){ table.innerHTML='<thead><tr><th>No rows</th></tr></thead>'; return; } const headers=uniqueKeys(rows); const thead=document.createElement('thead'); const trh=document.createElement('tr'); for (const h of headers){ const th=document.createElement('th'); th.textContent=h; trh.appendChild(th); } thead.appendChild(trh); const tbody=document.createElement('tbody'); for (const r of rows){ const tr=document.createElement('tr'); for (const h of headers){ const td=document.createElement('td'); const v=r[h]; if (v==null) td.textContent=''; else if (typeof v==='object') td.textContent=JSON.stringify(v); else td.textContent=String(v); tr.appendChild(td);} tbody.appendChild(tr);} table.appendChild(thead); table.appendChild(tbody); }
  function renderRaw(rows){ const el=document.getElementById('resultsRaw'); if(!el) return; try{ el.textContent=JSON.stringify(rows,null,2);}catch{ el.textContent=String(rows);} }
  function renderSingleTableView(){ const panel=document.getElementById('panel-results-table'); if(!panel) return; panel.innerHTML='<div class="table-wrap"><table id="resultsTable"></table></div>'; panel.classList.remove('multi-table'); }
  function renderMultiFromDataRoot(){ populateResultsFilter(); const all=collectRootArrays(); const sel=document.getElementById('resultsFilter'); const groups=(!sel||!sel.value||sel.value==='ALL')? all : all.filter(g=>g.name===sel.value); const panel=document.getElementById('panel-results-table'); if(!panel) return; panel.innerHTML=''; panel.classList.add('multi-table'); if (!groups.length){ renderTable([]); return; } for (const g of groups){ const header=document.createElement('h3'); const display=(g.name||'').replace(/^data\./,''); header.innerHTML = `<span class=\"badge\">${g.rows.length} rows<\/span> ${display}`; panel.appendChild(header); const wrap=document.createElement('div'); wrap.className='table-wrap'; const tbl=document.createElement('table'); wrap.appendChild(tbl); panel.appendChild(wrap); const headers=uniqueKeys(g.rows); const thead=document.createElement('thead'); const trh=document.createElement('tr'); for (const h of headers){ const th=document.createElement('th'); th.textContent=h; trh.appendChild(th);} thead.appendChild(trh); const tbody=document.createElement('tbody'); for (const r of g.rows){ const tr=document.createElement('tr'); for (const h of headers){ const td=document.createElement('td'); const v=r[h]; if (v==null) td.textContent=''; else if (typeof v==='object') td.textContent=JSON.stringify(v); else td.textContent=String(v); tr.appendChild(td);} tbody.appendChild(tr);} tbl.appendChild(thead); tbl.appendChild(tbody); const sep=document.createElement('div'); sep.className='separator'; panel.appendChild(sep);} }
  function renderTree(data, rootLabel='root'){ const root=document.getElementById('resultsTree'); if(!root) return; root.innerHTML=''; function node(key,value,parent=''){ const li=document.createElement('li'); const caret=document.createElement('span'); caret.className='caret'; caret.tabIndex=0; const label=document.createElement('span'); label.className='key'; label.textContent=key; li.appendChild(caret); li.appendChild(label); const type = value===null? 'null' : Array.isArray(value)? 'array' : typeof value; const t=document.createElement('span'); t.className='type'; t.textContent=`: ${type}`; li.appendChild(t); if (type==='object' || type==='array'){ const ul=document.createElement('ul'); const entries = Array.isArray(value) ? value.map((v,i)=>[`${parent||key}[${i}]`, v]) : Object.entries(value); for (const [k,v] of entries) ul.appendChild(node(k,v,key)); li.appendChild(ul); li.classList.add('has-children'); const toggle=()=>li.classList.toggle('collapsed'); caret.addEventListener('click', toggle); caret.addEventListener('keydown', (e)=>{ if (e.key==='Enter' || e.key===' '){ e.preventDefault(); toggle(); } }); } else { const vv=document.createElement('span'); vv.textContent = ` = ${String(value)}`; li.appendChild(vv); } return li; } const ul=document.createElement('ul'); ul.appendChild(node(rootLabel, data)); root.appendChild(ul); }
  function renderTreeGroups(groups){ const root=document.getElementById('resultsTree'); if(!root) return; root.innerHTML=''; function node(key,value,parent=''){ const li=document.createElement('li'); const caret=document.createElement('span'); caret.className='caret'; caret.tabIndex=0; const label=document.createElement('span'); label.className='key'; label.textContent=key; li.appendChild(caret); li.appendChild(label); const type = value===null? 'null' : Array.isArray(value)? 'array' : typeof value; const t=document.createElement('span'); t.className='type'; t.textContent=`: ${type}`; li.appendChild(t); if (type==='object' || type==='array'){ const ul=document.createElement('ul'); const entries = Array.isArray(value) ? value.map((v,i)=>[`${parent||key}[${i}]`, v]) : Object.entries(value); for (const [k,v] of entries) ul.appendChild(node(k,v,key)); li.appendChild(ul); li.classList.add('has-children'); const toggle=()=>li.classList.toggle('collapsed'); caret.addEventListener('click', toggle); caret.addEventListener('keydown', (e)=>{ if (e.key==='Enter' || e.key===' '){ e.preventDefault(); toggle(); } }); } else { const vv=document.createElement('span'); vv.textContent = ` = ${String(value)}`; li.appendChild(vv); } return li; } const ul=document.createElement('ul'); for (const g of groups){ const name=(g.name||'').replace(/^data\./,''); ul.appendChild(node(name, g.rows)); } root.appendChild(ul); }
  function prettyFromLabel(){ try{ if(!currentFromSource || currentFromSource==='data') return 'data'; if (currentFromSource.startsWith('data.')) return currentFromSource.slice(5); return currentFromSource; } catch { return 'data'; } }

  function adjustContentOffset(){ try{ const toolbar=document.getElementById('mainToolbar'); const main=document.querySelector('.app-main'); if(!toolbar||!main) return; const h=toolbar.getBoundingClientRect().height; main.style.paddingTop = h + 'px'; } catch {} }
  function alignSqlToolbar(){
    try{
      const toolbar=document.getElementById('mainToolbar');
      const bar=document.getElementById('sqlToolbar');
      const target=document.getElementById('sqlMonaco');
      if(!toolbar||!bar||!target) return;
      const tb=toolbar.getBoundingClientRect();
      const tg=target.getBoundingClientRect();
      const branding=toolbar.querySelector('.branding');
      const brandRect = branding ? branding.getBoundingClientRect() : null;
      const brandRight = brandRect ? brandRect.right : tb.left;
      // Desired: nav left align with sqlMonaco left
      const desired = tg.left - brandRight;
      bar.style.marginLeft = Math.max(0, Math.round(desired)) + 'px';
    } catch {}
  }

  // ---- Data discovery & downloads ----
  function collectRootArrays(){ const _root=loadedRoot; if (!_root || (typeof _root !== 'object' && !Array.isArray(_root))) return []; const out=[]; const seen=new Set(); function push(name, arr){ const key=name + '|' + arr.length; if (seen.has(key)) return; out.push({ name, rows: arr.map(rowishToObject) }); seen.add(key); } function visit(node, path){ if (Array.isArray(node)){ push(path||'data', node); node.forEach((el,i)=>visit(el, path + '['+i+']')); return; } if (node && typeof node==='object'){ for (const [k,v] of Object.entries(node)){ const p = path ? path + '.' + k : k; if (Array.isArray(v)) push(p, v); visit(v, p); } } } visit(_root, 'data'); out.sort((a,b)=> a.name.split('.').length - b.name.split('.').length); return out; }
  function getFilteredGroups(){ const panel=document.getElementById('panel-results-table'); if (panel && !panel.classList.contains('multi-table')){ const rows = lastQueryRows && lastQueryRows.length ? lastQueryRows : loadedRows; return [{ name:'results', rows }]; } const groups=collectRootArrays(); const filter=document.getElementById('resultsFilter'); if (!filter || !filter.value || filter.value==='ALL') return groups; return groups.filter(g=>g.name===filter.value); }
  function populateResultsFilter(){ const sel=document.getElementById('resultsFilter'); if(!sel) return; const groups=collectRootArrays(); const cur=sel.value; sel.innerHTML=''; const optAll=document.createElement('option'); optAll.value='ALL'; optAll.textContent='All'; sel.appendChild(optAll); for (const g of groups){ const o=document.createElement('option'); o.value=g.name; o.textContent=g.name; sel.appendChild(o);} sel.value = cur && [...sel.options].some(o=>o.value===cur) ? cur : 'ALL'; }
  function toCSV(rows){ if(!rows||!rows.length) return ''; const cols=uniqueKeys(rows); const esc=(v)=>{ if(v==null) return ''; const s= typeof v==='object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; }; const lines=[cols.join(',')]; for (const r of rows) lines.push(cols.map(c=>esc(r[c])).join(',')); return lines.join('\n'); }
  function escapeXml(s){ return String(s).replace(/[<&>\"]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[ch])); }
  function toExcelXml(groups){ const header=`<?xml version=\"1.0\"?>\n<?mso-application progid=\"Excel.Sheet\"?>\n<Workbook xmlns=\"urn:schemas-microsoft-com:office:spreadsheet\" xmlns:ss=\"urn:schemas-microsoft-com:office:spreadsheet\">`; const footer='</Workbook>'; const sheets=groups.map(g=>{ const rows=g.rows||[]; const cols=uniqueKeys(rows); const rowXml=[]; rowXml.push('<Row>' + cols.map(c=>`<Cell><Data ss:Type=\"String\">${escapeXml(c)}<\/Data><\/Cell>`).join('') + '</Row>'); for (const r of rows) rowXml.push('<Row>' + cols.map(c=>`<Cell><Data ss:Type=\"String\">${escapeXml(r[c]==null? '' : (typeof r[c]==='object'? JSON.stringify(r[c]) : String(r[c])))}</Data><\/Cell>`).join('') + '</Row>'); return `<Worksheet ss:Name=\"${escapeXml(g.name)}\"><Table>${rowXml.join('')}<\/Table><\/Worksheet>`; }).join(''); return header + sheets + footer; }
  function downloadBlob(content, filename, mime){ const blob=new Blob([content], {type:mime}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); },0); }

  // ---- Monaco ----
  function computeFromCandidates(){
    const list=[{label:'FROM data', detail:'Root rows', kind:'root'}];
    const groups = collectRootArrays();
    for (const g of groups) {
      list.push({ label: `FROM ${g.name}`, detail: `${g.rows.length} row array`, kind: 'array' });
    }
    return list;
  }
  function initMonaco(){ if (!window.__loadMonaco) return; window.__loadMonaco(function(monaco){ monacoEditor = monaco.editor.create(document.getElementById('sqlMonaco'), { value:'SELECT * FROM data LIMIT 100', language:'sql', automaticLayout:true, fontSize:14, minimap:{enabled:false}, lineNumbers:'on', roundedSelection:false, theme:'vs-dark', wordWrap:'off', scrollBeyondLastLine:false }); monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, function(){ document.getElementById('runSqlBtn').click(); }); const keywords=['SELECT','FROM','WHERE','AND','OR','ORDER','BY','ASC','DESC','LIMIT','OFFSET','TRUE','FALSE','NULL','JOIN','LEFT','RIGHT','INNER','FULL','OUTER','ON','AS','GROUP']; monaco.languages.registerCompletionItemProvider('sql',{ provideCompletionItems:()=>{ let fromSource='data'; try{ const txt=monacoEditor.getValue(); const m=txt.match(/\bFROM\s+([A-Za-z0-9_\.]+)/i); if (m && m[1]) fromSource=m[1]; } catch {} const fromOptions=computeFromCandidates(); const fromItems=fromOptions.map(o=>({label:o.label, kind:monaco.languages.CompletionItemKind.Module, insertText:o.label, detail:o.detail })); const baseRows=resolveSourceRows(fromSource); const scopedFields=uniqueKeys(baseRows); const fieldItems=[...new Set(scopedFields).values()].map(f=>({label:f, kind:monaco.languages.CompletionItemKind.Field, insertText:f})); const kwItems=keywords.map(k=>({label:k, kind:monaco.languages.CompletionItemKind.Keyword, insertText:k})); return { suggestions:[...kwItems, ...fromItems, ...fieldItems] }; } }); }); }

  // ---- App ----
  function shouldRenderMulti(ast){ try{ const isStar = ast && ast.cols && ast.cols.length===1 && ast.cols[0].kind==='star'; const isRoot = ast && (ast.source==='data' || !ast.source); const okClauses = ast && !ast.where && (!ast.joins || ast.joins.length===0); return Boolean(isStar && isRoot && okClauses); } catch { return false; } }
  function initParsers(){ const container=document.getElementById('parseRadios'); if(!container) return; container.innerHTML=''; const modes=[ {key:'auto', label:'Auto'}, {key:'json', label:'JSON'}, {key:'xml', label:'XML'} ]; for (const m of modes){ const id='parse_'+m.key; const lbl=document.createElement('label'); lbl.innerHTML = `<input type=\"radio\" name=\"parseMode\" value=\"${m.key}\" id=\"${id}\"> ${m.label}`; container.appendChild(lbl);} const saved=parseMode || 'auto'; for (const r of container.querySelectorAll('input[name=\"parseMode\"]')){ r.checked = r.value===saved; r.addEventListener('change', ()=>{ parseMode=r.value; localStorage.setItem('jsonxml2sql_parse', parseMode); }); } }
  function loadData(text){
    const info=document.getElementById('inputInfo');
    let parsed=null; let source='json';
    if (parseMode==='json' || parseMode==='auto') parsed=safeJsonParse(text);
    if (!parsed && (parseMode==='xml' || parseMode==='auto')){ const x=xmlToJson(text); if (x){ parsed=x; source='xml'; } }
    if (!parsed) throw new Error('Input is neither valid JSON nor valid XML');
    const rows=flatten(parsed);
    loadedRows=rows; loadedMeta.source=source; loadedRoot=parsed; currentFromSource='data';
    window.loadedRows=loadedRows; window.loadedRoot=loadedRoot; window.currentFromSource=currentFromSource;
    const rc=document.getElementById('rowCount'); if (rc) rc.textContent = rows.length + ' rows';
    renderPreview(parsed);
    updateInputInfo();
    if (monacoEditor && !monacoEditor.getValue().trim()) monacoEditor.setValue('SELECT * FROM data LIMIT 100');
    try { populateResultsFilter(); renderMultiFromDataRoot(); renderRaw(collectRootArrays()); } catch { renderTable(rows); renderRaw(rows); }
    buildSourceRadios(parsed);
    // Also refresh the SQL status under the editor with total rows across tables
    try { const status=document.getElementById('sqlStatus'); if (status){ const groups=collectRootArrays(); const total=groups.reduce((a,g)=>a+(g.rows?.length||0),0); status.textContent=`${total} row(s)`; } } catch {}
  }
  function buildSourceRadios(_) { /* deprecated no-op */ }
  function initSplitter(){ const bar=document.getElementById('hSplit'); if(!bar) return; let dragging=false, startY=0, startH=0; const root=document.documentElement; const leftTa=document.getElementById('rawInput'); const getCurrent=()=> parseInt(getComputedStyle(document.documentElement).getPropertyValue('--editor-height') || '320', 10) || 320; const setHeight=(px)=>{ const h=Math.max(140, Math.min(700, px)); root.style.setProperty('--editor-height', h + 'px'); try { if (monacoEditor) monacoEditor.layout(); } catch {} if (leftTa) leftTa.style.minHeight = h + 'px'; }; const onMove=(e)=>{ if(!dragging) return; const dy=e.clientY - startY; setHeight(startH + dy); e.preventDefault(); }; const onUp=()=>{ dragging=false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }; bar.addEventListener('mousedown', (e)=>{ dragging=true; startY=e.clientY; startH=getCurrent(); document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp); e.preventDefault(); }); }
  function computeAndRun(sql){
    const status=document.getElementById('sqlStatus');
    try {
      const ast=parse(sql);
      currentFromSource=ast.source || 'data';
      let baseRows=resolveSourceRows(ast.source);
      if ((!baseRows || baseRows.length===0) && Array.isArray(loadedRoot)) baseRows = loadedRows;
      const rows=execute(ast, baseRows);

      // Always reset to single-table view first to clear any previous multi-table layout
      renderSingleTableView();
      // Ensure Table tab is active so users see the combined results
      document.querySelector('#resultsTabs .tab[data-tab="table"]')?.click();

      if (shouldRenderMulti(ast)){
        renderMultiFromDataRoot();
        const all=collectRootArrays();
        try { renderRaw(all); } catch {}
        lastQueryRows = all.flatMap(g=>g.rows);
        window.lastQueryRows = lastQueryRows;
        try { renderTreeGroups(all); } catch {}
      } else {
        renderTable(rows);
        renderRaw(rows);
        lastQueryRows=rows;
        window.lastQueryRows=lastQueryRows;
        try { renderTree(lastQueryRows, prettyFromLabel()); } catch {}
      }
      if (status){
        if (shouldRenderMulti(ast)){
          const total = (collectRootArrays()||[]).reduce((a,g)=>a+(g.rows?.length||0),0);
          status.textContent = `${total} row(s)`;
        } else {
          status.textContent = `${lastQueryRows.length} row(s)`;
        }
      }
    } catch (e){
      if (status) status.textContent = 'Error: ' + e.message;
    }
  }
  function attachEvents(){
    // Left pane load/clear
    const loadBtn=document.getElementById('loadBtn');
    loadBtn?.addEventListener('click', ()=>{ const text=document.getElementById('rawInput').value.trim(); if (!text) return; try { loadData(text); } catch(e){ alert(e.message);} });
    const clearLeftBtn=document.getElementById('clearLeftBtn');
    clearLeftBtn?.addEventListener('click', ()=>{ document.getElementById('rawInput').value=''; const info=document.getElementById('inputInfo'); if (info) info.textContent='No data loaded.'; const prev=document.getElementById('preview'); if (prev) prev.textContent=''; const rc=document.getElementById('rowCount'); if (rc) rc.textContent='0 rows'; loadedRows=[]; window.loadedRows=loadedRows; const status=document.getElementById('sqlStatus'); if (status) status.textContent=''; });

    // Sample buttons
    document.getElementById('sampleJsonBtn')?.addEventListener('click', ()=>{
      document.getElementById('rawInput').value=[ '{', '  "users": [', '    { "id": 1, "name": "Alice" },', '    { "id": 2, "name": "Bob" }', '  ],', '  "orders": [', '    { "orderId": 101, "userId": 1, "amount": 250 },', '    { "orderId": 102, "userId": 2, "amount": 150 }', '  ]', '}' ].join('\n');
    });
    document.getElementById('sampleXmlBtn')?.addEventListener('click', ()=>{
      document.getElementById('rawInput').value=[ '<data>', '  <users>', '    <user id=\"1\" name=\"Alice\"/>', '    <user id=\"2\" name=\"Bob\"/>', '  </users>', '  <orders>', '    <order orderId=\"101\" userId=\"1\" amount=\"250\"/>', '    <order orderId=\"102\" userId=\"2\" amount=\"150\"/>', '  </orders>', '</data>' ].join('\n');
    });
  // No separate toolbar load now; left Load remains

    // Run / Clear SQL
    const runBtn=document.getElementById('runSqlBtn');
    runBtn?.addEventListener('click', ()=>{ const sql = monacoEditor ? monacoEditor.getValue() : ''; computeAndRun(sql); });
    const clearSqlBtn=document.getElementById('clearSqlBtn');
    clearSqlBtn?.addEventListener('click', ()=>{ if (monacoEditor) monacoEditor.setValue(''); const status=document.getElementById('sqlStatus'); if (status) status.textContent=''; renderSingleTableView(); renderTable([]); const rawEl=document.getElementById('resultsRaw'); if (rawEl) rawEl.textContent=''; const treeEl=document.getElementById('resultsTree'); if (treeEl) treeEl.innerHTML=''; const sel=document.getElementById('resultsFilter'); if (sel) sel.value='ALL'; lastQueryRows=[]; window.lastQueryRows=lastQueryRows; });

    // Drag/drop
    const raw=document.getElementById('rawInput');
    if (raw){ ['dragenter','dragover'].forEach(n=>raw.addEventListener(n, e=>{ e.preventDefault(); e.dataTransfer.dropEffect='copy'; })); raw.addEventListener('drop', async (e)=>{ e.preventDefault(); const file=e.dataTransfer.files && e.dataTransfer.files[0]; if (file){ const text=await file.text(); raw.value=text; } }); }

    // Tabs
    const resultsTabs=document.getElementById('resultsTabs');
    if (resultsTabs){
      const tabButtons=resultsTabs.querySelectorAll('.tab');
      const panels={ 'table': document.getElementById('panel-results-table'), 'raw': document.getElementById('panel-results-raw'), 'tree': document.getElementById('panel-results-tree') };
      let lastTab=localStorage.getItem('jsonxml2sql_results_tab') || 'table';
      switchTo(lastTab);
      for (const btn of tabButtons) btn.addEventListener('click', ()=>{ switchTo(btn.dataset.tab); });
      function switchTo(name){ for (const btn of tabButtons) btn.classList.toggle('active', btn.dataset.tab===name); for (const key of Object.keys(panels)) panels[key].classList.toggle('active', key===name); localStorage.setItem('jsonxml2sql_results_tab', name); if (name==='tree'){ const panel=document.getElementById('panel-results-table'); if (panel && panel.classList.contains('multi-table')){ const all=collectRootArrays(); const sel=document.getElementById('resultsFilter'); const groups=(!sel||!sel.value||sel.value==='ALL')? all : all.filter(g=>g.name===sel.value); try { renderTreeGroups(groups); } catch {} } else { const rows=lastQueryRows.length ? lastQueryRows : loadedRows; try { renderTree(rows, prettyFromLabel()); } catch {} } } }
    }

    // Clear storage & insert generator
    const clearStorageBtn=document.getElementById('clearStorageBtn');
    clearStorageBtn?.addEventListener('click', ()=>{ localStorage.clear(); alert('Local storage cleared.'); });
    const genInsertsBtn=document.getElementById('genInsertsBtn');
    genInsertsBtn?.addEventListener('click', ()=>{ const rows=lastQueryRows.length ? lastQueryRows : loadedRows; if (!rows.length){ alert('No rows to convert. Run a query or load data first.'); return; } const tableName = prompt('Table name for INSERTs:', 'my_table'); if (!tableName) return; const sql = generateInsertSQL(rows, tableName); const rawEl=document.getElementById('resultsRaw'); if (rawEl) rawEl.textContent=sql; document.querySelector('#resultsTabs .tab[data-tab="raw"]')?.click(); });

    // Results filter and downloads
    const filter=document.getElementById('resultsFilter');
    filter?.addEventListener('change', ()=>{ renderMultiFromDataRoot(); const treePanel=document.getElementById('panel-results-tree'); if (treePanel && treePanel.classList.contains('active')){ const all=collectRootArrays(); const sel=document.getElementById('resultsFilter'); const groups=(!sel||!sel.value||sel.value==='ALL')? all : all.filter(g=>g.name===sel.value); try { renderTreeGroups(groups); } catch {} } });
    document.getElementById('downloadCsvBtn')?.addEventListener('click', ()=>{ const groups=getFilteredGroups(); const csv=groups.map(g=>`# ${g.name}\n` + toCSV(g.rows)).join('\n\n'); downloadBlob(csv, 'results.csv', 'text/csv;charset=utf-8'); });
    document.getElementById('downloadXlsBtn')?.addEventListener('click', ()=>{ const groups=getFilteredGroups(); const xls=toExcelXml(groups); downloadBlob(xls, 'results.xls', 'application/vnd.ms-excel'); });
  }

  function generateInsertSQL(rows, tableName){ const cols=uniqueKeys(rows).sort(); const sqlEscape=(v)=>{ if (v==null) return 'NULL'; if (typeof v==='number') return isFinite(v)? String(v) : 'NULL'; if (typeof v==='boolean') return v? 'TRUE':'FALSE'; if (typeof v==='object') v=JSON.stringify(v); return '\'' + String(v).replace(/'/g, "''") + '\''; }; const header=`INSERT INTO ${tableName} (${cols.join(', ')}) VALUES`; const values=rows.map(r=>`(${cols.map(c=>sqlEscape(r[c])).join(', ')})`); return header + '\n' + values.join(',\n') + ';'; }

  function init(){ attachEvents(); initThemeSwitch(); initMonaco(); initTheme(); initParsers(); requestAnimationFrame(()=>{ adjustContentOffset(); alignSqlToolbar(); }); window.addEventListener('resize', debounce(()=>{ adjustContentOffset(); alignSqlToolbar(); },50)); initSplitter(); }
  // Update footer year on DOMContentLoaded as part of init
  const _setFooterYear = () => { try { const el=document.getElementById('footerYear'); if (el) el.textContent = String(new Date().getFullYear()); } catch {} };
  document.addEventListener('DOMContentLoaded', _setFooterYear);
  document.addEventListener('DOMContentLoaded', init);
})();


