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

  // Bring in shared utilities from data-utils.js
  const { rowishToObject, uniqueKeys, getByPath, debounce, isPlainObject, safeJsonParse } = window;

  // Expose runtime state (for debugging/inspection)
  window.loadedRows = loadedRows;
  window.loadedRoot = loadedRoot;
  window.currentFromSource = currentFromSource;
  window.lastQueryRows = lastQueryRows;

  // Theme moved to data-theme.js; initTheme and initThemeSwitch provided globally.

  // ---- Utils (moved to data-utils.js globals) ----

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

  // ---- Type inference for code generation ----
  function inferDataType(values) {
    // Analyze sample values to infer the best data type
    const nonNullValues = values.filter(v => v != null);
    if (nonNullValues.length === 0) return { sql: 'VARCHAR(255)', csharp: 'string?' };
    
    // Check if all are integers
    const allIntegers = nonNullValues.every(v => 
      typeof v === 'number' && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647
    );
    if (allIntegers) return { sql: 'INT', csharp: 'int' };
    
    // Check if all are numbers (including decimals)
    const allNumbers = nonNullValues.every(v => typeof v === 'number' && isFinite(v));
    if (allNumbers) return { sql: 'DECIMAL(18,2)', csharp: 'decimal' };
    
    // Check if all are booleans
    const allBooleans = nonNullValues.every(v => typeof v === 'boolean');
    if (allBooleans) return { sql: 'BIT', csharp: 'bool' };
    
    // Check if all are dates (ISO strings)
    const allDates = nonNullValues.every(v => 
      typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)
    );
    if (allDates) return { sql: 'DATETIME2', csharp: 'DateTime' };
    
    // Default to string, but determine length
    const maxLength = Math.max(...nonNullValues.map(v => String(v).length));
    const sqlType = maxLength <= 50 ? `VARCHAR(${Math.max(50, maxLength)})` : 
                   maxLength <= 255 ? `VARCHAR(${maxLength})` : 'TEXT';
    
    return { sql: sqlType, csharp: 'string' };
  }

  function analyzeTableFields(rows) {
    // Get all unique field names and analyze their types
    const fields = uniqueKeys(rows);
    const fieldTypes = {};
    
    for (const field of fields) {
      const values = rows.map(row => row[field]);
      fieldTypes[field] = inferDataType(values);
    }
    
    return fieldTypes;
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
      function parseOnRef(){
        // Expect alias '.' name[.more]
        const alias = eat('ident').value;
        eat('op','.');
        let name = eat('ident').value;
        while (peek() && peek().type==='op' && peek().value==='.'){
          eat('op','.');
          name += '.' + eat('ident').value;
        }
        return { alias, path: name };
      }
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
  if (tok.type==='kw') throw new Error(`Invalid token in WHERE: unexpected keyword '${tok.value}'`);
  throw new Error(`Invalid token in WHERE near '${tok.value ?? tok.type}'`);
      }
      function cmp(){ let l=primary(); if(peek()&&peek().type==='op'&&['=','!=','>','<','>=','<='].includes(peek().value)){ const op=eat('op').value; const r=primary(); return {type:'cmp', op, left:l, right:r}; } return l; }
      function and(){ let l=cmp(); while(peek()&&peek().type==='kw'&&peek().value==='AND'){ eat('kw','AND'); l={type:'and', left:l, right:cmp()}; } return l; }
      function or(){ let l=and(); while(peek()&&peek().type==='kw'&&peek().value==='OR'){ eat('kw','OR'); l={type:'or', left:l, right:and()}; } return l; }
      return or();
    }
    const ast = parseSelect(); while (i<t.length && t[i].type==='op' && t[i].value===';') i++; if (i!==t.length) throw new Error('Unexpected extra tokens'); return ast;
  }

  function compare(a, op, b){ switch(op){ case '=': return a===b; case '!=': return a!==b; case '>': return a>b; case '>=': return a>=b; case '<': return a<b; case '<=': return a<=b; default: return false; } }
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

  // ---- Designer (Join UI) ----
  const designerState = { links: [], dragging: null, tableOrder: [], selectedFields: {}, isFreshLoad: false, output: { active: false, columns: [], includedTables: new Set() } };

  // ---- Output panel helpers ----
  let outputMonaco = null;
  let designerSqlPreview = null;
  function ensureOutputMonaco(){
    try {
      if (outputMonaco || !window.__loadMonaco) return;
      window.__loadMonaco(function(monaco){
        const host = document.getElementById('outputMonaco');
        if (!host) return;
        outputMonaco = monaco.editor.create(host, {
          value: '', language: 'sql', readOnly: true, automaticLayout: true,
          fontSize: 14, minimap: {enabled:false}, lineNumbers: 'on', roundedSelection: false,
          theme: 'vs-dark', wordWrap: 'off', scrollBeyondLastLine: false
        });
      });
    } catch {}
  }
  function updateOutputPreview(sql){ try { if (outputMonaco) outputMonaco.setValue(sql || ''); } catch {} }
  // Read-only SQL preview above the Designer tab
  function ensureDesignerSqlPreview(){
    try {
      if (designerSqlPreview || !window.__loadMonaco) return;
      window.__loadMonaco(function(monaco){
        const host = document.getElementById('sqlPreviewMonaco');
        if (!host) return;
        designerSqlPreview = monaco.editor.create(host, {
          value: '', language: 'sql', readOnly: true, automaticLayout: true,
          fontSize: 14, minimap: {enabled:false}, lineNumbers: 'on', roundedSelection: false,
          theme: 'vs-dark', wordWrap: 'off', scrollBeyondLastLine: false
        });
        try { if (monacoEditor) designerSqlPreview.setValue(monacoEditor.getValue()); } catch {}
      });
    } catch {}
  }
  function updateDesignerSqlPreview(sql){ try { if (designerSqlPreview) designerSqlPreview.setValue(sql || ''); } catch {} }
  // Persist/restore output designer state
  function persistOutputState(){
    try {
      const key = 'jsonxml2sql_output_columns';
      const cols = Array.isArray(designerState.output.columns) ? designerState.output.columns : [];
      const tables = Array.from(designerState.output.includedTables || []);
      localStorage.setItem(key, JSON.stringify({ columns: cols, tables }));
    } catch {}
  }
  function loadPersistedOutputState(ctx){
    try {
      const raw = localStorage.getItem('jsonxml2sql_output_columns');
      if (!raw) return false;
      const saved = JSON.parse(raw);
      const savedCols = Array.isArray(saved?.columns) ? saved.columns : [];
      const savedTables = Array.isArray(saved?.tables) ? new Set(saved.tables) : new Set();
      // Filter to current tables and still-selected fields
      const nextCols = [];
      const seen = new Set();
      for (const it of savedCols){
        if (!it || !it.table || !it.col) continue;
        if (!ctx || !ctx.tables || !ctx.tables.has(it.table)) continue;
        const sel = (designerState.selectedFields||{})[it.table];
        if (!sel || !sel.has(it.col)) continue;
        const k = it.table + '|' + it.col;
        if (seen.has(k)) continue;
        seen.add(k);
        nextCols.push({ table: it.table, col: it.col });
      }
      designerState.output.columns = nextCols;
      // Included tables = intersection with present tables
      const included = new Set();
      for (const t of savedTables){ if (ctx && ctx.tables && ctx.tables.has(t)) included.add(t); }
      designerState.output.includedTables = included;
      return true;
    } catch { return false; }
  }
  function addOutputField(tablePath, col){
    const k = tablePath + '|' + col;
    const exists = (designerState.output.columns||[]).some(it=> (it.table + '|' + it.col) === k);
    if (!exists){ designerState.output.columns.push({ table: tablePath, col }); persistOutputState(); }
  }
  function normalizeOutputColumns(){
    try{
      const next = [];
      const seen = new Set();
      for (const it of (designerState.output.columns||[])){
        if (!it || !it.table || !it.col) continue;
        const k = it.table + '|' + it.col;
        if (seen.has(k)) continue;
        seen.add(k);
        next.push({ table: it.table, col: it.col });
      }
      designerState.output.columns = next;
    } catch {}
  }
  // Shared join/base/alias context for use across builder and UI
  function computeSqlCtx(){
    let base = null;
    if (designerState.links.length){ base = designerState.links[0].leftTable; }
    const selectedTables = Object.entries(designerState.selectedFields||{})
      .filter(([_,set])=> set && (set.size||0)>0).map(([p])=>p);
    const allTables = collectRootArrays().map(t=>t.name);
    if (!base){ base = (selectedTables.length===1 ? selectedTables[0] : (allTables[0] || 'data')); }
    const hasJoins = designerState.links.length > 0;
    const tables = new Map();
    const aliasSeq = 'abcdefghijklmnopqrstuvwxyz';
    function aliasFor(path){ if (!tables.has(path)){ const a = aliasSeq[tables.size]; tables.set(path, a); } return tables.get(path); }
    if (hasJoins){ aliasFor(base); for (const l of designerState.links){ aliasFor(l.leftTable); aliasFor(l.rightTable); } }
    const baseAlias = hasJoins ? aliasFor(base) : null;
    return { base, hasJoins, tables, aliasFor, baseAlias };
  }
  function showOutputPanel(){
    const panel = document.getElementById('designerOutputPanel');
    if (!panel) return;
    panel.classList.add('show');
    panel.style.display = 'block';
    ensureOutputMonaco();
  }
  function refreshOutputTableSelectors(ctx){
    try{
      const addSel = document.getElementById('designerOutputAddSel');
      const remSel = document.getElementById('designerOutputRemoveSel');
      if (!addSel || !remSel) return;
      const present = Array.from((ctx && ctx.tables) ? ctx.tables.keys() : []);
      const included = new Set(Array.from(designerState.output.includedTables || []));
      const notIncluded = present.filter(t=>!included.has(t));
      addSel.innerHTML = '';
      notIncluded.forEach(t=>{ const o=document.createElement('option'); o.value=t; o.textContent=tableDisplayName(t); addSel.appendChild(o); });
      remSel.innerHTML = '';
      Array.from(included).forEach(t=>{ const o=document.createElement('option'); o.value=t; o.textContent=tableDisplayName(t); remSel.appendChild(o); });
    } catch {}
  }
  function renderOutputList(ctx){
    try {
  let ul = document.getElementById('outputList'); if (!ul) return;
  const fresh = ul.cloneNode(false);
  ul.parentNode.replaceChild(fresh, ul);
  ul = fresh;
      const aliasFor = ctx && ctx.aliasFor ? ctx.aliasFor : ((p)=>p.split('.').pop());
      for (const item of designerState.output.columns){
        // Only render items for tables still present
        if (!ctx || !ctx.tables || !ctx.tables.has(item.table)) continue;
        const li = document.createElement('li');
        li.dataset.table = item.table; li.dataset.col = item.col;
  const h = document.createElement('span'); h.className = 'output-handle'; h.title = 'Drag to reorder';
  const label = document.createElement('span');
  const full = `${aliasFor(item.table)}.${item.col}`;
  label.textContent = full;
  li.title = full;
        li.appendChild(h); li.appendChild(label);
        ul.appendChild(li);
      }
      enableOutputReorder(ul);
    } catch {}
  }
  // Output card inside the designer canvas, behaves like a table with reordering
  function renderOutputCard(ctx){
    try {
      const host = document.getElementById('designerTables'); if (!host) return;
      let card = host.querySelector('.designer-table[data-path="__output__"]');
      if (!card){
        card = document.createElement('div'); card.className='designer-table'; card.dataset.path='__output__';
        const head = document.createElement('div'); head.className='dt-head';
        const title = document.createElement('div'); title.className='dt-title'; title.textContent='output'; head.appendChild(title);
        const body = document.createElement('div'); body.className='dt-body';
        const ul = document.createElement('ul'); ul.className='dt-fields'; ul.id='outputDtList'; body.appendChild(ul);
        card.appendChild(head); card.appendChild(body);
        host.appendChild(card);
        // Position
        const key='jsonxml2sql_dt_pos___output__';
        let pos=null; try{ const raw=localStorage.getItem(key); if (raw) pos=JSON.parse(raw);}catch{}
        if (pos){ card.style.left=(pos.left||0)+'px'; card.style.top=(pos.top||0)+'px'; }
        else {
          const others = Array.from(host.querySelectorAll('.designer-table:not([data-path="__output__"])'));
          let maxLeft=10; for (const t of others){ const l=parseInt(t.style.left||'0',10)||0; if (l>maxLeft) maxLeft=l; }
          card.style.left = (maxLeft + 320) + 'px'; card.style.top = '20px';
        }
        makeTableDraggable(card, head, key);
      }
  let ul = card.querySelector('#outputDtList'); if (!ul) return;
  // Replace with a fresh node to drop old listeners and state
  const fresh = ul.cloneNode(false);
  ul.parentNode.replaceChild(fresh, ul);
  ul = fresh;
      for (const item of designerState.output.columns){
        // keep only fields from still-present tables and still-selected
        if (!ctx || !ctx.tables || !ctx.tables.has(item.table)) continue;
        const sel = (designerState.selectedFields||{})[item.table];
        if (!sel || !sel.has(item.col)) continue;
        const li = document.createElement('li'); li.dataset.table=item.table; li.dataset.col=item.col;
        const h = document.createElement('span'); h.className='dt-handle'; h.title='Drag to reorder';
        const label = document.createElement('span'); label.className='designer-field';
        const fullName = `${tableDisplayName(item.table)}.${item.col}`;
        label.textContent = fullName;
        li.title = fullName;
        li.appendChild(h); li.appendChild(label);
        ul.appendChild(li);
      }
  enableOutputCardReorder(ul);
    } catch {}
  }
  function enableOutputCardReorder(ulEl){
  if (ulEl.__dndBound) return; // avoid duplicate bindings
  ulEl.__dndBound = true;
  // Clean any stray placeholders
  try { ulEl.querySelectorAll('.dt-placeholder').forEach(n=>n.remove()); } catch {}
    let draggingEl=null, startY=0, placeholder=null, isDragging=false, pending=false;
    const threshold=4;
    const startDrag=()=>{
      if (isDragging || !draggingEl) return;
      isDragging = true;
      draggingEl.classList.add('dragging');
      // Only create one placeholder
      placeholder = ulEl.querySelector('li.dt-placeholder') || document.createElement('li');
      if (!placeholder.classList.contains('dt-placeholder')){
        placeholder.style.height=draggingEl.getBoundingClientRect().height+'px';
        placeholder.className='dt-placeholder';
        draggingEl.parentNode.insertBefore(placeholder, draggingEl.nextSibling);
      }
    };
    const onDown=(e)=>{
      if (e.button!==0) return; // left click only
      const li = e.target.closest('li'); if (!li) return;
      draggingEl = li; startY=e.clientY; pending=true; isDragging=false; placeholder=null;
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
    };
    const onMove=(e)=>{
      if (!draggingEl) return;
      const dy=e.clientY-startY;
      if (!isDragging){ if (!pending || Math.abs(dy) < threshold) return; startDrag(); }
      draggingEl.style.transform=`translateY(${dy}px)`;
      const siblings=Array.from(ulEl.querySelectorAll('li:not(.dragging)'));
      for (const sib of siblings){
        const rect=sib.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height/2){ ulEl.insertBefore(placeholder, sib); break; }
        if (sib===siblings[siblings.length-1]) ulEl.appendChild(placeholder);
      }
    };
    const cleanup=()=>{
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      draggingEl=null; startY=0; pending=false; isDragging=false; placeholder=null;
    };
    const onUp=()=>{
      if (!draggingEl){ cleanup(); return; }
      if (!isDragging){ // click without dragging
        cleanup(); return;
      }
      draggingEl.classList.remove('dragging'); draggingEl.style.transform='';
      if (placeholder){ ulEl.insertBefore(draggingEl, placeholder); placeholder.remove(); }
      const next=Array.from(ulEl.querySelectorAll('li')).map(li=>({table:li.dataset.table, col:li.dataset.col}));
      designerState.output.columns=next; normalizeOutputColumns();
      try{ persistOutputState(); }catch{}
      syncSqlFromDesigner();
      cleanup();
    };
    ulEl.addEventListener('mousedown', onDown);
  }
  function enableOutputReorder(ulEl){
  if (ulEl.__dndBound) return; // avoid duplicate bindings
  ulEl.__dndBound = true;
  try { ulEl.querySelectorAll('.dt-placeholder').forEach(n=>n.remove()); } catch {}
    let draggingEl=null, startY=0, placeholder=null, isDragging=false, pending=false;
    const threshold=4;
    const startDrag=()=>{
      if (isDragging || !draggingEl) return;
      isDragging = true;
      draggingEl.classList.add('dragging');
      placeholder = ulEl.querySelector('li.dt-placeholder') || document.createElement('li');
      if (!placeholder.classList.contains('dt-placeholder')){
        placeholder.style.height = draggingEl.getBoundingClientRect().height + 'px';
        placeholder.className = 'dt-placeholder';
        draggingEl.parentNode.insertBefore(placeholder, draggingEl.nextSibling);
      }
    };
    const onDown=(e)=>{
      if (e.button!==0) return;
      const li = e.target.closest('li');
      if (!li) return;
      draggingEl = li; startY = e.clientY; pending=true; isDragging=false; placeholder=null;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
    const onMove=(e)=>{
      if (!draggingEl) return;
      const dy = e.clientY - startY;
      if (!isDragging){ if (!pending || Math.abs(dy) < threshold) return; startDrag(); }
      draggingEl.style.transform = `translateY(${dy}px)`;
      const siblings = Array.from(ulEl.querySelectorAll('li:not(.dragging)'));
      for (const sib of siblings){
        const rect = sib.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height/2){ ulEl.insertBefore(placeholder, sib); break; }
        if (sib === siblings[siblings.length-1]) ulEl.appendChild(placeholder);
      }
    };
    const cleanup=()=>{
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      draggingEl=null; startY=0; pending=false; isDragging=false; placeholder=null;
    };
    const onUp=()=>{
      if (!draggingEl){ cleanup(); return; }
      if (!isDragging){ cleanup(); return; }
      draggingEl.classList.remove('dragging'); draggingEl.style.transform='';
      if (placeholder){ ulEl.insertBefore(draggingEl, placeholder); placeholder.remove(); }
      // Persist the new output order in memory
      const next = Array.from(ulEl.querySelectorAll('li')).map(li=>({ table: li.dataset.table, col: li.dataset.col }));
      designerState.output.columns = next;
      normalizeOutputColumns();
      try{ persistOutputState(); }catch{}
      syncSqlFromDesigner();
      cleanup();
    };
    ulEl.addEventListener('mousedown', onDown);
  }
  function addOutputTable(tablePath){
    try{
      const set = getSelectedSet(tablePath); if (!set || set.size===0) return;
      const order = loadFieldOrder(tablePath, Array.from(set));
      const seen = new Set((designerState.output.columns||[]).map(it=>it.table+'|'+it.col));
      for (const c of order){
        if (!set.has(c)) continue;
        const k = tablePath + '|' + c;
        if (seen.has(k)) continue;
        designerState.output.columns.push({ table: tablePath, col: c });
        seen.add(k);
      }
      designerState.output.includedTables.add(tablePath);
  normalizeOutputColumns();
      persistOutputState();
    } catch {}
  }
  function removeOutputTable(tablePath){
    try{ designerState.output.columns = designerState.output.columns.filter(it=>it.table!==tablePath); designerState.output.includedTables.delete(tablePath); persistOutputState(); } catch {}
  }
  function ensureOutputInitialized(ctx){
    if (!designerState.output.active){
      designerState.output.active = true;
      designerState.output.columns = [];
      designerState.output.includedTables = new Set();
      // Try to restore persisted ordering first
      const restored = loadPersistedOutputState(ctx);
      if (!restored){
        // Default columns = all selected fields from present tables in their per-table order (deduped)
        const nextCols = [];
        const seen = new Set();
        if (ctx && ctx.tables){
          for (const path of ctx.tables.keys()){
            const set = (designerState.selectedFields||{})[path];
            if (!set || set.size===0) continue;
            const order = loadFieldOrder(path, Array.from(set));
            for (const c of order){
              if (!set.has(c)) continue;
              const k = path + '|' + c;
              if (seen.has(k)) continue;
              seen.add(k);
              nextCols.push({ table: path, col: c });
            }
            designerState.output.includedTables.add(path);
          }
        }
        designerState.output.columns = nextCols;
        persistOutputState();
      }
    }
  }
  function getSelectedSet(path){
    // Load persisted selections from localStorage
    if (!designerState.selectedFields[path]){
      try {
        const key = 'jsonxml2sql_designer_sel_' + path;
        const raw = localStorage.getItem(key);
        const arr = raw ? JSON.parse(raw) : [];
        designerState.selectedFields[path] = new Set(Array.isArray(arr) ? arr : []);
      } catch {
        designerState.selectedFields[path] = new Set();
      }
    }
    return designerState.selectedFields[path];
  }
  function persistSelectedSet(path){
    try {
      const key = 'jsonxml2sql_designer_sel_' + path;
      const set = designerState.selectedFields[path] || new Set();
      localStorage.setItem(key, JSON.stringify(Array.from(set)));
    } catch {}
  }
  function refreshDesignerVisibility(){
    const hint = document.getElementById('designerEmptyHint');
    const wrap = document.getElementById('designer');
    const tables = collectRootArrays();
    if (!wrap) return;
    const multi = tables.length >= 2;
    if (hint) hint.classList.toggle('show', !multi);
    wrap.classList.toggle('disabled', !multi);
  }
  function tableDisplayName(path){ return (path||'').replace(/^data\./,''); }
  function uniqueScalarKeys(rows){ const keys = new Set(); for (const r of rows||[]){ for (const [k,v] of Object.entries(r||{})){ if (v==null || typeof v!=='object') keys.add(k); } } return Array.from(keys.values()); }
  function getTableRows(path){ const g = collectRootArrays().find(x=>x.name===path); return g? g.rows: []; }
  function loadFieldOrder(path, cols){
    try {
      const raw = localStorage.getItem('jsonxml2sql_dt_order_' + path);
      if (!raw) return cols;
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved) || !saved.length) return cols;
      const set = new Set(cols);
      const ordered = saved.filter(c=>set.has(c));
      const rest = cols.filter(c=>!ordered.includes(c));
      return [...ordered, ...rest];
    } catch { return cols; }
  }
  function persistFieldOrder(path, cols){
    try { localStorage.setItem('jsonxml2sql_dt_order_' + path, JSON.stringify(cols)); } catch {}
  }
  function renderDesignerTables(){
    const host = document.getElementById('designerTables'); if (!host) return;
    const tables = collectRootArrays();
  host.innerHTML = '';
  designerState.tableOrder = tables.map(t=>t.name);
    for (const t of tables){
      const card = document.createElement('div'); card.className='designer-table'; card.dataset.path = t.name;
  const head = document.createElement('div'); head.className='dt-head';
      const title = document.createElement('div'); title.className='dt-title'; title.textContent = tableDisplayName(t.name);
      head.appendChild(title);
      card.appendChild(head);
      const body = document.createElement('div'); body.className='dt-body';
      const ul = document.createElement('ul'); ul.className='dt-fields';
      let cols = uniqueScalarKeys(t.rows);
      cols = loadFieldOrder(t.name, cols);
      const selSet = getSelectedSet(t.name);
      for (const c of cols){
        const li = document.createElement('li');
        li.dataset.col = c;
        // Row drag handle
        const handle = document.createElement('span');
        handle.className = 'dt-handle';
        handle.title = 'Drag to reorder';
        // Big checkbox to include field in SELECT list
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'designer-field-check';
        check.title = 'Include in SELECT';
        // Show unchecked on first load of new data; otherwise reflect persisted selections
        check.checked = (!designerState.isFreshLoad) && selSet.has(c);
        check.addEventListener('change', ()=>{
          designerState.isFreshLoad = false;
          if (check.checked) selSet.add(c); else selSet.delete(c);
          persistSelectedSet(t.name);
          // Keep output card aligned with current selections
          if (designerState.output && designerState.output.active){
            if (check.checked){
              try { addOutputField(t.name, c); } catch { /* fallback: no-op */ }
            } else {
              designerState.output.columns = designerState.output.columns.filter(it=> !(it.table===t.name && it.col===c));
              try { persistOutputState(); } catch {}
            }
            renderOutputCard(computeSqlCtx());
          }
          syncSqlFromDesigner();
        });
        const pinLeft = document.createElement('span'); pinLeft.className='designer-field-pin pin-left'; pinLeft.title='Drag to link';
        pinLeft.dataset.table = t.name; pinLeft.dataset.col = c; pinLeft.dataset.side = 'left';
        pinLeft.addEventListener('mousedown', (e)=>startLinkDrag(e, pinLeft));
        const label = document.createElement('span'); label.className='designer-field'; label.textContent = c;
        const pinRight = document.createElement('span'); pinRight.className='designer-field-pin pin-right'; pinRight.title='Drag to link';
        pinRight.dataset.table = t.name; pinRight.dataset.col = c; pinRight.dataset.side = 'right';
        pinRight.addEventListener('mousedown', (e)=>startLinkDrag(e, pinRight));
  // Order: handle, left pin, checkbox, label, right pin
  li.appendChild(handle);
  li.appendChild(pinLeft);
  li.appendChild(check);
  li.appendChild(label);
  li.appendChild(pinRight);
        ul.appendChild(li);
      }
  body.appendChild(ul); card.appendChild(body);
  // Enable drag reordering
  enableRowReorder(ul, t.name);

      // Positioning: restore from localStorage or lay out in a horizontal row
      const key = 'jsonxml2sql_dt_pos_' + t.name;
      let pos = null; try { const raw = localStorage.getItem(key); if (raw) pos = JSON.parse(raw); } catch {}
      const index = tables.findIndex(x=>x.name===t.name);
      const baseX = 20 + index * 320; // 280 width + ~40 gap
      const baseY = 20 + (index % 2) * 40; // slight stagger
      const x = Math.max(0, Math.min(baseX, Math.max(0, (document.getElementById('designerCanvas')?.clientWidth||1000) - 300)));
      const y = Math.max(0, Math.min(baseY, Math.max(0, (document.getElementById('designerCanvas')?.clientHeight||500) - 200)));
  let left = (pos && Number.isFinite(pos.left)) ? pos.left : x;
  let top = (pos && Number.isFinite(pos.top)) ? pos.top : y;
  const cw0 = document.getElementById('designerCanvas')?.clientWidth || 1000;
  const ch0 = document.getElementById('designerCanvas')?.clientHeight || 500;
  left = Math.max(0, Math.min(left, Math.max(0, cw0 - 300)));
  top = Math.max(0, Math.min(top, Math.max(0, ch0 - 120)));
  card.style.left = left + 'px';
  card.style.top = top + 'px';

      // Make draggable via header
      makeTableDraggable(card, head, key);

      host.appendChild(card);
    }
  // Render output card when active
  try { if (designerState.output && designerState.output.active) renderOutputCard(computeSqlCtx()); } catch {}
  drawAllLinks();
  }
  // In-list drag-and-drop reordering for field rows
  function enableRowReorder(ulEl, tablePath){
    let draggingEl = null; let startY=0; let placeholder = null;
    const rows = Array.from(ulEl.children);
    const onDown = (e)=>{
      const handle = e.target.closest('.dt-handle');
      if (!handle) return;
      const li = handle.closest('li');
      draggingEl = li; startY = e.clientY;
      li.classList.add('dragging');
      placeholder = document.createElement('li');
      placeholder.style.height = li.getBoundingClientRect().height + 'px';
      placeholder.className = 'dt-placeholder';
      li.parentNode.insertBefore(placeholder, li.nextSibling);
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    };
    const onMove = (e)=>{
      if (!draggingEl) return;
      const dy = e.clientY - startY;
      draggingEl.style.transform = `translateY(${dy}px)`;
      // Determine new position relative to siblings
      const siblings = Array.from(ulEl.querySelectorAll('li:not(.dragging)'));
      for (const sib of siblings){
        const rect = sib.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height/2){
          ulEl.insertBefore(placeholder, sib);
          break;
        }
        if (sib === siblings[siblings.length-1]){
          ulEl.appendChild(placeholder);
        }
      }
    };
    const onUp = ()=>{
      if (!draggingEl) return;
      draggingEl.classList.remove('dragging');
      draggingEl.style.transform = '';
      ulEl.insertBefore(draggingEl, placeholder);
      placeholder.remove(); placeholder = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Persist order
      const cols = Array.from(ulEl.querySelectorAll('li')).map(li=>li.dataset.col).filter(Boolean);
      persistFieldOrder(tablePath, cols);
  // Rebuild SQL and run automatically
  try { syncSqlFromDesigner(); } catch {}
    };
    ulEl.addEventListener('mousedown', onDown);
  }
  // Dragging per-table with persistent positions
  function makeTableDraggable(card, dragHandle, storageKey){
    let dragging = false; let startX=0, startY=0; let origLeft=0, origTop=0;
    const canvas = document.getElementById('designerCanvas');
    const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
    const onMove = (e)=>{
      if (!dragging) return;
      const dx = e.clientX - startX; const dy = e.clientY - startY;
      const cw = canvas?.clientWidth || 0; const ch = canvas?.clientHeight || 0;
      const newLeft = clamp(origLeft + dx, 0, Math.max(0, cw - card.offsetWidth));
      const newTop = clamp(origTop + dy, 0, Math.max(0, ch - card.offsetHeight));
      card.style.left = newLeft + 'px';
      card.style.top = newTop + 'px';
      drawAllLinks();
    };
    const onUp = ()=>{
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try { const left = parseInt(card.style.left||'0',10)||0; const top = parseInt(card.style.top||'0',10)||0; localStorage.setItem(storageKey, JSON.stringify({left, top})); } catch {}
    };
    dragHandle.addEventListener('mousedown', (e)=>{
      if (e.button!==0) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      origLeft = parseInt(card.style.left||'0',10)||0;
      origTop = parseInt(card.style.top||'0',10)||0;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }
  function svg(){ return document.getElementById('designerSvg'); }
  function svgPointFromElement(el){
    const rect = el.getBoundingClientRect();
    const rootRect = svg().getBoundingClientRect();
    const x = rect.left - rootRect.left + rect.width/2;
    const y = rect.top - rootRect.top + rect.height/2;
    return {x,y};
  }
  function cubicPath(p1, p2){
    const dx = Math.abs(p2.x - p1.x);
    const cx = Math.max(40, dx * 0.5);
    const c1x = p1.x + cx; const c1y = p1.y;
    const c2x = p2.x - cx; const c2y = p2.y;
    return `M ${p1.x} ${p1.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  function drawAllLinks(){
    const s = svg(); if (!s) return; s.innerHTML='';
    for (const l of designerState.links){
      // Choose inside-facing sides based on positions (absolute left) with rect fallback
      const leftCard = document.querySelector(`.designer-table[data-path="${CSS.escape(l.leftTable)}"]`);
      const rightCard = document.querySelector(`.designer-table[data-path="${CSS.escape(l.rightTable)}"]`);
      let aSide = 'right', bSide = 'left';
      if (leftCard && rightCard){
        const lx = parseInt(leftCard.style.left||'0',10) || leftCard.getBoundingClientRect().left;
        const rx = parseInt(rightCard.style.left||'0',10) || rightCard.getBoundingClientRect().left;
        aSide = lx <= rx ? 'right' : 'left';
        bSide = lx <= rx ? 'left' : 'right';
      }
      const a = findPin(l.leftTable, l.leftCol, aSide) || findPin(l.leftTable, l.leftCol);
      const b = findPin(l.rightTable, l.rightCol, bSide) || findPin(l.rightTable, l.rightCol);
      if (!a||!b) continue;
      const p1=svgPointFromElement(a), p2=svgPointFromElement(b);
      const glow=document.createElementNS('http://www.w3.org/2000/svg','path');
      glow.setAttribute('d', cubicPath(p1, p2));
      glow.classList.add('designer-link-glow'); s.appendChild(glow);
      const line=document.createElementNS('http://www.w3.org/2000/svg','path');
      line.setAttribute('d', cubicPath(p1, p2));
      line.classList.add('designer-link-line'); s.appendChild(line);
      if (l.fkSide){
        const badge=document.createElementNS('http://www.w3.org/2000/svg','circle');
        const q = l.fkSide==='left'? p1 : p2;
        badge.setAttribute('cx', String(q.x));
        badge.setAttribute('cy', String(q.y));
        badge.setAttribute('r', '5');
        badge.classList.add('designer-link-end'); s.appendChild(badge);
      }
    }
  }
  function findPin(table, col, preferSide){
    if (preferSide){
      const el = document.querySelector(`.designer-field-pin.pin-${CSS.escape(preferSide)}[data-table="${CSS.escape(table)}"][data-col="${CSS.escape(col)}"]`);
      if (el) return el;
    }
    return document.querySelector(`.designer-field-pin[data-table="${CSS.escape(table)}"][data-col="${CSS.escape(col)}"]`);
  }
  function startLinkDrag(e, pin){
    if (e.button!==0) return; // left only
    const startTable = pin.dataset.table, startCol = pin.dataset.col;
  const s = svg(); const preview = document.createElementNS('http://www.w3.org/2000/svg','line');
  preview.classList.add('designer-link-preview'); s.appendChild(preview);
    const start = svgPointFromElement(pin);
    // Use a path for preview too
    preview.remove();
    const previewPath = document.createElementNS('http://www.w3.org/2000/svg','path');
    previewPath.classList.add('designer-link-preview'); s.appendChild(previewPath);
    const update = (clientX, clientY)=>{ const rect=s.getBoundingClientRect(); const p2={ x: clientX - rect.left, y: clientY - rect.top }; previewPath.setAttribute('d', cubicPath(start, p2)); };
    const move = (ev)=>{ update(ev.clientX, ev.clientY); };
    const up = (ev)=>{
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      previewPath.remove();
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const endPin = target && (target.closest ? target.closest('.designer-field-pin') : null);
      if (!endPin) return;
      const endTable = endPin.dataset.table, endCol = endPin.dataset.col;
      if (endTable===startTable && endCol===startCol) return;
  // Determine direction by table order (left->right) and force INNER join
  const type = 'INNER';
      const order = designerState.tableOrder || [];
      const idxA = order.indexOf(startTable), idxB = order.indexOf(endTable);
      const leftTable = idxA <= idxB ? startTable : endTable;
      const leftCol = idxA <= idxB ? startCol : endCol;
      const rightTable = idxA <= idxB ? endTable : startTable;
      const rightCol = idxA <= idxB ? endCol : startCol;
  designerState.links.push({ type, leftTable, leftCol, rightTable, rightCol, fkSide: null });
      renderDesignerLinks();
      drawAllLinks();
  syncSqlFromDesigner();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    e.preventDefault();
  }
  function removeDesignerLink(idx){ designerState.links.splice(idx,1); renderDesignerLinks(); drawAllLinks(); syncSqlFromDesigner(); }
  function renderDesignerLinks(){
    const host=document.getElementById('designerLinks'); if (!host) return; host.innerHTML='';
    const hasAnySelected = Object.values(designerState.selectedFields||{}).some(set=> set && (set.size||0) > 0);
    if (!designerState.links.length){
      // Only show the empty message if nothing is selected either
      if (!hasAnySelected) host.innerHTML='<div class="muted">No links added.</div>';
      return;
    }
    designerState.links.forEach((lnk, i)=>{
      const div=document.createElement('div'); div.className='designer-link-item';
      const leftTxt=`${tableDisplayName(lnk.leftTable)}.${lnk.leftCol}`;
      const rightTxt=`${tableDisplayName(lnk.rightTable)}.${lnk.rightCol}`;
      const label=document.createElement('span'); label.textContent = `${leftTxt} = ${rightTxt}`; div.appendChild(label);

      // Join type selector
      const joinSel=document.createElement('select'); joinSel.className='lnk-join';
      for (const opt of ['INNER','LEFT','RIGHT','FULL']){ const o=document.createElement('option'); o.value=opt; o.textContent=opt; joinSel.appendChild(o);} joinSel.value = lnk.type || 'INNER';
  joinSel.value = 'INNER';
  joinSel.disabled = true;
  joinSel.addEventListener('change', ()=>{ lnk.type = 'INNER'; drawAllLinks(); syncSqlFromDesigner(); });
      div.appendChild(joinSel);

      // FK side selector
      const fkSel=document.createElement('select'); fkSel.className='lnk-fk';
      const fkOptions=[{v:'',t:'FK: none'},{v:'left',t:'FK: left side'},{v:'right',t:'FK: right side'}];
      for (const {v,t} of fkOptions){ const o=document.createElement('option'); o.value=v; o.textContent=t; fkSel.appendChild(o);} fkSel.value = lnk.fkSide || '';
  fkSel.addEventListener('change', ()=>{ lnk.fkSide = fkSel.value || null; drawAllLinks(); syncSqlFromDesigner(); });
      div.appendChild(fkSel);

      const btn=document.createElement('button'); btn.className='btn'; btn.textContent='Remove'; btn.addEventListener('click', ()=>removeDesignerLink(i)); div.appendChild(btn);
      host.appendChild(div);
    });
  }
  function buildSqlFromDesigner(){
    // Compute join/base/alias context
  const ctx = computeSqlCtx();
    const { base, hasJoins, tables, aliasFor, baseAlias } = ctx;
    const joinClauses = designerState.links.map(l=>{
      const jt = 'INNER JOIN';
      const la = aliasFor(l.leftTable), ra = aliasFor(l.rightTable);
      return `${jt} ${l.rightTable} AS ${ra} ON ${la}.${l.leftCol} = ${ra}.${l.rightCol}`;
    }).join(' ');
    // Build SELECT list from selected fields if any are chosen for tables that are part of the query
    const selectedList = [];
    try {
      if (!designerState.isFreshLoad) {
        if (hasJoins){
          // If output panel is active and has an explicit order, use that
          if (designerState.output && designerState.output.active && Array.isArray(designerState.output.columns) && designerState.output.columns.length){
            const seenSel = new Set();
            for (const item of designerState.output.columns){
              if (!tables.has(item.table)) continue;
              const expr = `${aliasFor(item.table)}.${item.col}`;
              if (seenSel.has(expr)) continue;
              seenSel.add(expr);
              selectedList.push(expr);
            }
          } else {
            for (const [path, set] of Object.entries(designerState.selectedFields || {})){
              if (!tables.has(path)) continue;
              const a = tables.get(path);
              if (!set || (set.size||0)===0) continue;
              const order = loadFieldOrder(path, Array.from(set));
              order.forEach(col=> { if (set.has(col)) selectedList.push(`${a}.${col}`); });
            }
          }
        } else {
          // Single-table mode: include only fields from base, without alias prefix
          const set = (designerState.selectedFields || {})[base];
          if (set && (set.size||0)>0){
            const order = loadFieldOrder(base, Array.from(set));
            order.forEach(col=> { if (set.has(col)) selectedList.push(col); });
          }
        }
      }
    } catch {}
    const selectClause = selectedList.length ? selectedList.join(', ') : '*';
    const sql = hasJoins ? `SELECT ${selectClause} FROM ${base} AS ${baseAlias} ${joinClauses}`.trim() : `SELECT ${selectClause} FROM ${base}`.trim();
    // Keep output UI in sync when active
    try {
  if (designerState.output && designerState.output.active){ renderOutputCard({ tables, aliasFor }); }
    } catch {}
    return sql;
  }
  function syncSqlFromDesigner(){
    try {
      const sql = buildSqlFromDesigner();
      if (monacoEditor){ monacoEditor.setValue(sql); }
      computeAndRun(sql);
  updateOutputPreview(sql);
  updateDesignerSqlPreview(sql);
    } catch {}
  }
  function initDesignerEvents(){
    document.getElementById('designerGenerateSql')?.addEventListener('click', ()=>{
      if (!ensureDataOrWarn()) return;
      const sql = buildSqlFromDesigner();
      if (monacoEditor){ monacoEditor.setValue(sql); }
      computeAndRun(sql);
      document.querySelector('#resultsTabs .tab[data-tab="table"]')?.click();
    });
  document.getElementById('designerClearLinks')?.addEventListener('click', ()=>{ designerState.links.length=0; renderDesignerLinks(); drawAllLinks(); syncSqlFromDesigner(); });
  document.getElementById('designerAddOutput')?.addEventListener('click', ()=>{
    const sqlCtx = computeSqlCtx();
    ensureOutputInitialized(sqlCtx);
    renderOutputCard(sqlCtx);
    syncSqlFromDesigner();
  });
  window.addEventListener('resize', ()=>{ try { drawAllLinks(); } catch {} });
  }

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
  function initMonaco(){ if (!window.__loadMonaco) return; window.__loadMonaco(function(monaco){ monacoEditor = monaco.editor.create(document.getElementById('sqlMonaco'), { value:'SELECT * FROM data LIMIT 100', language:'sql', automaticLayout:true, fontSize:14, minimap:{enabled:false}, lineNumbers:'on', roundedSelection:false, theme:'vs-dark', wordWrap:'off', scrollBeyondLastLine:false }); monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, function(){ document.getElementById('runSqlBtn').click(); }); const keywords=['SELECT','FROM','WHERE','AND','OR','ORDER','BY','ASC','DESC','LIMIT','OFFSET','TRUE','FALSE','NULL','JOIN','LEFT','RIGHT','INNER','FULL','OUTER','ON','AS','GROUP']; monaco.languages.registerCompletionItemProvider('sql',{ provideCompletionItems:()=>{ let fromSource='data'; try{ const txt=monacoEditor.getValue(); const m=txt.match(/\bFROM\s+([A-Za-z0-9_\.]+)/i); if (m && m[1]) fromSource=m[1]; } catch {} const fromOptions=computeFromCandidates(); const fromItems=fromOptions.map(o=>({label:o.label, kind:monaco.languages.CompletionItemKind.Module, insertText:o.label, detail:o.detail })); const baseRows=resolveSourceRows(fromSource); const scopedFields=uniqueKeys(baseRows); const fieldItems=[...new Set(scopedFields).values()].map(f=>({label:f, kind:monaco.languages.CompletionItemKind.Field, insertText:f})); const kwItems=keywords.map(k=>({label:k, kind:monaco.languages.CompletionItemKind.Keyword, insertText:k})); return { suggestions:[...kwItems, ...fromItems, ...fieldItems] }; } }); try{ monacoEditor.onDidChangeModelContent(()=>{ try{ updateDesignerSqlPreview(monacoEditor.getValue()); }catch{} }); }catch{} }); }

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
  // Mark as fresh load so Designer does not pre-select persisted fields until user interacts
  designerState.isFreshLoad = true;
    window.loadedRows=loadedRows; window.loadedRoot=loadedRoot; window.currentFromSource=currentFromSource;
    const rc=document.getElementById('rowCount'); if (rc) rc.textContent = rows.length + ' rows';
    renderPreview(parsed);
    updateInputInfo();
    if (monacoEditor && !monacoEditor.getValue().trim()) monacoEditor.setValue('SELECT * FROM data LIMIT 100');
    try { populateResultsFilter(); renderMultiFromDataRoot(); renderRaw(collectRootArrays()); } catch { renderTable(rows); renderRaw(rows); }
    buildSourceRadios(parsed);
  // Refresh designer
  try { refreshDesignerVisibility(); renderDesignerTables(); renderDesignerLinks(); } catch {}
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
  // Modal helpers (top-level so all handlers can use them)
  function showModal(message, title='Notice'){
    try{
      const modal=document.getElementById('appModal'); if(!modal) return alert(message);
      modal.classList.remove('hidden');
      const body=document.getElementById('appModalBody'); if(body) body.innerHTML = message;
      const ttl=document.getElementById('appModalTitle'); if(ttl) ttl.textContent = title;
      const onClose=()=>{ modal.classList.add('hidden'); cleanup(); };
      const cleanup=()=>{
        document.getElementById('appModalOk')?.removeEventListener('click', onClose);
        document.getElementById('appModalClose')?.removeEventListener('click', onClose);
      };
      document.getElementById('appModalOk')?.addEventListener('click', onClose);
      document.getElementById('appModalClose')?.addEventListener('click', onClose);
    }catch{ alert(message); }
  }
  function ensureDataOrWarn(){
    try{
      const hasAny = (loadedRows && loadedRows.length) || (Array.isArray(loadedRoot) ? loadedRoot.length : !!loadedRoot);
      if (!hasAny){
        showModal('<p><strong>No data loaded.</strong></p><p>Please paste JSON or XML on the left and click <em>Load</em> before running queries.</p>', 'Data not loaded');
        return false;
      }
      return true;
    } catch { return true; }
  }

  function attachEvents(){
    // Left pane load/clear
    const loadBtn=document.getElementById('loadBtn');
    loadBtn?.addEventListener('click', ()=>{
      const text = document.getElementById('rawInput').value.trim();
      if (!text){
        showModal('<p><strong>Data is required.</strong></p><p>Please paste JSON or XML into the input editor on the left, then click <em>Load</em>.</p>', 'Data required');
        return;
      }
      try {
        loadData(text);
  try { window.gtag && window.gtag('event', 'load_data'); } catch {}
      } catch(e){
        showModal(`<p>${(e && e.message) ? e.message : 'Failed to load data.'}</p>`, 'Load error');
      }
    });
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
  runBtn?.addEventListener('click', ()=>{ if (!ensureDataOrWarn()) return; const sql = monacoEditor ? monacoEditor.getValue() : ''; computeAndRun(sql); try { window.gtag && window.gtag('event', 'run_sql'); } catch {} });
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
      function switchTo(name){
        for (const btn of tabButtons) btn.classList.toggle('active', btn.dataset.tab===name);
        for (const key of Object.keys(panels)) panels[key].classList.toggle('active', key===name);
        localStorage.setItem('jsonxml2sql_results_tab', name);
        if (name==='tree'){
          const panel=document.getElementById('panel-results-table');
          if (panel && panel.classList.contains('multi-table')){
            const all=collectRootArrays(); const sel=document.getElementById('resultsFilter'); const groups=(!sel||!sel.value||sel.value==='ALL')? all : all.filter(g=>g.name===sel.value); try { renderTreeGroups(groups); } catch {}
          } else {
            const rows=lastQueryRows.length ? lastQueryRows : loadedRows; try { renderTree(rows, prettyFromLabel()); } catch {}
          }
        }
      }
    }

    // Editor/Designer tabs (near the SQL editor)
    const editorTabs = document.getElementById('editorTabs');
    if (editorTabs){
      const tabButtons=editorTabs.querySelectorAll('.tab');
      const panels={ 'editor': document.getElementById('panel-editor'), 'designer': document.getElementById('panel-designer') };
      let last = localStorage.getItem('jsonxml2sql_editor_tab') || 'editor';
      switchTo(last);
      for (const btn of tabButtons) btn.addEventListener('click', ()=>{
        const tab = btn.dataset.tab;
  if (btn.id === 'docsTab') {
    const githubDocsUrl = 'https://github.com/dotnetappdev/jsonxml2sql#readme';
    window.open(githubDocsUrl, '_blank', 'noopener');
    return;
  }
        if (!tab || (tab !== 'editor' && tab !== 'designer')) return;
        switchTo(tab);
      });
      function switchTo(name){
        for (const btn of tabButtons) btn.classList.toggle('active', btn.dataset.tab===name);
        for (const key of Object.keys(panels)) panels[key].classList.toggle('active', key===name);
        localStorage.setItem('jsonxml2sql_editor_tab', name);
        if (name==='designer'){
          try { 
            refreshDesignerVisibility(); 
            renderDesignerTables(); 
            renderDesignerLinks(); 
            initDesignerEvents(); 
            const previewWrap = document.getElementById('designerSqlPreview');
            if (previewWrap) previewWrap.classList.remove('hidden');
            ensureDesignerSqlPreview();
            try { if (monacoEditor) updateDesignerSqlPreview(monacoEditor.getValue()); } catch {}
          } catch {}
        } else if (name==='editor'){
          try { if (monacoEditor) monacoEditor.layout(); } catch {}
        }
      }
    }

    // ---- Code generation functions ----
    function generateSQLTable(tableName, rows, options = {}) {
      if (!rows || rows.length === 0) return `-- No data for table ${tableName}`;
      
      const { autoId = true, includeData = false } = options;
      const fieldTypes = analyzeTableFields(rows);
      const fields = Object.keys(fieldTypes);
      
      // Clean table name: remove "data." prefix and convert to TableName format (Pascal case)
      let cleanTableName = tableName.replace(/^data\./, '');
      // Convert to Pascal case: capitalize first letter and letters after underscores, dots, or hyphens
      cleanTableName = cleanTableName.replace(/[^a-zA-Z0-9_]/g, '_') // Replace non-alphanumeric chars with underscores
        .split(/[_\.\-\s]+/) // Split on underscores, dots, hyphens, spaces
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()) // Capitalize each word
        .join(''); // Join without separators for Pascal case
      
      let sql = `-- Create table for ${cleanTableName}\n`;
      sql += `CREATE TABLE ${cleanTableName} (\n`;
      
      // Find primary key fields (only exact field name 'id' case-insensitive) when autoId is enabled
      const idFields = autoId ? fields.filter(field => field.toLowerCase() === 'id') : [];
      
      const fieldDefs = fields.map(field => {
        const cleanField = field.replace(/[^a-zA-Z0-9_]/g, '_');
        const dataType = fieldTypes[field].sql;
        const isIdField = field.toLowerCase() === 'id';
        const isPrimaryKey = autoId && isIdField && idFields.length === 1;
        
        if (isPrimaryKey) {
          return `    ${cleanField} ${dataType} NOT NULL PRIMARY KEY`;
        } else if (autoId && isIdField) {
          return `    ${cleanField} ${dataType} NOT NULL`;
        } else {
          return `    ${cleanField} ${dataType} NULL`;
        }
      });
      
      sql += fieldDefs.join(',\n');
      sql += '\n);\n';
      
      if (includeData && rows.length > 0) {
        sql += `\n-- Insert data for ${cleanTableName}\n`;
        
        const cleanFields = fields.map(field => field.replace(/[^a-zA-Z0-9_]/g, '_'));
        const sqlEscape = (v) => {
          if (v == null) return 'NULL';
          if (typeof v === 'number') return isFinite(v) ? String(v) : 'NULL';
          if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
          if (typeof v === 'object') v = JSON.stringify(v);
          return '\'' + String(v).replace(/'/g, "''") + '\'';
        };
        
        sql += `INSERT INTO ${cleanTableName} (${cleanFields.join(', ')}) VALUES\n`;
        const values = rows.map(row => {
          const vals = fields.map(field => sqlEscape(row[field]));
          return `    (${vals.join(', ')})`;
        });
        sql += values.join(',\n') + ';\n';
      }
      
      return sql;
    }

    function generateDotNetModel(tableName, rows, namespace, usePlural) {
      if (!rows || rows.length === 0) return `// No data for model ${tableName}`;
      
      const fieldTypes = analyzeTableFields(rows);
      const fields = Object.keys(fieldTypes);
      
      // Clean table name and apply naming convention
      let className = tableName.replace(/^data\./, '').replace(/[^a-zA-Z0-9]/g, '');
      className = className.charAt(0).toUpperCase() + className.slice(1);
      
      if (usePlural && !className.endsWith('s')) {
        className += 's';
      } else if (!usePlural && className.endsWith('s') && className.length > 1) {
        className = className.slice(0, -1);
      }
      
      let code = `using System;\nusing System.ComponentModel.DataAnnotations;\n\n`;
      code += `namespace ${namespace}\n{\n`;
      code += `    public class ${className}\n    {\n`;
      
      for (const field of fields) {
        const cleanField = field.replace(/[^a-zA-Z0-9_]/g, '_');
        const propName = cleanField.charAt(0).toUpperCase() + cleanField.slice(1);
        const dataType = fieldTypes[field].csharp;
        const nullable = dataType.includes('?') ? '' : '?';
        
        code += `        public ${dataType}${nullable} ${propName} { get; set; }\n`;
      }
      
      code += `    }\n}\n`;
      return code;
    }

    function generateApplicationDbContext(tableNames, namespace, usePlural) {
      let className = usePlural ? 'DbSet' : 'DbSet';
      let code = `using Microsoft.EntityFrameworkCore;\nusing ${namespace};\n\n`;
      code += `namespace ${namespace}\n{\n`;
      code += `    public class ApplicationDbContext : DbContext\n    {\n`;
      code += `        public ApplicationDbContext(DbContextOptions<ApplicationDbContext> options) : base(options)\n        {\n        }\n\n`;
      
      for (const tableName of tableNames) {
        let cleanName = tableName.replace(/^data\./, '').replace(/[^a-zA-Z0-9]/g, '');
        cleanName = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
        
        if (usePlural && !cleanName.endsWith('s')) {
          cleanName += 's';
        } else if (!usePlural && cleanName.endsWith('s') && cleanName.length > 1) {
          cleanName = cleanName.slice(0, -1);
        }
        
        code += `        public DbSet<${cleanName}> ${cleanName} { get; set; }\n`;
      }
      
      code += `    }\n}\n`;
      return code;
    }

    // Simple JSZip-like functionality using just JavaScript
    function createZipContent(files) {
      // For simplicity, we'll just concatenate files with separators
      // In a real implementation, you'd use JSZip library
      let content = '';
      for (const [filename, fileContent] of Object.entries(files)) {
        content += `\n// ===== ${filename} =====\n`;
        content += fileContent;
        content += `\n// ===== End of ${filename} =====\n`;
      }
      return content;
    }

    function showSQLTablesModal() {
      const modal = document.getElementById('sqlTablesModal');
      if (!modal) return;
      
      modal.classList.remove('hidden');
      document.getElementById('sqlTablesFileName').focus();
      
      const cleanup = () => {
        document.getElementById('sqlTablesSave')?.removeEventListener('click', onSave);
        document.getElementById('sqlTablesCancel')?.removeEventListener('click', onCancel);
        document.getElementById('sqlTablesModalClose')?.removeEventListener('click', onCancel);
      };
      
      const onSave = () => {
        const fileName = document.getElementById('sqlTablesFileName').value.trim();
        const autoId = document.getElementById('sqlTablesAutoId').checked;
        const includeData = document.getElementById('sqlTablesIncludeData').checked;
        
        if (!fileName) return;
        
        const groups = collectRootArrays();
        if (groups.length === 0) {
          showModal('No tables found. Please load JSON or XML data first.', 'No data');
          return;
        }
        
        const options = { autoId, includeData };
        
        if (groups.length === 1) {
          // Single file
          const sql = generateSQLTable(groups[0].name, groups[0].rows, options);
          downloadBlob(sql, fileName, 'text/plain;charset=utf-8');
        } else {
          // Multiple files - create combined content
          const files = {};
          for (const group of groups) {
            const tableName = group.name.replace(/^data\./, '') || 'table';
            files[`${tableName}.sql`] = generateSQLTable(group.name, group.rows, options);
          }
          const zipContent = createZipContent(files);
          const finalFileName = fileName.endsWith('.zip') ? fileName : fileName.replace(/\.[^.]*$/, '') + '_tables.sql';
          downloadBlob(zipContent, finalFileName, 'text/plain;charset=utf-8');
        }
        
        modal.classList.add('hidden');
        cleanup();
      };
      
      const onCancel = () => {
        modal.classList.add('hidden');
        cleanup();
      };
      
      document.getElementById('sqlTablesSave')?.addEventListener('click', onSave);
      document.getElementById('sqlTablesCancel')?.addEventListener('click', onCancel);
      document.getElementById('sqlTablesModalClose')?.addEventListener('click', onCancel);
    }

    function showDotNetModelsModal() {
      const modal = document.getElementById('dotnetModelsModal');
      if (!modal) return;
      
      modal.classList.remove('hidden');
      document.getElementById('dotnetNamespace').focus();
      
      const cleanup = () => {
        document.getElementById('dotnetModelsSave')?.removeEventListener('click', onSave);
        document.getElementById('dotnetModelsCancel')?.removeEventListener('click', onCancel);
        document.getElementById('dotnetModelsModalClose')?.removeEventListener('click', onCancel);
      };
      
      const onSave = () => {
        const namespace = document.getElementById('dotnetNamespace').value.trim();
        const usePlural = document.getElementById('dotnetPlural').checked;
        const generateDbContext = document.getElementById('dotnetDbContext').checked;
        
        if (!namespace) {
          showModal('Please enter a namespace.', 'Namespace required');
          return;
        }
        
        const groups = collectRootArrays();
        if (groups.length === 0) {
          showModal('No tables found. Please load JSON or XML data first.', 'No data');
          return;
        }
        
        const files = {};
        const tableNames = [];
        
        for (const group of groups) {
          const tableName = group.name.replace(/^data\./, '') || 'table';
          tableNames.push(group.name);
          const cleanName = tableName.charAt(0).toUpperCase() + tableName.slice(1).replace(/[^a-zA-Z0-9]/g, '');
          const modelCode = generateDotNetModel(group.name, group.rows, namespace, usePlural);
          files[`${cleanName}.cs`] = modelCode;
        }
        
        if (generateDbContext) {
          const dbContextCode = generateApplicationDbContext(tableNames, namespace, usePlural);
          files['ApplicationDbContext.cs'] = dbContextCode;
        }
        
        if (Object.keys(files).length === 1) {
          // Single file
          const [fileName, content] = Object.entries(files)[0];
          downloadBlob(content, fileName, 'text/plain;charset=utf-8');
        } else {
          // Multiple files - create combined content
          const zipContent = createZipContent(files);
          downloadBlob(zipContent, 'models.cs', 'text/plain;charset=utf-8');
        }
        
        modal.classList.add('hidden');
        cleanup();
      };
      
      const onCancel = () => {
        modal.classList.add('hidden');
        cleanup();
      };
      
      document.getElementById('dotnetModelsSave')?.addEventListener('click', onSave);
      document.getElementById('dotnetModelsCancel')?.addEventListener('click', onCancel);
      document.getElementById('dotnetModelsModalClose')?.addEventListener('click', onCancel);
    }

    // Clear storage & insert generator
    const clearStorageBtn=document.getElementById('clearStorageBtn');
    clearStorageBtn?.addEventListener('click', ()=>{ localStorage.clear(); alert('Local storage cleared.'); });
  const genInsertsBtn=document.getElementById('genInsertsBtn');
  genInsertsBtn?.addEventListener('click', ()=>{ if (!ensureDataOrWarn()) return; const rows=lastQueryRows.length ? lastQueryRows : loadedRows; if (!rows.length){ showModal('No rows to convert. Run a query or load data first.', 'Nothing to export'); return; } const tableName = prompt('Table name for INSERTs:', 'my_table'); if (!tableName) return; const sql = generateInsertSQL(rows, tableName); const rawEl=document.getElementById('resultsRaw'); if (rawEl) rawEl.textContent=sql; document.querySelector('#resultsTabs .tab[data-tab="raw"]')?.click(); });

    // SQL Tables and .NET Models generators
    const genTablesBtn = document.getElementById('genTablesBtn');
    genTablesBtn?.addEventListener('click', () => {
      if (!ensureDataOrWarn()) return;
      showSQLTablesModal();
    });

    const genModelsBtn = document.getElementById('genModelsBtn');
    genModelsBtn?.addEventListener('click', () => {
      if (!ensureDataOrWarn()) return;
      showDotNetModelsModal();
    });

    // Results filter and downloads
    const filter=document.getElementById('resultsFilter');
    filter?.addEventListener('change', ()=>{ renderMultiFromDataRoot(); const treePanel=document.getElementById('panel-results-tree'); if (treePanel && treePanel.classList.contains('active')){ const all=collectRootArrays(); const sel=document.getElementById('resultsFilter'); const groups=(!sel||!sel.value||sel.value==='ALL')? all : all.filter(g=>g.name===sel.value); try { renderTreeGroups(groups); } catch {} } });
  document.getElementById('downloadCsvBtn')?.addEventListener('click', ()=>{ const groups=getFilteredGroups(); const csv=groups.map(g=>`# ${g.name}\n` + toCSV(g.rows)).join('\n\n'); downloadBlob(csv, 'results.csv', 'text/csv;charset=utf-8'); try { window.gtag && window.gtag('event', 'download_csv'); } catch {} });
  }

  function generateInsertSQL(rows, tableName){ const cols=uniqueKeys(rows).sort(); const sqlEscape=(v)=>{ if (v==null) return 'NULL'; if (typeof v==='number') return isFinite(v)? String(v) : 'NULL'; if (typeof v==='boolean') return v? 'TRUE':'FALSE'; if (typeof v==='object') v=JSON.stringify(v); return '\'' + String(v).replace(/'/g, "''") + '\''; }; const header=`INSERT INTO ${tableName} (${cols.join(', ')}) VALUES`; const values=rows.map(r=>`(${cols.map(c=>sqlEscape(r[c])).join(', ')})`); return header + '\n' + values.join(',\n') + ';'; }

  function init(){ attachEvents(); window.initThemeSwitch?.(); initMonaco(); window.initTheme?.(); initParsers(); requestAnimationFrame(()=>{ adjustContentOffset(); alignSqlToolbar(); }); window.addEventListener('resize', debounce(()=>{ adjustContentOffset(); alignSqlToolbar(); drawAllLinks(); },50)); initSplitter(); }
  // Update footer year on DOMContentLoaded as part of init
  const _setFooterYear = () => { try { const el=document.getElementById('footerYear'); if (el) el.textContent = String(new Date().getFullYear()); } catch {} };
  document.addEventListener('DOMContentLoaded', _setFooterYear);
  document.addEventListener('DOMContentLoaded', init);
})();


