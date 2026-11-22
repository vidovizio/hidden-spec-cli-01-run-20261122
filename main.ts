// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ----------------------------------------------------------------------------------------
// Sections 5 to 8 of SPEC.md, written here: the three-tier line matching, the unified diff
// reader, the SEARCH/REPLACE reader and the V4A reader. Each reader turns patch text into
// edits of the same shape the JSON reader makes, so the writing stays all-or-nothing.

interface Doc {
  lines: string[];
  eol: string;
  final: boolean;
}

// A file's text as its lines, its own break, and whether it ends with that break (section 3).
function readDoc(text: string): Doc {
  if (text === '') return { lines: [], eol: '\n', final: false };
  const nl = text.indexOf('\n');
  const eol = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(eol);
  let final = false;
  if (text.endsWith(eol)) {
    parts.pop();
    final = true;
  }
  return { lines: parts, eol, final };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.eol) + (d.final ? d.eol : '');
}

const isWS = (c: string): boolean => c === ' ' || c === '\t';

function leadWS(s: string): string {
  let i = 0;
  while (i < s.length && isWS(s[i]!)) i += 1;
  return s.slice(0, i);
}

// tier 0: the line itself; tier 1: no trailing blanks; tier 2: no leading or trailing blanks.
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  let a = 0;
  let b = s.length;
  if (tier === 2) while (a < b && isWS(s[a]!)) a += 1;
  while (b > a && isWS(s[b - 1]!)) b -= 1;
  return s.slice(a, b);
}

function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const top = Math.min(from, lines.length);
  for (let i = top < 0 ? 0 : top; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Tiered {
  tier: number;
  pos: number[];
}

// The first tier at which o occurs at or after from (tier 0 alone with --strict).
function firstTier(lines: string[], o: string[], strict: boolean, from: number, only?: (p: number) => boolean): Tiered | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t += 1) {
    let p = occurrences(lines, o, t, from);
    if (only !== undefined) p = p.filter(only);
    if (p.length > 0) return { tier: t, pos: p };
  }
  return null;
}

type ItemKind = 'ctx' | 'del' | 'add';

// One line of a hunk or chunk body; noEol marks it as followed by a `` line.
interface Item {
  kind: ItemKind;
  text: string;
  noEol: boolean;
}

// N: context lines take the file's own matched line, `+` lines their text, and at tier 2 the
// other lines are re-indented from the file's first matched line (section 5).
function renderNew(items: Item[], o: string[], fileLines: string[], at: number, tier: number): string[] {
  const out: string[] = [];
  const own: boolean[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'del') {
      oi += 1;
      continue;
    }
    if (it.kind === 'ctx') {
      const ownLine = fileLines[at + oi];
      out.push(ownLine === undefined ? it.text : ownLine);
      own.push(true);
      oi += 1;
      continue;
    }
    out.push(it.text);
    own.push(false);
  }
  if (tier === 2 && o.length > 0) {
    const f = leadWS(fileLines[at] ?? '');
    const p = leadWS(o[0]!);
    for (let i = 0; i < out.length; i += 1) {
      if (own[i]) continue;
      const t = out[i]!;
      if (blank(t) || !t.startsWith(p)) continue;
      out[i] = f + t.slice(p.length);
    }
  }
  return out;
}

function oldLinesOf(items: Item[]): string[] {
  const o: string[] = [];
  for (const it of items) if (it.kind !== 'add') o.push(it.text);
  return o;
}

// A hunk or chunk whose lines are not in the file: the section fails, the tree does not change.
class NoMatch {
  readonly code: string;
  constructor(code: string) {
    this.code = code;
  }
}

// Moves a successful move edit made, for the `R <old> -> <new>` lines of section 2.
let moves: { from: string; to: string }[] = [];

// ------------------------------------------------------------------ section 6: unified diffs

interface Hunk {
  a: number;
  body: Item[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  fileOld: string | null;
  fileOldSet: boolean;
  fileNew: string | null;
  fileNewSet: boolean;
  renOld: string | null;
  renNew: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function newSection(gitOld: string | null, gitNew: string | null): Section {
  return {
    gitOld,
    gitNew,
    fileOld: null,
    fileOldSet: false,
    fileNew: null,
    fileNewSet: false,
    renOld: null,
    renNew: null,
    newFile: false,
    delFile: false,
    hunks: [],
  };
}

// A `--- ` or `+++ ` path: after the four characters, up to a tab, spaces trimmed, `a/` or
// `b/` dropped, and `/dev/null` meaning no file.
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function namePath(line: string): string {
  let t = line.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^a\/(\S+) b\/(\S+)$/.exec(line.slice('diff --git '.length));
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(m[1]!, m[2]!);
      sections.push(cur);
      i += 1;
      continue;
    }
    const next = lines[i + 1] ?? '';
    if (line.startsWith('--- ')) {
      const inHeader = cur !== null && cur.hunks.length === 0;
      if (inHeader) {
        if (!next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur!.fileOldSet = true;
        cur!.fileOld = headerPath(line);
        cur!.fileNewSet = true;
        cur!.fileNew = headerPath(next);
        i += 2;
        continue;
      }
      if (next.startsWith('+++ ')) {
        const fresh = newSection(null, null);
        fresh.fileOldSet = true;
        fresh.fileOld = headerPath(line);
        fresh.fileNewSet = true;
        fresh.fileNew = headerPath(next);
        sections.push(fresh);
        cur = fresh;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      i += 1;
      let trailing = 0;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b === '') {
          hunk.body.push({ kind: 'ctx', text: '', noEol: false });
          trailing += 1;
          i += 1;
          continue;
        }
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        const c = b[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          hunk.body.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add', text: b.slice(1), noEol: false });
          trailing = 0;
          i += 1;
          continue;
        }
        if (c === '\\') {
          if (hunk.body.length > 0) hunk.body[hunk.body.length - 1]!.noEol = true;
          trailing = 0;
          i += 1;
          continue;
        }
        break;
      }
      if (trailing > 0) hunk.body.splice(hunk.body.length - trailing, trailing);
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) {
        cur.renOld = namePath(line.slice('rename from '.length));
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renNew = namePath(line.slice('rename to '.length));
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.delFile = true;
        i += 1;
        continue;
      }
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean): void {
  let d = 0;
  for (const hunk of hunks) {
    const o = oldLinesOf(hunk.body);
    const target = hunk.a - 1 + d;
    let at: number;
    let tier = 0;
    if (o.length === 0) {
      at = Math.max(0, Math.min(hunk.a + d, doc.lines.length));
    } else {
      const found = firstTier(doc.lines, o, strict, 0);
      if (found === null) throw new NoMatch('no-match');
      tier = found.tier;
      at = found.pos[0]!;
      for (const p of found.pos) if (Math.abs(p - target) < Math.abs(at - target)) at = p;
    }
    const n = renderNew(hunk.body, o, doc.lines, at, tier);
    const touchesEnd = at + o.length === doc.lines.length;
    doc.lines = [...doc.lines.slice(0, at), ...n, ...doc.lines.slice(at + o.length)];
    if (touchesEnd) {
      let last: Item | null = null;
      for (const it of hunk.body) if (it.kind !== 'del') last = it;
      doc.final = last === null ? true : !last.noEol;
    }
    d += n.length - o.length;
  }
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldPath = sec.fileOldSet ? sec.fileOld : sec.renOld !== null ? sec.renOld : sec.gitOld;
    const newPath = sec.fileNewSet ? sec.fileNew : sec.renNew !== null ? sec.renNew : sec.gitNew;
    const creation = sec.newFile || (sec.fileOldSet && sec.fileOld === null);
    const deletion = sec.delFile || (sec.fileNewSet && sec.fileNew === null);
    if (creation) {
      const target = newPath ?? oldPath ?? '';
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const adds: Item[] = [];
      for (const hunk of sec.hunks) for (const it of hunk.body) if (it.kind === 'add') adds.push(it);
      const doc: Doc = { lines: adds.map((it) => it.text), eol: '\n', final: true };
      if (adds.length > 0 && adds[adds.length - 1]!.noEol) doc.final = false;
      tree.now.set(target, writeDoc(doc));
      return;
    }
    if (deletion) {
      const target = oldPath ?? '';
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    if (oldPath === null) throw new Fail('missing', newPath ?? '');
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    const move = newPath !== null && newPath !== oldPath;
    if (move && tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
    const doc = readDoc(before);
    try {
      applyHunks(doc, sec.hunks, strict);
    } catch (e) {
      if (e instanceof NoMatch) throw new Fail(e.code, oldPath);
      throw e;
    }
    if (move) {
      tree.now.set(oldPath, null);
      tree.now.set(newPath!, writeDoc(doc));
      moves.push({ from: oldPath, to: newPath! });
    } else {
      tree.now.set(oldPath, writeDoc(doc));
    }
  };
}

// --------------------------------------------------------------- section 7: SEARCH/REPLACE

const SR_SEARCH = '<<<<<<< SEARCH';
const SR_SPLIT = '=======';
const SR_REPLACE = '>>>>>>> REPLACE';

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let blockEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== SR_SEARCH) {
      i += 1;
      continue;
    }
    const at = i;
    let path: string | null = null;
    for (let k = at - 1; k > blockEnd; k -= 1) {
      const t = lines[k]!;
      if (blank(t)) continue;
      const s = t.trim();
      if (s.startsWith('```')) continue;
      path = s;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${at + 1}`);
    let split = at + 1;
    // SPEC 7: a SEARCH line with no `=======` and then `>>>>>>> REPLACE` after it is a parse
    // fault at the SEARCH line. Stop at that marker: reading on would take the next block's
    // `=======` and turn a malformed block into a bogus edit instead of a parse error.
    while (split < lines.length && lines[split]!.trimEnd() !== SR_SPLIT) {
      if (lines[split]!.trimEnd() === SR_REPLACE) throw new Exit2(`error: parse ${at + 1}`);
      split += 1;
    }
    if (split >= lines.length) throw new Exit2(`error: parse ${at + 1}`);
    let end = split + 1;
    while (end < lines.length && lines[end]!.trimEnd() !== SR_REPLACE) end += 1;
    if (end >= lines.length) throw new Exit2(`error: parse ${at + 1}`);
    edits.push(searchEdit(path, lines.slice(at + 1, split), lines.slice(split + 1, end), strict));
    prevPath = path;
    blockEnd = end;
    i = end + 1;
  }
  return edits;
}

function searchEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (oldLines.length === 0) {
      if (before !== null) throw new Fail('exists', path);
      const doc: Doc = { lines: newLines, eol: '\n', final: true };
      tree.now.set(path, writeDoc(doc));
      return;
    }
    if (before === null) throw new Fail('missing', path);
    const doc = readDoc(before);
    const found = firstTier(doc.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const items: Item[] = newLines.map((t) => ({ kind: 'add' as ItemKind, text: t, noEol: false }));
    const n = renderNew(items, oldLines, doc.lines, at, found.tier);
    doc.lines = [...doc.lines.slice(0, at), ...n, ...doc.lines.slice(at + oldLines.length)];
    tree.now.set(path, writeDoc(doc));
  };
}

// ------------------------------------------------------------------------ section 8: V4A

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: Item[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: Chunk[];
}

const V_BEGIN = '*** Begin Patch';
const V_END = '*** End Patch';
const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';
const V_EOF = '*** End of File';

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== V_BEGIN) throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== V_END) throw new Exit2(`error: parse ${lines.length + 1}`);
  const isStart = (l: string): boolean => l.startsWith(V_ADD) || l.startsWith(V_DEL) || l.startsWith(V_UPD);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let sec: VSection;
    if (line.startsWith(V_ADD)) sec = { kind: 'add', path: line.slice(V_ADD.length).trim(), moveTo: null, lines: [], chunks: [] };
    else if (line.startsWith(V_DEL)) sec = { kind: 'del', path: line.slice(V_DEL.length).trim(), moveTo: null, lines: [], chunks: [] };
    else if (line.startsWith(V_UPD)) sec = { kind: 'upd', path: line.slice(V_UPD.length).trim(), moveTo: null, lines: [], chunks: [] };
    else throw new Exit2(`error: parse ${i + 1}`);
    const head = i;
    i += 1;
    const start = i;
    while (i < last && !isStart(lines[i]!)) i += 1;
    let end = i;
    while (end > start && blank(lines[end - 1]!)) end -= 1;
    sections.push(sec);
    if (sec.kind === 'add') {
      for (let k = start; k < end; k += 1) {
        const b = lines[k]!;
        if (b === '') sec.lines.push('');
        else if (b.startsWith('+')) sec.lines.push(b.slice(1));
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      continue;
    }
    if (sec.kind === 'del') {
      for (let k = start; k < end; k += 1) if (!blank(lines[k]!)) throw new Exit2(`error: parse ${k + 1}`);
      continue;
    }
    let k = start;
    if (k < end && lines[k]!.startsWith(V_MOVE)) {
      sec.moveTo = lines[k]!.slice(V_MOVE.length).trim();
      k += 1;
    }
    let chunk: Chunk | null = null;
    for (; k < end; k += 1) {
      const b = lines[k]!;
      if (chunk !== null && chunk.eof && blank(b)) continue;
      if (b.startsWith('@@')) {
        const text = b.slice(2).trim();
        chunk = { anchor: text === '' ? null : text, eof: false, body: [] };
        sec.chunks.push(chunk);
        continue;
      }
      if (b.trim() === V_EOF) {
        // A `*** End of File` line ends the chunk, so it cannot end a chunk twice.
        if (chunk === null || chunk.eof) throw new Exit2(`error: parse ${k + 1}`);
        chunk.eof = true;
        continue;
      }
      const c = b[0];
      if (b === '' || c === ' ' || c === '-' || c === '+') {
        // The chunk ended at its `*** End of File` line: only a new `@@` chunk may hold body lines now.
        if (chunk !== null && chunk.eof) throw new Exit2(`error: parse ${k + 1}`);
        if (chunk === null) {
          chunk = { anchor: null, eof: false, body: [] };
          sec.chunks.push(chunk);
        }
        const kind: ItemKind = b === '' || c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add';
        chunk.body.push({ kind, text: b === '' ? '' : b.slice(1), noEol: false });
        continue;
      }
      throw new Exit2(`error: parse ${k + 1}`);
    }
    if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${head + 1}`);
  }
  return sections.map((s) => v4aEdit(s, strict));
}

function anchorAt(lines: string[], anchor: string, strict: boolean, from: number): number {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t += 1) {
    const want = normLine(anchor, t);
    for (let i = from; i < lines.length; i += 1) if (normLine(lines[i]!, t) === want) return i;
  }
  return -1;
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      const doc: Doc = { lines: sec.lines, eol: '\n', final: true };
      tree.now.set(sec.path, writeDoc(doc));
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    const move = sec.moveTo !== null && sec.moveTo !== sec.path;
    if (move && tree.get(sec.moveTo!) !== null) throw new Fail('exists', sec.moveTo!);
    const doc = readDoc(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const a = anchorAt(doc.lines, chunk.anchor, strict, cursor);
        if (a < 0) throw new Fail('no-match', sec.path);
        cursor = a + 1;
      }
      const o = oldLinesOf(chunk.body);
      let at: number;
      let tier = 0;
      if (o.length === 0) {
        at = chunk.eof ? doc.lines.length : Math.min(cursor, doc.lines.length);
      } else {
        const endsAtEnd = (p: number): boolean => p + o.length === doc.lines.length;
        const found = firstTier(doc.lines, o, strict, cursor, chunk.eof ? endsAtEnd : undefined);
        if (found === null) throw new Fail('no-match', sec.path);
        tier = found.tier;
        at = found.pos[0]!;
      }
      const n = renderNew(chunk.body, o, doc.lines, at, tier);
      doc.lines = [...doc.lines.slice(0, at), ...n, ...doc.lines.slice(at + o.length)];
      cursor = at + n.length;
    }
    if (move) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo!, writeDoc(doc));
      moves.push({ from: sec.path, to: sec.moveTo! });
    } else {
      tree.now.set(sec.path, writeDoc(doc));
    }
  };
}


function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else throw new Exit2('error: parse 1');
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  moves = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { path: string; was: string | null; now: string | null }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.push({ path: p, was, now });
  }
  // A move that succeeded shows as `R <old> -> <new>` instead of that pair's `D` and `A`.
  const moved = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const m of moves) {
    const a = changed.find((c) => c.path === m.from);
    const b = changed.find((c) => c.path === m.to);
    if (a === undefined || b === undefined) continue;
    if (a.was === null || a.now !== null || b.was !== null || b.now === null) continue;
    moved.add(m.from);
    moved.add(m.to);
    rows.push({ key: m.to, text: `R ${m.from} -> ${m.to}` });
  }
  for (const c of changed) {
    if (moved.has(c.path)) continue;
    rows.push({ key: c.path, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${c.path}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  const out = rows.map((r) => r.text);
  if (!check) {
    for (const c of changed) {
      if (c.now === null) rmSync(c.path, { force: true });
      else {
        mkdirSync(dirname(c.path), { recursive: true });
        writeFileSync(c.path, c.now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
