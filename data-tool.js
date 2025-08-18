// Dark mode toggle logic for custom switch
function initThemeSwitch() {
	const themeSwitch = document.getElementById('themeSwitch');
	const toolbar = document.getElementById('mainToolbar');
	let darkMode = false;
	function setDarkMode(on) {
		darkMode = on;
		themeSwitch.setAttribute('data-on', on ? 'true' : 'false');
		themeSwitch.setAttribute('aria-checked', on ? 'true' : 'false');
		if (on) {
			document.body.classList.add('dark-mode');
			toolbar.classList.add('dark');
			toolbar.querySelector('.brand-title').classList.add('dark');
			toolbar.querySelector('.brand-desc').classList.add('dark');
			toolbar.querySelector('.theme-toggle-label').classList.add('dark');
		} else {
			document.body.classList.remove('dark-mode');
			toolbar.classList.remove('dark');
			toolbar.querySelector('.brand-title').classList.remove('dark');
			toolbar.querySelector('.brand-desc').classList.remove('dark');
			toolbar.querySelector('.theme-toggle-label').classList.remove('dark');
		}
	}
	themeSwitch.addEventListener('click', function() {
		setDarkMode(!darkMode);
	});
	themeSwitch.addEventListener('keydown', function(e) {
		if (e.key === ' ' || e.key === 'Enter') {
			setDarkMode(!darkMode);
			e.preventDefault();
		}
	});
	setDarkMode(false);
}
(function () {
	// ---- State ----
	let loadedRows = []; // Array of objects representing rows
	let loadedMeta = { source: 'none', path: 'data' };
    let loadedRoot = null; // full parsed input for advanced FROM paths
    let monacoEditor = null;
    let lastQueryRows = [];
	let currentSourceKey = 'data';
	let currentFromSource = 'data';
    let parseMode = 'auto'; // auto|json|xml|html

	// ---- Utilities ----
	function safeJsonParse(text) {
		try { return JSON.parse(text); } catch (_) { return null; }
	}
	function htmlToJson(html) {
		const parser = new DOMParser();
		const doc = parser.parseFromString(html, 'text/html');
		function walk(node) {
			if (node.nodeType === 3) {
				const t = node.nodeValue.trim();
				return t ? t : null;
			}
			if (node.nodeType !== 1) return null;
			const obj = { tag: node.tagName.toLowerCase() };
			if (node.attributes && node.attributes.length) {
				obj.attributes = {};
				for (const a of node.attributes) obj.attributes[a.name] = a.value;
			}
			const children = [];
			for (const ch of node.childNodes) {
				const v = walk(ch);
				if (v != null) children.push(v);
			}
			if (children.length) obj.children = children;
			return obj;
		}
		return walk(doc.body) || {};
	}

	function xmlToJson(xmlString) {
		const parser = new DOMParser();
		const doc = parser.parseFromString(xmlString, 'application/xml');
		const err = doc.querySelector('parsererror');
		if (err) return null;
		function elToObj(el) {
			// Gather attributes
			const attrObj = {};
			if (el.attributes) {
				for (const a of el.attributes) attrObj[a.name] = a.value;
			}
			// Group child elements by tag
			const groups = {};
			let textContent = '';
			for (const ch of el.childNodes) {
				if (ch.nodeType === 1) { // ELEMENT
					const k = ch.nodeName;
					(groups[k] ||= []).push(elToObj(ch));
				} else if (ch.nodeType === 3) { // TEXT
					const t = ch.nodeValue.trim();
					if (t) textContent += (textContent ? ' ' : '') + t;
				}
			}
			const out = {};
			// Convert groups to arrays or single objects
			for (const [k, arr] of Object.entries(groups)) {
				out[k] = arr.length === 1 ? arr[0] : arr;
			}
			// Merge attributes
			for (const [k,v] of Object.entries(attrObj)) out[k] = v;
			// If only text and no attributes/children, return the text directly
			if (!Object.keys(out).length && textContent) return textContent;
			// If wrapper element contains a single array child and nothing else, collapse it to that array
			const keys = Object.keys(out);
			if (keys.length === 1 && Array.isArray(out[keys[0]]) && Object.keys(attrObj).length === 0 && !textContent) {
				return out[keys[0]];
			}
			// Otherwise include text as _text if present
			if (textContent) out._text = textContent;
			return out;
		}
		// Return the normalized object for the root element; if it collapses to an array, wrap as { [root.tagName]: array }
		const root = doc.documentElement;
		const normalized = elToObj(root);
		if (Array.isArray(normalized)) return { [root.nodeName]: normalized };
		return normalized;
	}

	function flatten(input) {
		// Attempt to produce an array of row objects from JSON or xml-json
		if (Array.isArray(input)) return input.map(rowishToObject);
		if (isPlainObject(input)) {
			// Find the first array value inside the object to be our rows
			for (const key of Object.keys(input)) {
				if (Array.isArray(input[key])) return input[key].map(rowishToObject);
			}
			// Otherwise treat top-level object as single row
			return [rowishToObject(input)];
		}
		// Fallback: wrap as single value
		return [ { value: input } ];
	}

	function isPlainObject(v) {
		return v !== null && typeof v === 'object' && v.constructor === Object;
	}

	function rowishToObject(v) {
		if (isPlainObject(v)) return v;
		if (Array.isArray(v)) return v.reduce((o, val, i) => { o[i] = val; return o; }, {});
		return { value: v };
	}

	function uniqueKeys(rows) {
		const set = new Set();
		for (const r of rows) for (const k of Object.keys(r)) set.add(k);
		return Array.from(set);
	}

	function renderPreview(obj) {
		const el = document.getElementById('preview');
		if (!el) return;
		try { el.textContent = JSON.stringify(obj, null, 2); }
		catch { el.textContent = String(obj); }
	}

	// ---- SQL-like query engine ----
	// Supports a simple subset:
	// SELECT <cols|*> FROM data [WHERE <expr>] [ORDER BY <col> [ASC|DESC]] [LIMIT n] [OFFSET n]
	// <expr> supports = != > >= < <= AND OR, parentheses, strings in single quotes, numbers, booleans, null

	function tokenize(sql) {
		const tokens = [];
		let i = 0;
		const isIdentStart = c => /[A-Za-z_]/.test(c);
		const isIdent = c => /[A-Za-z0-9_\.]/.test(c);
		while (i < sql.length) {
			const c = sql[i];
			if (/\s/.test(c)) { i++; continue; }
			if (c === '\'' || c === '"') {
				const quote = c; i++; let s = '';
				while (i < sql.length) {
					const ch = sql[i++];
					if (ch === quote) break;
					s += ch;
				}
				tokens.push({ type: 'string', value: s });
				continue;
			}
			if (/[0-9]/.test(c)) {
				let num = c; i++;
				while (i < sql.length && /[0-9\.]/.test(sql[i])) num += sql[i++];
				tokens.push({ type: 'number', value: parseFloat(num) });
				continue;
			}
			if (isIdentStart(c)) {
				let id = c; i++;
				while (i < sql.length && isIdent(sql[i])) id += sql[i++];
				const kw = id.toUpperCase();
				const keywords = ['SELECT','FROM','WHERE','AND','OR','ORDER','BY','ASC','DESC','LIMIT','OFFSET','TRUE','FALSE','NULL','JOIN','LEFT','RIGHT','INNER','ON','AS'];
				if (keywords.includes(kw)) tokens.push({ type: 'kw', value: kw });
				else tokens.push({ type: 'ident', value: id });
				continue;
			}
			const two = sql.slice(i, i+2);
			if (['>=','<=','!='].includes(two)) { tokens.push({ type: 'op', value: two }); i += 2; continue; }
			if ('=><(),.*;'.includes(c)) { tokens.push({ type: 'op', value: c }); i++; continue; }
			throw new Error('Unexpected character: ' + c);
		}
		return tokens;
	}

	function parse(sql) {
		const t = tokenize(sql);
		let i = 0;
		const peek = () => t[i];
		const eat = (type, val) => {
			const tok = t[i++];
			if (!tok || tok.type !== type || (val && tok.value !== val)) throw new Error('Expected ' + (val||type));
			return tok;
		};

		function parseSelect() {
			eat('kw','SELECT');
			let cols = [];
			if (peek() && peek().type === 'op' && peek().value === '*') { eat('op','*'); cols = ['*']; }
			else {
				cols.push(eat('ident').value);
				while (peek() && peek().value === ',') { eat('op',','); cols.push(eat('ident').value); }
			}
			eat('kw','FROM');
			const source = eat('ident').value;
			let sourceAlias = null;
			if (peek() && peek().type === 'kw' && peek().value === 'AS') { eat('kw','AS'); sourceAlias = eat('ident').value; }
			else if (peek() && peek().type === 'ident') { sourceAlias = eat('ident').value; }
			let where = null, order = null, limit = null, offset = null;
			const joins = [];
			function parseOnColumnRef() {
				const id = eat('ident').value; // alias.path
				const parts = id.split('.');
				if (parts.length < 2) throw new Error('Use alias.column in JOIN ON clauses');
				const alias = parts.shift();
				return { alias, path: parts.join('.') };
			}
			while (peek() && peek().type === 'kw' && (peek().value === 'JOIN' || peek().value === 'LEFT' || peek().value === 'RIGHT' || peek().value === 'INNER')) {
				let jtype = 'INNER';
				if (peek().value === 'LEFT' || peek().value === 'RIGHT') { jtype = eat('kw').value; eat('kw','JOIN'); }
				else if (peek().value === 'INNER') { eat('kw','INNER'); eat('kw','JOIN'); }
				else { eat('kw','JOIN'); }
				const jsource = eat('ident').value;
				let jalias = null;
				if (peek() && peek().type === 'kw' && peek().value === 'AS') { eat('kw','AS'); jalias = eat('ident').value; }
				else if (peek() && peek().type === 'ident') { jalias = eat('ident').value; }
				eat('kw','ON');
				const leftRef = parseOnColumnRef();
				const op = eat('op').value;
				if (op !== '=') throw new Error('Only equality ON conditions are supported');
				const rightRef = parseOnColumnRef();
				joins.push({ type: jtype, source: jsource, alias: jalias, on: { left: leftRef, right: rightRef } });
			}
			// Accept clauses in any order following FROM
			while (peek() && peek().type === 'kw') {
				if (peek().value === 'WHERE' && !where) { eat('kw','WHERE'); where = parseExpr(); continue; }
				if (peek().value === 'ORDER' && !order) { eat('kw','ORDER'); eat('kw','BY');
					const col = eat('ident').value; let dir = 'ASC';
					if (peek() && peek().type === 'kw' && (peek().value === 'ASC' || peek().value === 'DESC')) dir = eat('kw').value;
					order = { col, dir }; continue; }
				if (peek().value === 'LIMIT' && limit == null) { eat('kw','LIMIT'); limit = eat('number').value; continue; }
				if (peek().value === 'OFFSET' && offset == null) { eat('kw','OFFSET'); offset = eat('number').value; continue; }
				break;
			}
			return { type: 'select', cols, source, sourceAlias, joins, where, order, limit, offset };
		}

		function parseExpr() {
			function parsePrimary() {
				const tok = peek();
				if (!tok) throw new Error('Unexpected end of WHERE');
				if (tok.type === 'number' || tok.type === 'string') { i++; return { type: 'lit', value: tok.value }; }
				if (tok.type === 'kw' && (tok.value === 'TRUE' || tok.value === 'FALSE' || tok.value === 'NULL')) {
					i++;
					return { type: 'lit', value: tok.value === 'TRUE' ? true : tok.value === 'FALSE' ? false : null };
				}
				if (tok.type === 'ident') { i++; return { type: 'col', name: tok.value }; }
				if (tok.type === 'op' && tok.value === '(') { i++; const e = parseExpr(); eat('op', ')'); return e; }
				throw new Error('Invalid expression token: ' + JSON.stringify(tok));
			}
			function parseComparison() {
				let left = parsePrimary();
				if (peek() && peek().type === 'op' && ['=','!=','>','<','>=','<='].includes(peek().value)) {
					const op = eat('op').value;
					const right = parsePrimary();
					return { type: 'cmp', op, left, right };
				}
				return left;
			}
			function parseAnd() {
				let left = parseComparison();
				while (peek() && peek().type === 'kw' && peek().value === 'AND') { eat('kw','AND'); left = { type: 'and', left, right: parseComparison() }; }
				return left;
			}
			function parseOr() {
				let left = parseAnd();
				while (peek() && peek().type === 'kw' && peek().value === 'OR') { eat('kw','OR'); left = { type: 'or', left, right: parseAnd() }; }
				return left;
			}
			return parseOr();
		}

		const ast = parseSelect();
		// Allow trailing semicolons
		while (i < t.length && t[i].type === 'op' && t[i].value === ';') i++;
		if (i !== t.length) throw new Error('Unexpected extra tokens');
		return ast;
	}

	function evalExpr(expr, row, scopePrefix) {
		switch (expr.type) {
			case 'lit': return expr.value;
			case 'col': {
				let path = expr.name;
				// If the query selected FROM data.foo, scopePrefix will be '' for fields in that row
				// Allow explicit data.* to bypass
				if (path === 'data') return row;
				if (path.startsWith('data.')) path = path.slice(5);
				if (scopePrefix && path.startsWith(scopePrefix + '.')) path = path.slice(scopePrefix.length + 1);
				return getByPath(row, path);
			}
			case 'cmp': return compare(evalExpr(expr.left, row, scopePrefix), expr.op, evalExpr(expr.right, row, scopePrefix));
			case 'and': return !!(evalExpr(expr.left, row, scopePrefix) && evalExpr(expr.right, row, scopePrefix));
			case 'or': return !!(evalExpr(expr.left, row, scopePrefix) || evalExpr(expr.right, row, scopePrefix));
			default: return null;
		}
	}

	function compare(a, op, b) {
		switch (op) {
			case '=': return a === b;
			case '!=': return a !== b;
			case '>': return a > b;
			case '>=': return a >= b;
			case '<': return a < b;
			case '<=': return a <= b;
			default: return false;
		}
	}

	function getByPath(obj, path) {
		// support dot paths: a.b.c, and bracket indices for arrays like a.0.b
		if (path === '*' || !path) return obj;
		const parts = path.split('.');
		let cur = obj;
		for (const p of parts) {
			if (cur == null) return undefined;
			const key = /^\d+$/.test(p) ? Number(p) : p;
			cur = cur[key];
		}
		return cur;
	}

	function execute(ast, rows) {
		let out = rows.slice();
		// JOINs: build a map of alias->dataset
		if (ast.joins && ast.joins.length) {
			const primaryAlias = ast.sourceAlias || (ast.source ? ast.source.split('.').pop() : 'a') || 'a';
			let current = out.map(r => ({ __aliases: { [primaryAlias]: r } }));
			for (const j of ast.joins) {
				const rightRows = resolveSourceRows(j.source);
				const rightAlias = j.alias || (j.source ? j.source.split('.').pop() : undefined) || ('b' + Math.random().toString(36).slice(2,5));
				const matched = [];
				for (const left of current) {
					let any = false;
					for (const r of rightRows) {
						const lval = getByPath(left.__aliases[j.on.left.alias] || {}, j.on.left.path);
						const rval = getByPath(r, j.on.right.path);
						if (lval === rval) {
							any = true;
							matched.push({ __aliases: { ...left.__aliases, [rightAlias]: r } });
						}
					}
					if (!any && j.type === 'LEFT') matched.push(left); // preserve left row
				}
				current = matched;
			}
			// After joins, project back to flat rows by merging aliases
			out = current.map(item => ({ ...item.__aliases[primaryAlias], ...Object.fromEntries(Object.entries(item.__aliases).filter(([k]) => k!==primaryAlias).map(([k,v])=>[k,v])) }));
		}
		// Determine scope prefix for WHERE resolution (e.g., when FROM data.users)
		let scopePrefix = '';
		if (ast.source && ast.source.startsWith('data.')) scopePrefix = ast.source.slice(5);
		if (ast.where) out = out.filter(r => !!evalExpr(ast.where, r, scopePrefix));
		if (ast.order) {
			const { col, dir } = ast.order;
			out.sort((a,b) => {
				const va = getByPath(a, col), vb = getByPath(b, col);
				if (va === vb) return 0;
				return (va > vb ? 1 : -1) * (dir === 'DESC' ? -1 : 1);
			});
		}
		if (ast.offset) out = out.slice(ast.offset);
		if (ast.limit != null) out = out.slice(0, ast.limit);
		// Projection (respect scope prefix)
		if (!(ast.cols.length === 1 && ast.cols[0] === '*')) {
			out = out.map(r => {
				const o = {};
				for (let c of ast.cols) {
					let p = c;
					if (scopePrefix && p.startsWith(scopePrefix + '.')) p = p.slice(scopePrefix.length + 1);
					o[c] = getByPath(r, p);
				}
				return o;
			});
		}
		return out;
	}

	function resolveSourceRows(source) {
		// Accept 'data' or 'data.path.to.array'
		if (!source || source === 'data') return loadedRows;
		if (!loadedRoot) return loadedRows;
		const val = getByPath({ data: loadedRoot }, source);
		if (Array.isArray(val)) return val.map(rowishToObject);
		if (isPlainObject(val)) {
			for (const k of Object.keys(val)) {
				if (Array.isArray(val[k])) return val[k].map(rowishToObject);
			}
			return [rowishToObject(val)];
		}
		return [ { value: val } ];
	}

	// ---- Rendering ----
	function renderTable(rows) {
		const table = document.getElementById('resultsTable');
		table.innerHTML = '';
		if (!rows || rows.length === 0) { table.innerHTML = '<thead><tr><th>No rows</th></tr></thead>'; return; }
		const headers = uniqueKeys(rows);
		const thead = document.createElement('thead');
		const trh = document.createElement('tr');
		for (const h of headers) {
			const th = document.createElement('th'); th.textContent = h; trh.appendChild(th);
		}
		thead.appendChild(trh);
		const tbody = document.createElement('tbody');
		for (const r of rows) {
			const tr = document.createElement('tr');
			for (const h of headers) {
				const td = document.createElement('td');
				const v = r[h];
				if (v === null || v === undefined) td.textContent = '';
				else if (typeof v === 'object') td.textContent = JSON.stringify(v);
				else td.textContent = String(v);
				tr.appendChild(td);
			}
			tbody.appendChild(tr);
		}
		table.appendChild(thead);
		table.appendChild(tbody);
	}

	function renderRaw(rows) {
		const el = document.getElementById('resultsRaw');
		try { el.textContent = JSON.stringify(rows, null, 2); }
		catch { el.textContent = String(rows); }
	}

	// ---- UI wiring ----
	function setTab(name) {
		for (const btn of document.querySelectorAll('.tab')) btn.classList.toggle('active', btn.dataset.tab === name);
		for (const panel of document.querySelectorAll('.tab-panel')) panel.classList.toggle('active', panel.id === 'panel-' + name);
	}

	function loadData(text) {
		const info = document.getElementById('inputInfo');
		let parsed = null;
		if (parseMode === 'json' || parseMode === 'auto') parsed = safeJsonParse(text);
		let source = 'json';
		if (!parsed && (parseMode === 'xml' || parseMode === 'auto')) {
			const x = xmlToJson(text);
			if (x) { parsed = x; source = 'xml'; }
		}
		if (!parsed && (parseMode === 'html')) {
			const h = htmlToJson(text);
			if (h) { parsed = h; source = 'html'; }
		}
		if (!parsed) throw new Error('Input is neither valid JSON nor valid XML');
		const rows = flatten(parsed);
		loadedRows = rows;
		loadedMeta.source = source;
		loadedRoot = parsed;
		currentFromSource = 'data';
		const rc = document.getElementById('rowCount');
		if (rc) rc.textContent = rows.length + ' rows';
		info.textContent = `Loaded ${rows.length} row(s) from ${source.toUpperCase()}. Query using FROM data or data.<path>.`;
		renderPreview(parsed);
		// Pre-fill a simple SELECT * for convenience
        if (monacoEditor && !monacoEditor.getValue().trim()) {
            monacoEditor.setValue('SELECT * FROM data LIMIT 100');
        }
		// Default view: show all root arrays as multi tables
		try {
			populateResultsFilter();
			renderMultiFromDataRoot();
			renderRaw(collectRootArrays());
		} catch { renderTable(rows); renderRaw(rows); }
		buildSourceRadios(parsed);
	}

	function attachEvents() {
		// Tabs
        // Tabs removed in new layout

	const loadBtn = document.getElementById('loadBtn');
	if (loadBtn) loadBtn.addEventListener('click', () => {
			const text = document.getElementById('rawInput').value.trim();
			if (!text) return;
			try { loadData(text); } catch (e) { alert(e.message); }
	});

		const clearLeftBtn = document.getElementById('clearLeftBtn');
		if (clearLeftBtn) clearLeftBtn.addEventListener('click', () => {
			document.getElementById('rawInput').value = '';
			const info = document.getElementById('inputInfo'); if (info) info.textContent = 'No data loaded.';
			const prev = document.getElementById('preview'); if (prev) prev.textContent = '';
			const rc = document.getElementById('rowCount'); if (rc) rc.textContent = '0 rows';
			loadedRows = [];
		});

	const sampleJsonBtn = document.getElementById('sampleJsonBtn');
	if (sampleJsonBtn) sampleJsonBtn.addEventListener('click', () => {
			document.getElementById('rawInput').value = [
				'{',
				'  "users": [',
				'    { "id": 1, "name": "Alice" },',
				'    { "id": 2, "name": "Bob" }',
				'  ],',
				'  "orders": [',
				'    { "orderId": 101, "userId": 1, "amount": 250 },',
				'    { "orderId": 102, "userId": 2, "amount": 150 }',
				'  ]',
				'}'
			].join('\n');
	});

	const sampleXmlBtn = document.getElementById('sampleXmlBtn');
	if (sampleXmlBtn) sampleXmlBtn.addEventListener('click', () => {
			document.getElementById('rawInput').value = [
				'<data>',
				'  <users>',
				'    <user id="1" name="Alice"/>',
				'    <user id="2" name="Bob"/>',
				'  </users>',
				'  <orders>',
				'    <order orderId="101" userId="1" amount="250"/>',
				'    <order orderId="102" userId="2" amount="150"/>',
				'  </orders>',
				'</data>'
			].join('\n');
	});

		document.getElementById('runSqlBtn').addEventListener('click', () => {
			const sql = monacoEditor ? monacoEditor.getValue() : '';
			const status = document.getElementById('sqlStatus');
			try {
				const ast = parse(sql);
				currentFromSource = ast.source || 'data';
				let baseRows = resolveSourceRows(ast.source);
				if ((!baseRows || baseRows.length === 0) && Array.isArray(loadedRoot)) {
					baseRows = loadedRows;
				}
				const rows = execute(ast, baseRows);
				if (shouldRenderMulti(ast)) {
					renderMultiFromDataRoot();
					try { renderRaw(collectRootArrays()); } catch {}
				} else {
					renderSingleTableView();
					renderTable(rows);
					renderRaw(rows);
				}
				try { renderTree(rows, prettyFromLabel()); } catch {}
				lastQueryRows = rows;
				status.textContent = `${rows.length} row(s)`;
			} catch (e) {
				status.textContent = 'Error: ' + e.message;
			}
		});

		document.getElementById('clearSqlBtn').addEventListener('click', () => {
			if (monacoEditor) monacoEditor.setValue('');
			document.getElementById('sqlStatus').textContent = '';
			renderTable([]);
		});

		// support paste of files to left textarea
		const raw = document.getElementById('rawInput');
		;['dragenter','dragover'].forEach(name => raw.addEventListener(name, e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }));
		raw.addEventListener('drop', async (e) => {
			e.preventDefault();
			const file = e.dataTransfer.files && e.dataTransfer.files[0];
			if (file) {
				const text = await file.text();
				raw.value = text;
			}
		});

		// Results tabs switching and memory
		const resultsTabs = document.getElementById('resultsTabs');
		const tabButtons = resultsTabs.querySelectorAll('.tab');
		const panels = {
			'table': document.getElementById('panel-results-table'),
			'raw': document.getElementById('panel-results-raw'),
			'tree': document.getElementById('panel-results-tree')
		};
		let lastTab = localStorage.getItem('jsonxml2sql_results_tab') || 'table';
		switchTo(lastTab);
		for (const btn of tabButtons) {
			btn.addEventListener('click', () => { switchTo(btn.dataset.tab); });
		}
		function switchTo(name) {
			for (const btn of tabButtons) btn.classList.toggle('active', btn.dataset.tab === name);
			for (const key of Object.keys(panels)) panels[key].classList.toggle('active', key === name);
			localStorage.setItem('jsonxml2sql_results_tab', name);
			if (name === 'tree') {
				const rows = lastQueryRows.length ? lastQueryRows : loadedRows;
				try { renderTree(rows, prettyFromLabel()); } catch {}
			}
		}

		// Clear Storage button
		document.getElementById('clearStorageBtn').addEventListener('click', () => {
			localStorage.clear();
			alert('Local storage cleared.');
		});

		// Generate INSERTs button
		document.getElementById('genInsertsBtn').addEventListener('click', () => {
			const rows = lastQueryRows.length ? lastQueryRows : loadedRows;
			if (!rows.length) { alert('No rows to convert. Run a query or load data first.'); return; }
			const tableName = prompt('Table name for INSERTs:', 'my_table');
			if (!tableName) return;
			const sql = generateInsertSQL(rows, tableName);
			// Show in Raw tab
			document.getElementById('resultsRaw').textContent = sql;
			document.querySelector('#resultsTabs .tab[data-tab="raw"]').click();
		});

		// Results filter + downloads
		const filter = document.getElementById('resultsFilter');
		if (filter) {
			filter.addEventListener('change', () => renderMultiFromDataRoot());
		}
		document.getElementById('downloadCsvBtn')?.addEventListener('click', () => {
			const groups = getFilteredGroups();
			const csv = groups.map(g => `# ${g.name}\n` + toCSV(g.rows)).join('\n\n');
			downloadBlob(csv, 'results.csv', 'text/csv;charset=utf-8');
		});
		document.getElementById('downloadXlsBtn')?.addEventListener('click', () => {
			const groups = getFilteredGroups();
			const xls = toExcelXml(groups);
			downloadBlob(xls, 'results.xls', 'application/vnd.ms-excel');
		});
	}

	function initMonaco() {
		if (!window.__loadMonaco) return; // fallback: not loaded
		window.__loadMonaco(function (monaco) {
			monacoEditor = monaco.editor.create(document.getElementById('sqlMonaco'), {
				value: 'SELECT * FROM data LIMIT 100',
				language: 'sql',
				automaticLayout: true,
				fontSize: 14,
				minimap: { enabled: false },
				lineNumbers: 'on',
				roundedSelection: false,
				theme: 'vs-dark',
				wordWrap: 'off',
				scrollBeyondLastLine: false
			});

			// Run on Ctrl/Cmd+Enter
			monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, function() {
				document.getElementById('runSqlBtn').click();
			});

			// Suggestions: SQL keywords + dynamic FROM paths + fields for current FROM source
			const keywords = ['SELECT','FROM','WHERE','AND','OR','ORDER','BY','ASC','DESC','LIMIT','OFFSET','TRUE','FALSE','NULL','JOIN','LEFT','RIGHT','INNER','ON','AS'];
			monaco.languages.registerCompletionItemProvider('sql', {
				provideCompletionItems: () => {
					// Determine current FROM source from the editor value (simple heuristic)
					let fromSource = 'data';
					try {
						const txt = monacoEditor.getValue();
						const m = txt.match(/\bFROM\s+([A-Za-z0-9_\.]+)/i);
						if (m && m[1]) fromSource = m[1];
					} catch {}
					const fromOptions = computeFromCandidates();
					const fromItems = fromOptions.map(o => ({ label: o.label, kind: monaco.languages.CompletionItemKind.Module, insertText: o.label, detail: o.detail }));
					const baseRows = resolveSourceRows(fromSource);
					const scopedFields = uniqueKeys(baseRows);
					const fieldItems = [...new Set(scopedFields).values()].map(f => ({ label: f, kind: monaco.languages.CompletionItemKind.Field, insertText: f }));
					const kwItems = keywords.map(k => ({ label: k, kind: monaco.languages.CompletionItemKind.Keyword, insertText: k }));
					return { suggestions: [...kwItems, ...fromItems, ...fieldItems] };
				}
			});
		});
	}

	// ---- INSERTs generation ----
	function sqlEscapeValue(v) {
		if (v === null || v === undefined) return 'NULL';
		if (typeof v === 'number') return isFinite(v) ? String(v) : 'NULL';
		if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
		if (typeof v === 'object') v = JSON.stringify(v);
		// escape single quotes by doubling
		return '\'' + String(v).replace(/'/g, "''") + '\'';
	}

	function generateInsertSQL(rows, tableName) {
		const cols = uniqueKeys(rows).sort();
		const header = `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES`;
		const values = rows.map(r => `(${cols.map(c => sqlEscapeValue(r[c])).join(', ')})`);
		return header + '\n' + values.join(',\n') + ';';
	}

	function computeFromCandidates() {
		const list = [{ label: 'FROM data', detail: 'Root rows', kind: 'root' }];
		if (!loadedRoot || typeof loadedRoot !== 'object') return list;
		if (Array.isArray(loadedRoot)) {
			list.push({ label: 'FROM data', detail: 'Array root', kind: 'array' });
			return list;
		}
		// Top-level object
		for (const k of Object.keys(loadedRoot)) {
			const v = loadedRoot[k];
			list.push({ label: `FROM data.${k}`, detail: typeof v, kind: Array.isArray(v) ? 'array' : 'object' });
			if (v && typeof v === 'object' && !Array.isArray(v)) {
				for (const kk of Object.keys(v)) {
					if (Array.isArray(v[kk])) list.push({ label: `FROM data.${k}.${kk}`, detail: 'array', kind: 'array' });
				}
			}
		}
		return list;
	}

	function sampleKeysFromArrayPaths(items) {
		const keys = new Set();
		if (!loadedRoot) return [];
		for (const it of items) {
			const path = it.label.replace(/^FROM\s+/, '').trim(); // e.g., data.company.employees
			const val = getByPath({ data: loadedRoot }, path);
			if (Array.isArray(val) && val.length > 0) {
				for (const k of Object.keys(rowishToObject(val[0]))) keys.add(k);
			}
		}
		return Array.from(keys);
	}

	function init() {
		attachEvents();
		initThemeSwitch();
		initMonaco();
		initTheme();
		initParsers();
		// Align the Run button group with the SQL pad's left edge and offset main content to toolbar height
		requestAnimationFrame(() => { adjustContentOffset(); alignSqlToolbar(); });
		window.addEventListener('resize', debounce(() => { adjustContentOffset(); alignSqlToolbar(); }, 50));
		initSplitter();
	}

	document.addEventListener('DOMContentLoaded', init);
})();
	// Align the Run button group in the toolbar to the left edge of the Input pane
	function alignSqlToolbar() {
		try {
			const toolbar = document.getElementById('mainToolbar');
			const bar = document.getElementById('sqlToolbar');
			const target = document.getElementById('rawInput');
			if (!toolbar || !bar || !target) return;
			const tb = toolbar.getBoundingClientRect();
			const tg = target.getBoundingClientRect();
			const cs = getComputedStyle(toolbar);
			const padLeft = parseFloat(cs.paddingLeft || '0');
			const branding = toolbar.querySelector('.branding');
			const brandWidth = branding ? branding.getBoundingClientRect().width : 0;
			const brandMr = branding ? parseFloat(getComputedStyle(branding).marginRight || '0') : 0;
			const offset = Math.max(0, tg.left - tb.left);
			// Position toolbar nav so its left edge matches the Input editor's left edge
			const nudge = 0;
			bar.style.marginLeft = Math.max(0, offset - padLeft - brandWidth - brandMr + nudge) + 'px';
		} catch {}
	}
	// Small debounce helper
	function debounce(fn, wait) {
		let t;
		return function() { clearTimeout(t); t = setTimeout(fn, wait); };
	}
function initParsers() {
	const container = document.getElementById('parseRadios');
	if (!container) return;
	container.innerHTML = '';
	const modes = [
		{ key: 'auto', label: 'Auto' },
		{ key: 'json', label: 'JSON' },
		{ key: 'xml', label: 'XML' },
		{ key: 'html', label: 'HTML' }
	];
	for (const m of modes) {
		const id = 'parse_' + m.key;
		const lbl = document.createElement('label');
		lbl.innerHTML = `<input type="radio" name="parseMode" value="${m.key}" id="${id}"> ${m.label}`;
		container.appendChild(lbl);
	}
	const saved = localStorage.getItem('jsonxml2sql_parse') || 'auto';
	parseMode = saved;
	for (const r of container.querySelectorAll('input[name="parseMode"]')) {
		r.checked = r.value === saved;
		r.addEventListener('change', () => {
			parseMode = r.value;
			localStorage.setItem('jsonxml2sql_parse', parseMode);
		});
	}
}

// ---- Downloads ----
function toCSV(rows) {
	if (!rows || !rows.length) return '';
	const cols = uniqueKeys(rows);
	const esc = (v) => {
		if (v == null) return '';
		const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
		if (/[",\n]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
		return s;
	};
	const lines = [cols.join(',')];
	for (const r of rows) lines.push(cols.map(c => esc(r[c])).join(','));
	return lines.join('\n');
}

function toExcelXml(groups) {
	// Very small Excel 2003 XML Spreadsheet; one worksheet per group
	const header = `<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">`;
	const footer = '</Workbook>';
	const sheets = groups.map(g => {
		const rows = g.rows || [];
		const cols = uniqueKeys(rows);
		const rowXml = [];
		// header row
		rowXml.push('<Row>' + cols.map(c => `<Cell><Data ss:Type="String">${escapeXml(c)}</Data></Cell>`).join('') + '</Row>');
		for (const r of rows) {
			rowXml.push('<Row>' + cols.map(c => `<Cell><Data ss:Type="String">${escapeXml(r[c] == null ? '' : (typeof r[c]==='object'? JSON.stringify(r[c]) : String(r[c])))}</Data></Cell>`).join('') + '</Row>');
		}
		return `<Worksheet ss:Name="${escapeXml(g.name)}"><Table>${rowXml.join('')}</Table></Worksheet>`;
	}).join('');
	return header + sheets + footer;
}

function escapeXml(s) { return String(s).replace(/[<&>\"]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[ch])); }

function downloadBlob(content, filename, mime) {
	const blob = new Blob([content], { type: mime });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url; a.download = filename; document.body.appendChild(a); a.click();
	setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

function prettyFromLabel() {
	try {
		if (!currentFromSource || currentFromSource === 'data') return 'root';
		if (currentFromSource.startsWith('data.')) return currentFromSource.slice(5);
		return currentFromSource;
	} catch { return 'root'; }
}

// Detect when to render multiple tables: SELECT * FROM data with no WHERE/ORDER/LIMIT/OFFSET
function shouldRenderMulti(ast) {
	try {
		const isStar = ast && ast.cols && ast.cols.length === 1 && ast.cols[0] === '*';
		const isRoot = ast && (ast.source === 'data' || !ast.source);
		const noClauses = ast && !ast.where && !ast.order && ast.limit == null && ast.offset == null && (!ast.joins || ast.joins.length === 0);
		return Boolean(isStar && isRoot && noClauses);
	} catch { return false; }
}

// Collect arrays anywhere under data.* (one level or deep). Each array becomes a table entry.
function collectRootArrays() {
	if (!loadedRoot || (typeof loadedRoot !== 'object' && !Array.isArray(loadedRoot))) return [];
	const out = [];
	const seen = new Set();
	function push(name, arr) {
		const key = name + '|' + arr.length;
		if (seen.has(key)) return; // avoid dup paths collapsing to same array
		out.push({ name, rows: arr.map(rowishToObject) });
		seen.add(key);
	}
	function visit(node, path) {
		if (Array.isArray(node)) {
			push(path || 'data', node);
			// also dive into elements to find nested arrays
			node.forEach((el, i) => visit(el, path + '[' + i + ']'));
			return;
		}
		if (node && typeof node === 'object') {
			for (const [k, v] of Object.entries(node)) {
				const p = path ? path + '.' + k : k;
				if (Array.isArray(v)) push(p, v);
				visit(v, p);
			}
		}
	}
	visit(loadedRoot, 'data');
	// Prefer top-level named arrays first
	out.sort((a,b) => a.name.split('.').length - b.name.split('.').length);
	return out;
}

function getFilteredGroups() {
	const panel = document.getElementById('panel-results-table');
	if (panel && !panel.classList.contains('multi-table')) {
		const rows = (lastQueryRows && lastQueryRows.length) ? lastQueryRows : loadedRows;
		return [{ name: 'results', rows }];
	}
	const groups = collectRootArrays();
	const filter = document.getElementById('resultsFilter');
	if (!filter || !filter.value || filter.value === 'ALL') return groups;
	return groups.filter(g => g.name === filter.value);
}

function populateResultsFilter() {
	const sel = document.getElementById('resultsFilter');
	if (!sel) return;
	const groups = collectRootArrays();
	const cur = sel.value;
	sel.innerHTML = '';
	const optAll = document.createElement('option'); optAll.value = 'ALL'; optAll.textContent = 'All'; sel.appendChild(optAll);
	for (const g of groups) {
		const o = document.createElement('option'); o.value = g.name; o.textContent = g.name; sel.appendChild(o);
	}
	sel.value = cur && [...sel.options].some(o=>o.value===cur) ? cur : 'ALL';
}

function renderMultiFromDataRoot() {
	populateResultsFilter();
	const groups = getFilteredGroups();
	if (!groups.length) { renderTable([]); return; }
	// Build a combined container inside panel-results-table
	const panel = document.getElementById('panel-results-table');
	panel.innerHTML = '';
	panel.classList.add('multi-table');
	for (const g of groups) {
		const header = document.createElement('h3');
		header.textContent = g.name;
		panel.appendChild(header);
		const wrap = document.createElement('div');
		wrap.className = 'table-wrap';
		const tbl = document.createElement('table');
		wrap.appendChild(tbl);
		panel.appendChild(wrap);
		// Render each table
		const headers = uniqueKeys(g.rows);
		const thead = document.createElement('thead');
		const trh = document.createElement('tr');
		for (const h of headers) {
			const th = document.createElement('th'); th.textContent = h; trh.appendChild(th);
		}
		thead.appendChild(trh);
		const tbody = document.createElement('tbody');
		for (const r of g.rows) {
			const tr = document.createElement('tr');
			for (const h of headers) {
				const td = document.createElement('td');
				const v = r[h];
				if (v === null || v === undefined) td.textContent = '';
				else if (typeof v === 'object') td.textContent = JSON.stringify(v);
				else td.textContent = String(v);
				tr.appendChild(td);
			}
			tbody.appendChild(tr);
		}
		tbl.appendChild(thead);
		tbl.appendChild(tbody);
		const sep = document.createElement('div'); sep.className = 'separator'; panel.appendChild(sep);
	}
}

function renderSingleTableView() {
	const panel = document.getElementById('panel-results-table');
	panel.innerHTML = '<div class="table-wrap"><table id="resultsTable"></table></div>';
	panel.classList.remove('multi-table');
}

// Set the main content top padding to the toolbar height to remove any gap/overlap
function adjustContentOffset() {
	try {
		const toolbar = document.getElementById('mainToolbar');
		const main = document.querySelector('.app-main');
		if (!toolbar || !main) return;
		const h = toolbar.getBoundingClientRect().height;
		main.style.paddingTop = h + 'px';
	} catch {}
}

// Tree view
function renderTree(data, rootLabel = 'root') {
	const root = document.getElementById('resultsTree');
	if (!root) return;
	root.innerHTML = '';
	function createNode(key, value, parentKey = '') {
		const li = document.createElement('li');
		const caret = document.createElement('span');
		caret.className = 'caret';
		caret.tabIndex = 0;
		const label = document.createElement('span');
		label.className = 'key';
		label.textContent = key;
		li.appendChild(caret);
		li.appendChild(label);
		const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
		const t = document.createElement('span');
		t.className = 'type';
		t.textContent = `: ${type}`;
		li.appendChild(t);
		if (type === 'object' || type === 'array') {
			const ul = document.createElement('ul');
			const entries = Array.isArray(value) ? value.map((v,i)=>[`${parentKey || key}[${i}]`, v]) : Object.entries(value);
			for (const [k,v] of entries) ul.appendChild(createNode(k, v, key));
			li.appendChild(ul);
			li.classList.add('has-children');
			// Default expanded; allow toggle
			const toggle = () => { li.classList.toggle('collapsed'); };
			caret.addEventListener('click', toggle);
			caret.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
		} else {
			const vv = document.createElement('span');
			vv.textContent = ` = ${String(value)}`;
			li.appendChild(vv);
		}
		return li;
	}
	const ul = document.createElement('ul');
	ul.appendChild(createNode(rootLabel, data));
	root.appendChild(ul);
}
// Theme handling
function initTheme() {
	const root = document.documentElement;
	const saved = localStorage.getItem('jsonxml2sql_theme') || 'light';
	root.classList.toggle('theme-light', saved === 'light');
	root.classList.toggle('theme-dark', saved === 'dark');
	const sw = document.getElementById('themeSwitch');
	const label = document.querySelector('.theme-toggle-label');
	if (sw) {
		sw.setAttribute('data-on', saved === 'dark');
		sw.setAttribute('aria-checked', String(saved === 'dark'));
	}
	if (label) label.textContent = saved === 'dark' ? 'Dark mode' : 'Light mode';
}

// Horizontal splitter controlling editor heights
function initSplitter() {
	const bar = document.getElementById('hSplit');
	if (!bar) return;
	let dragging = false;
	let startY = 0;
	let startH = 0;
	const root = document.documentElement;
	const monacoEl = document.getElementById('sqlMonaco');
	const leftTa = document.getElementById('rawInput');
	const getCurrent = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--editor-height') || '320', 10) || 320;
	const setHeight = (px) => {
		const h = Math.max(140, Math.min(700, px));
		root.style.setProperty('--editor-height', h + 'px');
		// Resize Monaco explicitly if created
		try { if (monacoEditor) monacoEditor.layout(); } catch {}
		// Adjust textarea height approximately
		if (leftTa) leftTa.style.minHeight = h + 'px';
	};
	const onMove = (e) => {
		if (!dragging) return;
		const dy = e.clientY - startY;
		setHeight(startH + dy);
		e.preventDefault();
	};
	const onUp = () => { dragging = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
	bar.addEventListener('mousedown', (e) => {
		dragging = true;
		startY = e.clientY;
		startH = getCurrent();
		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onUp);
		e.preventDefault();
	});
}

// Legacy no-op to avoid errors if referenced
function buildSourceRadios(_) { /* intentionally empty */ }


