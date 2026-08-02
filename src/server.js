const fs = require('fs');
const path = require('path');

const KW = new Set([
  'func','function','class','if','elif','elseif','else','while','for','in',
  'return','break','pass','import','export','private','try','except',
  'and','or','not','True','False','nil','as','self',
  'end','do','then',
]);

const BUILTINS = [
  'print','input','int','float','str','bool','bigi','bigf','type','len',
  'range','min','max','clamp','ascii','chr','get_args',
];

const BUILTIN_TYPES = new Set(['int','float','str','bool','bigi','bigf']);

const BUILTIN_MEMBERS = {
  str:   [ { name: 'length', kind: 'property' } ],
  list:  [ { name: 'length', kind: 'property' },
           { name: 'append', kind: 'function' },
           { name: 'pop', kind: 'function' },
           { name: 'clear', kind: 'function' },
           { name: 'reverse', kind: 'function' },
           { name: 'sort', kind: 'function' },
           { name: 'map', kind: 'function' },
           { name: 'filter', kind: 'function' },
           { name: 'reduce', kind: 'function' } ],
  dict:  [ { name: 'length', kind: 'property' } ],
  int:   [],
  float: [],
  bool:  [],
  bigi:  [],
  bigf:  [],
};

const GENERIC_MEMBERS = [
  { name: 'length', kind: 'property' },
  { name: 'append', kind: 'function' },
  { name: 'pop', kind: 'function' },
  { name: 'clear', kind: 'function' },
  { name: 'reverse', kind: 'function' },
  { name: 'sort', kind: 'function' },
  { name: 'map', kind: 'function' },
  { name: 'filter', kind: 'function' },
  { name: 'reduce', kind: 'function' },
];

const COLOR_LABELS = { function:'y', class:'b', number:'g', keyword:'k', string:'s', variable:'v', parameter:'p', property:'r', undefined:'w' };
const COLOR_MODS = { defaultLibrary:'u' };

function stripDocComment(text) {
  let s = text.trim();
  if (s.startsWith('/*')) s = s.slice(2);
  if (s.endsWith('*/')) s = s.slice(0, -2);
  return s.split('\n')
    .map(l => l.replace(/^\s*\*\s?/, '').replace(/^#+\s?/, '').replace(/^\/\/+\s?/, '').trim())
    .filter(l => l !== '')
    .join('\n');
}

function extractDoc(lines, index) {
  let j = index - 1;
  while (j >= 0) {
    const t = lines[j].trim();
    if (t.startsWith('@')) { j--; continue; }
    break;
  }
  if (j < 0) return null;
  const prev = lines[j].trim();
  if (prev === '') return null;
  if (prev.startsWith('#')) return stripDocComment(prev);
  if (prev.startsWith('//')) return stripDocComment(prev);
  if (prev.startsWith('/*') && prev.includes('*/')) return stripDocComment(prev);
  if (prev.startsWith('/*')) return stripDocComment(prev);
  if (prev.endsWith('*/')) {
    const parts = [prev];
    let k = j - 1;
    while (k >= 0) {
      const l = lines[k].trim();
      parts.unshift(l);
      if (l.startsWith('/*')) break;
      k--;
    }
    if (parts[0].startsWith('/*')) return stripDocComment(parts.join('\n'));
    return null;
  }
  return null;
}

function memberObjectOf(raw, start) {
  const before = raw.slice(0, start).replace(/\s+$/, '');
  if (!before.endsWith('.')) return null;
  const m = before.slice(0, -1).match(/([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*$/);
  return m ? m[1].replace(/\s+/g, '') : null;
}

function memberKindFor(objExpr, member, scope, imports, enclosingClass) {
  if (imports) {
    for (const imp of imports) {
      if (imp.alias === objExpr) {
        const info = imp.scope[member];
        if (!info) return null;
        return info.kind === 'class' ? 'class' : info.kind === 'function' ? 'function' : info.kind === 'builtin' ? 'function' : info.kind;
      }
    }
    const segs = objExpr.split('.');
    for (const imp of imports) {
      if (imp.alias === segs[0]) {
        let cur = imp.scope;
        for (let k = 1; k < segs.length; k++) {
          const e = cur[segs[k]];
          if (!e) return null;
          if (e.kind === 'class') {
            cur = {};
            for (const mm of e.members || []) cur[mm.name] = { kind: mm.kind };
            continue;
          }
          return null;
        }
        const info = cur[member];
        if (!info) return null;
        return info.kind === 'class' ? 'class' : info.kind === 'function' ? 'function' : info.kind;
      }
    }
  }

  if (objExpr === 'self') {
    const cls = scope[enclosingClass];
    if (!cls) return null;
    const mem = (cls.members || []).find(mm => mm.name === member);
    return mem ? mem.kind : null;
  }

  const info = scope[objExpr];
  if (!info) return null;
  if (info.kind === 'class') {
    const mem = (info.members || []).find(mm => mm.name === member);
    return mem ? mem.kind : null;
  }
  if (info.classType && scope[info.classType]) {
    const cls = scope[info.classType];
    const mem = (cls.members || []).find(mm => mm.name === member);
    return mem ? mem.kind : null;
  }
  return null;
}

function analyze(source, fileUri, imports) {
  const scope = {};
  for (const b of BUILTINS) scope[b] = { kind: 'builtin', line: 0 };
  const lines = source.split('\n');
  const undefs = [];
  const redefs = [];
  const tokens = [];
  const classAtLine = [];
  const classStack = [];
  let defs_added = 0;

  function isDefinition(info) {
    return info && (info.kind === 'function' || info.kind === 'class' || info.isImport || info.annotated);
  }

  function checkRedef(name, line, newKind, newIsImport, newAnnotated) {
    const prev = scope[name];
    if (!prev || prev.kind === 'builtin') return;
    const newIsDef = newKind === 'function' || newKind === 'class' || newIsImport || newAnnotated;
    const prevIsDef = isDefinition(prev);
    if (!newIsDef && !prevIsDef) return;
    const hard = newKind === 'function' || newKind === 'class' || newIsImport ||
                 prev.kind === 'function' || prev.kind === 'class' || prev.isImport;
    redefs.push({ line, name, hard });
  }

  function addDef(name, kind, line) {
    if (!scope[name]) { scope[name] = { kind, line }; defs_added++; }
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (line.startsWith('#') || line.startsWith('//') || line.startsWith('--') || line === '') {
      classAtLine.push(classStack.length ? classStack[classStack.length - 1].name : null);
      continue;
    }
    if (line.startsWith('/*')) {
      classAtLine.push(classStack.length ? classStack[classStack.length - 1].name : null);
      i++; while (i < lines.length && !lines[i].includes('*/')) { classAtLine.push(null); i++; }
      continue;
    }
    if (line.startsWith('--[[')) {
      classAtLine.push(classStack.length ? classStack[classStack.length - 1].name : null);
      i++; while (i < lines.length && !lines[i].includes(']]')) { classAtLine.push(null); i++; }
      continue;
    }

    const curIndent = raw.match(/^\s*/)[0].length;
    while (classStack.length && classStack[classStack.length - 1].indent >= curIndent) classStack.pop();
    classAtLine.push(classStack.length ? classStack[classStack.length - 1].name : null);

    let m = null;
    if (line.startsWith('import')) {
      m = line.match(/^import\s+(?:["'][^"']+["']|\S+)\s+as\s+(\w+)/);
      if (m) {
        checkRedef(m[1], i + 1, 'variable', true, false);
        addDef(m[1], 'variable', i + 1);
        scope[m[1]].isImport = true;
        scope[m[1]].importLine = i;
      }
    }

    m = line.match(/^(?:private\s+)?(?:func|function)\s+(\w+)\s*\(([^)]*)\)/);
    if (m) {
      checkRedef(m[1], i + 1, 'function', false, false);
      addDef(m[1], 'function', i + 1);
      if (line.startsWith('private')) scope[m[1]].private = true;
      const doc = extractDoc(lines, i);
      if (doc) { scope[m[1]].doc = doc; }
      const params = [];
      const args = m[2].split(',');
      for (const a of args) {
        const at = a.trim();
        if (!at) continue;
        const am = at.match(/^(\w+)\s*(?::\s*([A-Za-z_]\w*))?/);
        if (!am) continue;
        params.push({ name: am[1], type: am[2] || null });
        addDef(am[1], 'parameter', i + 1);
        if (am[2] && scope[am[2]] && scope[am[2]].kind === 'class') {
          scope[am[1]].classType = am[2];
          scope[am[1]].annotated = true;
        }
      }
      if (scope[m[1]]) {
        scope[m[1]].params = params;
        let endLine = i + 1;
        for (let j = i + 1; j < lines.length; j++) {
          const r2 = lines[j];
          const t2 = r2.trim();
          if (t2 === '' || t2.startsWith('#')) { endLine = j + 1; continue; }
          if (r2.match(/^\s*/)[0].length <= curIndent) break;
          endLine = j + 1;
        }
        for (const p of params) {
          if (scope[p.name]) scope[p.name].paramRange = [i + 1, endLine];
        }
      }
    }

    m = line.match(/^class\s+(\w+)/);
    if (m) {
      checkRedef(m[1], i + 1, 'class', false, false);
      addDef(m[1], 'class', i + 1);
      const doc = extractDoc(lines, i);
      if (doc) { scope[m[1]].doc = doc; }
      classStack.push({ name: m[1], indent: curIndent });
      const classIndent = curIndent;
      const members = [];
      const memberNames = new Set();
      const addMember = (name, kind, isPrivate, params, doc) => {
        if (!memberNames.has(name)) { memberNames.add(name); members.push({ name, kind, private: !!isPrivate, params: params || null, doc: doc || null }); }
      };
      for (let j = i + 1; j < lines.length; j++) {
        const r2 = lines[j];
        const t2 = r2.trim();
        if (t2 === '' || t2.startsWith('#')) continue;
        if (r2.match(/^\s*/)[0].length <= classIndent) break;
        let mm = t2.match(/^(private\s+)?(?:func|function)\s+(\w+)\s*\(([^)]*)\)/);
        if (mm) {
          const mparams = mm[3].split(',').map(x => x.trim()).filter(Boolean).map(x => {
            const xm = x.match(/^(\w+)\s*(?::\s*([A-Za-z_]\w*))?/);
            return xm ? { name: xm[1], type: xm[2] || null } : null;
          }).filter(Boolean);
          const mdoc = extractDoc(lines, j);
          addMember(mm[2], 'function', !!mm[1], mparams, mdoc);
        }
        mm = t2.match(/^self\.(\w+)\s*=/);
        if (mm) addMember(mm[1], 'property');
      }
      const parent = line.match(/^class\s+\w+\s*\(\s*(\w+)/);
      if (parent && scope[parent[1]] && scope[parent[1]].kind === 'class' && scope[parent[1]].members) {
        for (const pm of scope[parent[1]].members) addMember(pm.name, pm.kind, pm.private, pm.params, pm.doc);
      }
      if (scope[m[1]]) scope[m[1]].members = members;
    }

    m = line.match(/^for\s+(\w+)\s+in\s+/) || line.match(/^for\s*\(\s*(\w+)\s+in\s+/);
    if (m) { checkRedef(m[1], i + 1, 'variable', false, false); addDef(m[1], 'variable', i + 1); }

    m = line.match(/^(\w+)\s*:\s*([A-Za-z_]\w*)\s*$/);
    if (m && !line.startsWith('import')) {
      checkRedef(m[1], i + 1, 'variable', false, true);
      addDef(m[1], 'variable', i + 1);
      if (scope[m[2]] && scope[m[2]].kind === 'class') {
        scope[m[1]].classType = m[2];
        scope[m[1]].annotated = true;
      } else if (BUILTIN_TYPES.has(m[2])) {
        scope[m[1]].type = m[2];
        scope[m[1]].annotated = true;
      }
    }

    m = line.match(/^(\w+)\s*(?::\s*\w+)?\s*=/);
    if (m && !line.startsWith('import')) {
      const ann = line.match(/^(\w+)\s*:\s*([A-Za-z_]\w*)\s*(?:=|$)/);
      checkRedef(m[1], i + 1, 'variable', false, !!ann);
      addDef(m[1], 'variable', i + 1);
      if (ann && scope[ann[2]]) {
        if (scope[ann[2]].kind === 'class') {
          scope[m[1]].classType = ann[2];
          scope[m[1]].annotated = true;
        } else if (BUILTIN_TYPES.has(ann[2])) {
          scope[m[1]].type = ann[2];
          scope[m[1]].annotated = true;
        }
      }
      const inst = line.match(/^(\w+)\s*(?::\s*\w+)?\s*=\s*([A-Za-z_]\w*)\s*\(/);
      if (inst && !scope[m[1]].annotated && scope[inst[2]] && scope[inst[2]].kind === 'class') {
        scope[m[1]].classType = inst[2];
      }
      if (!scope[m[1]].annotated && !scope[m[1]].type) {
        const lit = line.match(/^(\w+)\s*(?::\s*\w+)?\s*=\s*(.+)$/);
        if (lit) {
          const rhs = lit[2].trim();
          let t = null;
          if (rhs.startsWith('"') || rhs.startsWith("'")) t = 'str';
          else if (rhs.startsWith('[')) t = 'list';
          else if (rhs.startsWith('{')) t = 'dict';
          else if (/^\d+\.\d+/.test(rhs)) t = 'float';
          else if (/^\d+/.test(rhs)) t = 'int';
          if (t) {
            scope[m[1]].type = t;
          }
        }
      }
    }

    const lineTokens = tokenize(raw);
    const lineColored = [];
    for (const tok of lineTokens) {
      tok.line = i;
      const name = tok.text;
      let kind = 'variable';
      let mods = [];

      if (/^[=+\-*/%<>!&|^~?:;,\.\(\)\[\]{}@#]$/.test(name)) { continue; }

      if (KW.has(name)) {
        kind = 'keyword';
      } else if (scope[name]) {
        const info = scope[name];
        kind = info.kind === 'function' ? 'function' :
               info.kind === 'class' ? 'class' :
               info.kind === 'parameter' ? 'parameter' :
               info.kind === 'builtin' && BUILTIN_TYPES.has(name) ? 'class' :
               info.kind === 'builtin' ? 'function' : 'variable';
        if (name === 'self') mods.push('defaultLibrary');
        if (info.isImport && i !== info.importLine) info.used = true;
      } else if (name === '_') {
        kind = 'variable';
      } else if (/^\d/.test(name) || /^\d+\./.test(name)) {
        kind = 'number';
      } else if (name.startsWith('"') || name.startsWith("'")) {
        kind = 'string';
      } else if (name === 'props') {
        kind = 'property';
      } else {
        const objExpr = memberObjectOf(raw, tok.start);
        if (objExpr) {
          const mkind = memberKindFor(objExpr, name, scope, imports, classAtLine[i]);
          kind = mkind === 'function' ? 'function' :
                 mkind === 'class' ? 'class' :
                 mkind === 'property' ? 'property' :
                 mkind === 'parameter' ? 'parameter' : 'undefined';
        } else {
          kind = 'undefined';
        }
      }

      lineColored.push({ start: tok.start, end: tok.end, kind, mods });
      tokens.push({ line: i, start: tok.start, end: tok.end, kind, mods });
    }
    {
      const parts = [];
      let lastEnd = 0;
      for (const tok of lineColored) {
        if (tok.start > lastEnd) parts.push(raw.slice(lastEnd, tok.start));
        let label = COLOR_LABELS[tok.kind] || '?';
        for (const m of tok.mods) label += COLOR_MODS[m] || '';
        parts.push('⟦' + label + ':' + raw.slice(tok.start, tok.end) + '⟧');
        lastEnd = tok.end;
      }
      if (lastEnd < raw.length) parts.push(raw.slice(lastEnd));
    }

    if (!line.startsWith('import') && !line.startsWith('@')) {
      const posTokens = tokenizeSimple(line);
      for (const tok of posTokens) {
        if (tok.type === 'identifier' && !scope[tok.value] && !KW.has(tok.value) && tok.value !== '_') {
          const idx = raw.indexOf(tok.value);
          if (idx > 0 && raw[idx - 1] === '.') continue;
          if (!line.match(new RegExp('^' + tok.value + '\\s*(:|=|\\()'))) {
            undefs.push({ line: i + 1, name: tok.value });
          }
        }
      }
    }
  }

  const foundSet = imports ? new Set(imports.map(imp => imp.alias)) : null;
  for (const tok of tokens) {
    const tname = lines[tok.line].slice(tok.start, tok.end);
    const info = scope[tname];
    if (info && info.isImport) {
      if (foundSet !== null && !foundSet.has(tname)) {
        tok.kind = 'undefined';
        tok.mods = [];
      } else {
        if (!tok.mods.includes('import')) tok.mods.push('import');
        if (!info.used) tok.mods.push('unused');
      }
    }
  }

  return { scope, undefs, redefs, tokens, classAtLine };
}

function tokenize(src) {
  const res = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '#' || (ch === '/' && src[i + 1] === '/') || (ch === '-' && src[i + 1] === '-')) break;
    if (ch === '"' || ch === "'") {
      const q = ch; const s = i; i++;
      while (i < src.length && src[i] !== q) i++;
      if (i < src.length) i++;
      res.push({ text: src.slice(s, i), start: s, end: i });
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const s = i;
      while (i < src.length && /[a-zA-Z0-9_]/.test(src[i])) i++;
      res.push({ text: src.slice(s, i), start: s, end: i });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const s = i;
      while (i < src.length && /[0-9.eE]/.test(src[i])) i++;
      res.push({ text: src.slice(s, i), start: s, end: i });
      continue;
    }
    i++;
  }
  return res;
}

function tokenizeSimple(line) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '#' || (line[i] === '/' && line[i + 1] === '/') || (line[i] === '-' && line[i + 1] === '-')) break;
    if (line[i] === '"' || line[i] === "'") { const q = line[i]; i++; while (i < line.length && line[i] !== q) i++; if (i < line.length) i++; continue; }
    if (/[a-zA-Z_]/.test(line[i])) {
      const s = i; while (i < line.length && /[a-zA-Z0-9_]/.test(line[i])) i++;
      tokens.push({ type: 'identifier', value: line.slice(s, i) });
      continue;
    }
    if (/[0-9]/.test(line[i])) { while (i < line.length && /[0-9.]/.test(line[i])) i++; continue; }
    if (/[.\-+*/%=<>!&|^~(){}\[\]?,:;@]/.test(line[i])) { i++; continue; }
    if (line[i] === ' ' || line[i] === '\t') { i++; continue; }
    i++;
  }
  return tokens;
}

function findPackageDist(importPath, dir) {
  let cur = path.resolve(dir);
  for (let depth = 0; depth < 12; depth++) {
    const pkgDist = path.join(cur, '.boblang', 'packages', importPath, 'dist');
    try {
      if (fs.existsSync(path.join(pkgDist, 'package.json'))) return pkgDist;
    } catch (e) {}
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function resolvePackage(importPath, dir) {
  const pkgDist = findPackageDist(importPath, dir);
  if (!pkgDist) return null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(pkgDist, 'package.json'), 'utf-8'));
    const scope = {};
    for (const f of data.functions || []) {
      scope[f.name] = {
        kind: 'function',
        line: 0,
        params: (f.params || []).map(p => ({ name: p.name, type: p.type })),
        returnType: f.return_type || null,
        doc: f.desc || f.description || null,
      };
    }
    for (const e of data.exports || []) {
      const base = e.from.includes('.') ? e.from.split('.').pop() : e.from;
      if (scope[base] && !scope[e.as]) scope[e.as] = { ...scope[base] };
      const modPrefix = 'bob_mod_' + data.name + '_';
      if (e.from.startsWith('bob_mod_') && e.from.startsWith(modPrefix)) {
        const fnname = e.from.slice(modPrefix.length);
        if (scope[fnname] && !scope[e.as]) scope[e.as] = { ...scope[fnname] };
      }
    }
    return { scope, data };
  } catch (e) {
    return null;
  }
}

function resolveImports(uri, text, visited) {
  visited = visited || new Set();
  if (visited.has(uri)) return [];
  visited.add(uri);
  const result = [];
  const lines = text.split('\n');
  for (const raw of lines) {
    const m = raw.trim().match(/^import\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+as\s+(\w+)/);
    if (m) {
      const importPath = m[1] || m[2] || m[3];
      const alias = m[4];
      const dir = uri.startsWith('file://') ? path.dirname(uri.slice(7)) : '.';
      let fullPath;
      try {
        if (path.isAbsolute(importPath)) fullPath = importPath;
        else fullPath = path.resolve(dir, importPath);
        const imported = fs.readFileSync(fullPath, 'utf-8');
        const analysis = analyze(imported, fullPath);
        result.push({ alias, scope: analysis.scope });
        const nested = resolveImports('file://' + fullPath, imported, visited);
        for (const n of nested) result.push({ alias: alias + '.' + n.alias, scope: n.scope });
      } catch (e) {
        if (!m[1] && !m[2]) {
          const pkg = resolvePackage(importPath, dir);
          if (pkg) {
            result.push({ alias, scope: pkg.scope });
          }
        }
      }
    }
  }
  return result;
}

function publicOnly(members) {
  return (members || []).filter(mm => !mm.private);
}

function scopeEntries(scope) {
  const out = [];
  for (const [name, info] of Object.entries(scope)) {
    if (name === 'props') continue;
    if (info.kind === 'builtin') continue;
    if (info.kind === 'parameter') continue;
    if (info.private) continue;
    out.push({ name, kind: info.kind, params: info.kind === 'function' ? info.params : undefined, returnType: info.kind === 'function' ? info.returnType : undefined, doc: info.doc || null });
  }
  return out;
}

function resolveMembers(pathStr, doc, importScopes, enclosingClass) {
  for (const imp of importScopes) {
    if (imp.alias === pathStr) {
      return scopeEntries(imp.scope);
    }
  }
  if (!doc) return null;

  const segments = pathStr.split('.');
  const first = segments[0];

  if (first === 'self' && enclosingClass && doc.scope[enclosingClass]) {
    const cls = doc.scope[enclosingClass];
    if (cls.members) return cls.members;
  }

  const imp = importScopes && importScopes.find(x => x.alias === first);
  if (imp) {
    let curScope = imp.scope;
    for (let k = 1; k < segments.length; k++) {
      const entry = curScope[segments[k]];
      if (!entry) return null;
      if (k === segments.length - 1) {
        if (entry.kind === 'class' && entry.members) return publicOnly(entry.members);
        return null;
      }
      if (entry.kind === 'class') {
        curScope = {};
        for (const mm of publicOnly(entry.members)) curScope[mm.name] = { kind: mm.kind, params: mm.params, doc: mm.doc };
        continue;
      }
      return null;
    }
  }

  const info = doc.scope[first];
  if (!info) return null;

  if (info.kind === 'class' && info.members) {
    if (segments.length === 1) return publicOnly(info.members);
    let cur = info;
    for (let k = 1; k < segments.length; k++) {
      const member = (cur.members || []).find(mm => mm.name === segments[k]);
      if (!member) return null;
      const nested = doc.scope[member.name];
      if (k === segments.length - 1) {
        if (nested && nested.kind === 'class' && nested.members) return publicOnly(nested.members);
        return null;
      }
      if (!nested || nested.kind !== 'class') return null;
      cur = nested;
    }
  }

  if (info.classType && doc.scope[info.classType]) {
    const cls = doc.scope[info.classType];
    if (cls.kind === 'class' && cls.members && segments.length === 1) return publicOnly(cls.members);
  }

  if (info.type && BUILTIN_MEMBERS[info.type] && segments.length === 1) {
    return BUILTIN_MEMBERS[info.type];
  }

  return null;
}

function completionKnd(info) {
  const kinds = { variable: 6, function: 3, class: 5, parameter: 6, property: 6, builtin: 3 };
  let k = kinds[info.kind] || 6;
  if (info.kind === 'builtin' && BUILTIN_TYPES.has(info.name)) k = 5;
  return k;
}

function signatureOf(name, params, returnType) {
  if (!params) params = [];
  const p = params.map(x => x.type ? x.name + ': ' + x.type : x.name).join(', ');
  let s = name + '(' + p + ')';
  if (returnType) s += ' -> ' + returnType;
  return s;
}

function uriToPath(uri) {
  return uri.startsWith('file://') ? uri.slice(7) : uri;
}

function collectImportFiles(dir, prefix, depth, out) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    const rel = prefix ? prefix + '.' + entry.name : entry.name;
    if (entry.isDirectory()) {
      collectImportFiles(full, rel, depth + 1, out);
    } else if (entry.isFile() && (/\.bob$/.test(entry.name) || /\.c$/.test(entry.name))) {
      out.push(rel);
    }
  }
}

function collectInstalledPackages(dir, out) {
  const seen = new Set();
  let cur = path.resolve(dir);
  for (let depth = 0; depth < 12; depth++) {
    const pkgsRoot = path.join(cur, '.boblang', 'packages');
    try {
      if (fs.existsSync(pkgsRoot)) {
        for (const name of fs.readdirSync(pkgsRoot)) {
          if (seen.has(name)) continue;
          if (fs.existsSync(path.join(pkgsRoot, name, 'dist', 'package.json'))) {
            seen.add(name);
            out.push(name);
          }
        }
      }
    } catch (e) {}
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}

process.stdin.setEncoding('utf8');
let buffer = '';

function send(obj) {
  const json = JSON.stringify(obj);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

const SEMANTIC_TOKEN_TYPES = ['variable','function','class','parameter','keyword','number','string','property','undefined'];
const SEMANTIC_TOKEN_MODIFIERS = ['defaultLibrary','import','unused'];

function handle(m) {
  const { method, id, params } = m;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      capabilities: {
        textDocumentSync: 1,
        completionProvider: { triggerCharacters: ['.', ' '] },
        hoverProvider: true,
        signatureHelpProvider: { triggerCharacters: ['(', ','] },
        semanticTokensProvider: {
          full: true,
          legend: { tokenTypes: SEMANTIC_TOKEN_TYPES, tokenModifiers: SEMANTIC_TOKEN_MODIFIERS }
        }
      }
    }});
  }
  if (method === 'initialized') return;
  if (method === 'shutdown') { send({ jsonrpc: '2.0', id, result: null }); return; }
  if (method === 'exit') { process.exit(0); }

  if (method === 'textDocument/didOpen') {
    const td = params.textDocument;
    if (!td.text) return;
    const imports = resolveImports(td.uri, td.text);
    const analysis = analyze(td.text, td.uri, imports);
    docs.set(td.uri, { uri: td.uri, text: td.text, ...analysis });
    publishDiagnostics(td.uri, td.text, analysis.undefs, analysis.redefs);
  }

  if (method === 'textDocument/didChange') {
    const uri = params.textDocument.uri;
    let text;
    if (params.contentChanges[0].range && docs.has(uri)) {
      const existing = docs.get(uri).text;
      const ch = params.contentChanges[0];
      const pre = existing.slice(0, offsetFromPos(existing, ch.range.start));
      const post = existing.slice(offsetFromPos(existing, ch.range.end));
      text = pre + ch.text + post;
    } else {
      text = params.contentChanges[0].text;
    }
    if (!text) return;
    const imports = resolveImports(uri, text);
    const analysis = analyze(text, uri, imports);
    docs.set(uri, { uri, text, ...analysis });
    publishDiagnostics(uri, text, analysis.undefs, analysis.redefs);
  }

  if (method === 'textDocument/completion') {
    const uri = params.textDocument.uri;
    const doc = docs.get(uri);
    const items = [];
    const pos = params.position;

    if (doc) {
      const line = doc.text.split('\n')[pos.line] || '';
      const beforeCaret = line.slice(0, pos.character);

      const impMatch = beforeCaret.match(/^\s*import\s+["']?([^\s'"]*)$/);
      if (impMatch) {
        const partial = impMatch[1] || '';
        const startChar = pos.character - partial.length;
        const range = { start: { line: pos.line, character: startChar }, end: { line: pos.line, character: pos.character } };
        const dir = path.dirname(uriToPath(uri));
        const files = [];
        collectImportFiles(dir, '', 0, files);
        const packages = [];
        collectInstalledPackages(dir, packages);
        const labels = new Set();
        for (const f of files) {
          const label = f;
          if (labels.has(label)) continue;
          labels.add(label);
          if (!partial || label.startsWith(partial) || (partial.endsWith('.') && label.startsWith(partial))) {
            items.push({ label, kind: 17, textEdit: { range, newText: label } });
          }
        }
        for (const p of packages) {
          if (labels.has(p)) continue;
          labels.add(p);
          if (!partial || p.startsWith(partial)) {
            items.push({ label: p, kind: 9, textEdit: { range, newText: p } });
          }
        }
        send({ jsonrpc: '2.0', id, result: { isIncomplete: false, items } });
        return;
      }

      let before = beforeCaret;
      if (line[pos.character] === '.') before += '.';
      const dotMatch = before.match(/([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\.\s*$/);
      if (dotMatch) {
        const pathStr = dotMatch[1].replace(/\s+/g, '');
        const imports = resolveImports(uri, doc.text);
        const enclosing = (doc.classAtLine || [])[pos.line] || null;
        const members = resolveMembers(pathStr, doc, imports, enclosing) || GENERIC_MEMBERS;
        for (const mem of members) {
          const item = { label: mem.name, kind: completionKnd(mem) };
          if (mem.kind === 'function' && mem.params) item.detail = signatureOf(mem.name, mem.params, mem.returnType);
          if (mem.doc) item.documentation = mem.doc;
          items.push(item);
        }
        send({ jsonrpc: '2.0', id, result: { isIncomplete: false, items } });
        return;
      }
    }

    for (const k of KW) items.push({ label: k, kind: 14 });
    for (const b of BUILTINS) { if (!BUILTIN_TYPES.has(b)) items.push({ label: b, kind: 3 }); }

    if (doc) {
      const scopeKeys = Object.keys(doc.scope);
      for (const [name, info] of Object.entries(doc.scope)) {
        if (name === 'props') continue;
        if (info.kind === 'builtin' && BUILTIN_TYPES.has(name)) continue;
        if (info.kind === 'parameter') {
          const cursorLine = pos.line + 1;
          if (!info.paramRange || cursorLine < info.paramRange[0] || cursorLine > info.paramRange[1]) continue;
        }
        const kinds = { variable: 6, function: 3, class: 5, parameter: 6, builtin: 3 };
        const item = { label: name, kind: kinds[info.kind] || 6 };
        if (info.kind === 'function' && info.params) item.detail = signatureOf(name, info.params, info.returnType);
        if (info.doc) item.documentation = info.doc;
        items.push(item);
      }

      const imports = resolveImports(uri, doc.text);
      for (const imp of imports) {
        for (const [name, info] of Object.entries(imp.scope)) {
          if (name === 'props') continue;
          if (info.kind === 'builtin') continue;
          if (info.kind === 'parameter') continue;
          if (info.private) continue;
          const label = imp.alias + '.' + name;
          const kinds = { variable: 6, function: 3, class: 5, parameter: 6, builtin: 3 };
          const item = { label, kind: kinds[info.kind] || 6 };
          if (info.kind === 'function' && info.params) item.detail = signatureOf(name, info.params, info.returnType);
          if (info.doc) item.documentation = info.doc;
          items.push(item);
        }
      }
    }
    send({ jsonrpc: '2.0', id, result: { isIncomplete: false, items } });
  }

  if (method === 'textDocument/hover') {
    const uri = params.textDocument.uri;
    const doc = docs.get(uri);
    if (!doc) return send({ jsonrpc: '2.0', id, result: null });
    const line = doc.text.split('\n')[params.position.line];
    if (!line) return send({ jsonrpc: '2.0', id, result: null });
    const word = extractWord(line, params.position.character);
    if (!word) return send({ jsonrpc: '2.0', id, result: null });

    const textBefore = line.slice(0, params.position.character);
    const tailMatch = textBefore.match(/[a-zA-Z0-9_]*$/);
    const wordStart = params.position.character - (tailMatch ? tailMatch[0].length : 0);
    const beforeWord = line.slice(0, wordStart);
    const dotIdx = beforeWord.lastIndexOf('.');
    if (dotIdx !== -1) {
      const objExpr = beforeWord.slice(0, dotIdx).trim().split(/\s+/).pop() || '';
      if (objExpr && !/^\d/.test(objExpr)) {
        const imports = resolveImports(uri, doc.text);
        const enclosing = (doc.classAtLine || [])[params.position.line] || null;
        const members = resolveMembers(objExpr, doc, imports, enclosing);
        if (members) {
          const mem = members.find(mm => mm.name === word);
          if (mem) {
            const mkw = { function: 'function', property: 'property' };
            let mval = `**${word}** — ${mkw[mem.kind] || mem.kind}`;
            if (mem.kind === 'function' && mem.params) mval += `\n\n\`${signatureOf(mem.name, mem.params, mem.returnType)}\``;
            if (mem.doc) mval += `\n\n${mem.doc}`;
            send({ jsonrpc: '2.0', id, result: { contents: { kind: 'markdown', value: mval } }});
            return;
          }
        }
      }
    }

    if (doc.scope[word]) {
      const info = doc.scope[word];
      const kinds = { variable: 'variable', function: 'function', class: 'class', parameter: 'parameter', builtin: 'built-in' };
      let value = `**${word}** — ${kinds[info.kind] || info.kind} (line ${info.line})`;
      if (info.kind === 'function' && info.params) value += `\n\n\`${signatureOf(word, info.params, info.returnType)}\``;
      if (info.doc) value += `\n\n${info.doc}`;
      send({ jsonrpc: '2.0', id, result: { contents: { kind: 'markdown', value } }});
      return;
    }
    send({ jsonrpc: '2.0', id, result: null });
  }

  if (method === 'textDocument/signatureHelp') {
    const uri = params.textDocument.uri;
    const doc = docs.get(uri);
    if (!doc) return send({ jsonrpc: '2.0', id, result: null });
    const line = doc.text.split('\n')[params.position.line];
    if (!line) return send({ jsonrpc: '2.0', id, result: null });

    let col = params.position.character;
    let depth = 0;
    while (col > 0 && line[col] !== '(') { if (line[col] === ')') depth++; col--; }
    if (line[col] !== '(') return send({ jsonrpc: '2.0', id, result: null });
    const before = line.slice(0, col).trim();
    const name = before.split(/[\s,]+/).pop() || '';
    const clean = name.replace(/^\./, '');
    let info = clean && doc.scope[clean];
    if (!info && clean && clean.includes('.')) {
      const parts = clean.split('.');
      const imports = resolveImports(uri, doc.text);
      const imp = imports.find(x => x.alias === parts[0]);
      if (imp) info = parts.slice(1).reduce((s, p) => s && s[p], imp.scope);
    }
    if (info) {
      const kw = { variable: 'variable', function: 'function', class: 'class', parameter: 'parameter', builtin: 'built-in' };
      const baseName = clean.replace(/^.*\./, '');
      const label = info.params ? signatureOf(baseName, info.params, info.returnType) : `${baseName}(...)`;
      const params = (info.params || []).map(p => ({ label: p.type ? p.name + ': ' + p.type : p.name }));
      const documentation = info.doc ? `${kw[info.kind] || ''}\n\n${info.doc}` : (kw[info.kind] || '');
      send({ jsonrpc: '2.0', id, result: { signatures: [{ label, documentation, parameters: params }] }});
      return;
    }
    send({ jsonrpc: '2.0', id, result: { signatures: [] } });
  }

  if (method === 'textDocument/semanticTokens/full') {
    const uri = params.textDocument.uri;
    const doc = docs.get(uri);
    if (!doc || !doc.tokens) return send({ jsonrpc: '2.0', id, result: { data: [] } });

    const typeMap = Object.fromEntries(SEMANTIC_TOKEN_TYPES.map((t, i) => [t, i]));
    const modMap = Object.fromEntries(SEMANTIC_TOKEN_MODIFIERS.map((m, i) => [m, 1 << i]));
    const data = [];
    let prevLine = 0, prevChar = 0;

    for (const tok of doc.tokens) {
      const ttype = typeMap[tok.kind] ?? 0;
      let mods = 0;
      for (const mm of tok.mods) mods |= modMap[mm] ?? 0;
      const dLine = tok.line - prevLine;
      const dChar = dLine === 0 ? tok.start - prevChar : tok.start;
      data.push(dLine, dChar, tok.end - tok.start, ttype, mods);
      prevLine = tok.line;
      prevChar = tok.start;
    }
    send({ jsonrpc: '2.0', id, result: { data } });
  }
}

function offsetFromPos(text, pos) {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < pos.line; i++) offset += lines[i].length + 1;
  return offset + pos.character;
}

function extractWord(line, col) {
  if (col < 0 || col >= line.length) return null;
  let s = col; while (s > 0 && /[a-zA-Z0-9_]/.test(line[s - 1])) s--;
  let e = col; while (e < line.length && /[a-zA-Z0-9_]/.test(line[e])) e++;
  return s < e ? line.slice(s, e) : null;
}

const docs = new Map();

function publishDiagnostics(uri, text, undefs, redefs) {
  const lines = text.split('\n');
  const diags = [];
  for (const u of undefs) {
    const lineStr = lines[u.line - 1] || '';
    diags.push({
      range: {
        start: { line: u.line - 1, character: 0 },
        end: { line: u.line - 1, character: lineStr.length }
      },
      severity: 2,
      message: `Undefined variable '${u.name}'`,
    });
  }
  for (const r of redefs || []) {
    const lineStr = lines[r.line - 1] || '';
    diags.push({
      range: {
        start: { line: r.line - 1, character: 0 },
        end: { line: r.line - 1, character: lineStr.length }
      },
      severity: r.hard ? 2 : 3,
      message: r.hard ? `Duplicate definition of '${r.name}'` : `'${r.name}' is already defined`,
    });
  }
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: diags } });
}

process.stdin.on('data', chunk => {
  buffer += chunk;
  while (true) {
    const hdrEnd = buffer.indexOf('\r\n\r\n');
    if (hdrEnd === -1) break;
    const header = buffer.slice(0, hdrEnd);
    const clMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!clMatch) { buffer = buffer.slice(hdrEnd + 4); continue; }
    const cl = parseInt(clMatch[1]);
    const bodyStart = hdrEnd + 4;
    if (buffer.length < bodyStart + cl) break;
    const body = buffer.slice(bodyStart, bodyStart + cl);
    buffer = buffer.slice(bodyStart + cl);
    try { handle(JSON.parse(body)); } catch (e) {}
  }
});
