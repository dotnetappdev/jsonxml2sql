// Utilities module
(function(){
  'use strict';
  function debounce(fn, wait){ let t; return function(){ clearTimeout(t); t = setTimeout(fn, wait); }; }
  function isPlainObject(o){ return o && typeof o === 'object' && !Array.isArray(o); }
  function rowishToObject(v){ if (v == null) return {}; if (Array.isArray(v)) return { value: v.map(rowishToObject) }; if (typeof v === 'object') return v; return { value: v }; }
  function uniqueKeys(rows){ const set = new Set(); for (const r of rows || []) for (const k of Object.keys(r || {})) set.add(k); return Array.from(set.values()); }
  function safeJsonParse(text){ try { return JSON.parse(text); } catch { return null; } }
  function getByPath(obj, path){ if(path==='*' || path==null) return obj; if (typeof path !== 'string') return undefined; const parts=path.split('.'); let cur=obj; for (const p of parts){ if (cur==null) return undefined; if (/^\d+$/.test(p)){ cur = cur[Number(p)]; continue; } if (Object.prototype.hasOwnProperty.call(cur, p)){ cur=cur[p]; continue; } const lc=p.toLowerCase(); const found=Object.keys(cur).find(k=>k.toLowerCase()===lc); cur = found!==undefined ? cur[found] : undefined; } return cur; }
  // expose
  window.debounce = debounce;
  window.isPlainObject = isPlainObject;
  window.rowishToObject = rowishToObject;
  window.uniqueKeys = uniqueKeys;
  window.safeJsonParse = safeJsonParse;
  window.getByPath = getByPath;
})();
