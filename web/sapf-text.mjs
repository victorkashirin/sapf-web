// Text logic ported from the vs-sapf VS Code extension (src/text/*), as pure functions over a string.
// Each eval helper takes the text and the selection (from, to) and returns { from, to, code }:
// the range to flash and the code to evaluate. A non-empty selection always wins.

const selection = (text, from, to) => from !== to && { from, to, code: text.slice(from, to) };

const CODE = 0, STRING = 1, COMMENT = 2;
// The kind of each character, as sapf's parser sees it: code, inside a "string" (quotes included; strings
// may span lines and have no quote escape, a doubled "" is a quote, which toggling handles), or inside a
// ; comment. The newline that ends a comment is code.
function scan(text) {
  const kind = new Uint8Array(text.length);
  let k = CODE;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (k === CODE && c === '"') k = STRING;
    else if (k === CODE && c === ';') k = COMMENT;
    else if ((k === STRING && c === '"') || (k === COMMENT && c === '\n')) { kind[i] = k === STRING ? STRING : CODE; k = CODE; continue; }
    kind[i] = k;
  }
  return kind;
}

function lineBounds(text, pos) {
  const from = pos > 0 ? text.lastIndexOf('\n', pos - 1) + 1 : 0, end = text.indexOf('\n', pos);
  return { from, to: end < 0 ? text.length : end };
}

// The selection, or the line under the cursor.
export function lineAt(text, from, to = from) {
  if (selection(text, from, to)) return selection(text, from, to);
  const r = lineBounds(text, from);
  return { ...r, code: text.slice(r.from, r.to).trim() };
}

// The selection, or the contents of the outermost ( ) block around the cursor, or the line.
// Brackets inside strings and comments don't count (the extension counts them).
export function blockAt(text, from, to = from) {
  if (selection(text, from, to)) return selection(text, from, to);
  const kind = scan(text), stack = [];
  let start = -1, end = -1;
  for (let i = 0; i < text.length; i++) {
    if (kind[i] !== CODE) continue;
    if (text[i] === '(') stack.push(i);
    else if (text[i] === ')' && stack.length) {
      const open = stack.pop();
      // The extension needs the cursor strictly before ')'; here a cursor right before it counts too.
      if (open < from && i >= from && (start === -1 || open < start)) { start = open; end = i; }
    }
  }
  return start === -1 ? lineAt(text, from) : { from: start, to: end + 1, code: text.slice(start + 1, end) };
}

// The selection, or the paragraph (lines between blank lines) around the cursor.
export function paragraphAt(text, from, to = from) {
  if (selection(text, from, to)) return selection(text, from, to);
  const lines = text.split('\n');
  const row = text.slice(0, from).split('\n').length - 1;
  if (!lines[row].trim()) return lineAt(text, from);
  let first = row, last = row;
  while (first > 0 && lines[first - 1].trim()) first--;
  while (last < lines.length - 1 && lines[last + 1].trim()) last++;
  const start = lines.slice(0, first).join('\n').length + (first > 0 ? 1 : 0);
  const end = start + lines.slice(first, last + 1).join('\n').length;
  return { from: start, to: end, code: text.slice(start, end).trim() };
}

// Whether code calls `play` or `record` (outside strings and comments), so evaluating it starts a sound.
// shortcut: a function that plays, called by name, isn't seen; would need sapf to report new players.
export function playsSound(code) {
  const kind = scan(code);
  return [...code.matchAll(/(?<=^|[\s()[\]{}])(play|record)(?=$|[\s()[\]{};"])/g)].some(m => kind[m.index] === CODE);
}

// Collapses runs of spaces and indents by bracket depth, 2 spaces per level (extension's formatSapfCode).
// Strings and comments are left as they are, and their brackets don't count; a line that starts inside
// a string is not re-indented.
export function formatSapf(text) {
  const kind = scan(text);
  let depth = 0, at = 0;
  return text.split('\n').map(line => {
    const startsInString = at > 0 && kind[at - 1] === STRING; // the newline before this line
    let out = '', space = false, delta = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i], code = kind[at + i] === CODE;
      if (code && /\s/.test(c)) { space = true; continue; }
      if (space && out) out += ' ';
      space = false;
      out += c;
      if (code) delta += '([{'.includes(c) ? 1 : ')]}'.includes(c) ? -1 : 0;
    }
    at += line.length + 1;
    const indent = startsInString || !out ? 0 : /^[)\]}]/.test(out) ? Math.max(0, depth - 1) : depth;
    depth = Math.max(0, depth + delta);
    return ' '.repeat(indent * 2) + out;
  }).join('\n');
}

// Parses sapf's `helpall` output into [{ name, category, special, sig, desc }].
// Lines look like ` sinosc @zz (freq phase --> out) sine wave oscillator.` or ` ev-base - a form ...`;
// indented lines continue the previous entry's description.
export function parseHelp(out) {
  const docs = [];
  let category = null, last = null;
  const paren = String.raw`(?:[^()]|\([^()]*\))*`; // one level of nesting: (seq index(es) --> value(s))
  const entry = new RegExp(String.raw`^ (\S+) (?:@(\w+) )?(\(${paren}-->${paren}\))?\s*(?:- )?(.*)$`);
  for (const line of out.split('\n')) {
    let m;
    if ((m = line.match(/^\*\*\* (.+) \*\*\*$/))) { category = m[1]; last = null; }
    else if (category && (m = line.match(entry))) {
      last = { name: m[1], category, special: m[2] ?? null, sig: m[3] ?? null, desc: m[4].trim() };
      docs.push(last);
    } else if (last && /^(\s{2,}|\t)\S/.test(line)) last.desc += '\n' + line.trim();
  }
  return docs;
}
