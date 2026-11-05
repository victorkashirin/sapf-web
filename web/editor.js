// The code editor: CodeMirror 6 with the vs-sapf extension's features (highlighting, hover docs,
// completion, line/block/paragraph evaluation with a flash, formatting). Bundled by `npm run build`.
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, hoverTooltip, keymap } from '@codemirror/view';
import { StreamLanguage, LanguageSupport } from '@codemirror/language';
import { completionStatus } from '@codemirror/autocomplete';
import docs from './build/sapf-docs.json';
import { lineAt, blockAt, paragraphAt, formatSapf, playsSound } from './sapf-text.mjs';
export { lineAt, playsSound }; // for the page's Run button and replace option

const byName = new Map(docs.map(d => [d.name, d]));
const WORD = /[^\s()[\]{}";]/; // sapf words include operators: + *, >sf, sf>, +/ ...

const sapfLang = StreamLanguage.define({
  startState: () => ({ def: false, params: false, str: false }),
  token(stream, s) {
    // Strings may span lines and have no quote escape (a doubled "" is two adjacent strings here).
    if (s.str || stream.eat('"')) {
      s.str = !stream.match(/^[^"]*"/);
      if (s.str) stream.skipToEnd();
      return 'string';
    }
    if (stream.eatSpace()) return null;
    if (stream.match(/^;.*/)) return 'comment';
    if (stream.eat('\\')) { s.params = true; return 'keyword'; } // \a b [ ... ] : a and b are parameters
    if (stream.match(/^[[\]{}()]/) || stream.match('#[')) { s.params = false; return 'bracket'; }
    stream.eatWhile(WORD);
    const w = stream.current();
    if (s.params) return 'variableName.definition';
    if (s.def) { s.def = false; return 'variableName.definition'; }
    if (w === '=') { s.def = true; return 'operator'; }
    if (/^-?(\d|\.\d)/.test(w)) return 'number';
    if (w[0] === '\'' || w[0] === '`') return 'atom';
    return byName.has(w) ? 'keyword' : 'variableName';
  },
  languageData: { commentTokens: { line: ';' } },
});

function docDom(d) {
  const el = document.createElement('div');
  el.className = 'sapf-doc';
  const sig = document.createElement('code'), cat = document.createElement('div'), desc = document.createElement('div');
  sig.textContent = [d.name, d.special && '@' + d.special, d.sig].filter(Boolean).join(' ');
  cat.textContent = d.category;
  cat.className = 'sapf-doc-cat';
  desc.textContent = d.desc;
  el.append(sig, cat, desc);
  return el;
}

const hover = hoverTooltip((view, pos) => {
  const line = view.state.doc.lineAt(pos);
  let from = pos - line.from, to = from;
  while (from > 0 && WORD.test(line.text[from - 1])) from--;
  while (to < line.text.length && WORD.test(line.text[to])) to++;
  const d = byName.get(line.text.slice(from, to));
  return d && { pos: line.from + from, end: line.from + to, above: true, create: () => ({ dom: docDom(d) }) };
});

const options = docs.map(d => ({ label: d.name, type: 'function', detail: d.sig ?? '', info: () => docDom(d) }));
function complete(ctx) {
  const word = ctx.matchBefore(/[\w$?!]+/);
  if (!word && !ctx.explicit) return null;
  return { from: word ? word.from : ctx.pos, options, validFor: /^[\w$?!]*$/ };
}

// Briefly highlights the evaluated range, like the extension's flash.
const flashEffect = StateEffect.define();
const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(flashEffect)) {
      return e.value ? Decoration.set(Decoration.mark({ class: 'sapf-flash' }).range(e.value.from, e.value.to)) : Decoration.none;
    }
    return deco.map(tr.changes);
  },
  provide: f => EditorView.decorations.from(f),
});

// run(code) evaluates code in sapf. Returns the EditorView.
export function createEditor(parent, doc, run) {
  let flashTimer;
  const evalWith = pick => view => {
    const { from, to } = view.state.selection.main;
    const r = pick(view.state.doc.toString(), from, to);
    if (r.from < r.to) {
      view.dispatch({ effects: flashEffect.of(r) });
      clearTimeout(flashTimer); // a pending clear from an earlier eval would cut this flash short
      flashTimer = setTimeout(() => view.dispatch({ effects: flashEffect.of(null) }), 200);
    }
    if (r.code.trim()) run(r.code);
    return true;
  };
  const send = code => () => (run(code), true);
  // Replaces only the lines that change (formatSapf keeps the line count), so the cursor stays on its line.
  const format = view => {
    const { doc } = view.state, changes = [];
    formatSapf(doc.toString()).split('\n').forEach((text, i) => {
      const line = doc.line(i + 1);
      if (line.text !== text) changes.push({ from: line.from, to: line.to, insert: text });
    });
    if (changes.length) view.dispatch({ changes });
    return true;
  };
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        // Highest precedence: Mod-Enter is "insert blank line" in the default keymap.
        Prec.highest(keymap.of([
          { key: 'Mod-Enter', run: evalWith(lineAt) },
          { key: 'Shift-Enter', run: evalWith(blockAt) },
          { key: 'Mod-Shift-Enter', run: evalWith(paragraphAt) },
          { key: 'Mod-.', run: send('stop') },
          // Esc stops unless it is closing the completion popup. Returning false lets the default Esc
          // (collapse the selection) run too, which would otherwise swallow the key when text is selected.
          { key: 'Escape', run: view => { if (!completionStatus(view.state)) run('stop'); return false; } },
          { key: 'Mod-Shift-.', run: send('clear') },
          { key: 'Shift-Alt-f', run: format }, // the extension's Cmd/Ctrl+Shift+I opens devtools in browsers
        ])),
        basicSetup,
        new LanguageSupport(sapfLang, sapfLang.data.of({ autocomplete: complete })),
        hover,
        flashField,
        EditorView.theme({
          '&': { border: '1px solid #ccc', fontSize: '14px' },
          '.cm-scroller': { fontFamily: 'inherit' },
          '.cm-content, .cm-gutter': { minHeight: '160px' },
          '.sapf-flash': { backgroundColor: '#ffe58a' },
          '.sapf-doc': { padding: '4px 8px', maxWidth: '520px', whiteSpace: 'pre-wrap' },
          '.sapf-doc-cat': { color: '#888', margin: '2px 0' },
        }),
      ],
    }),
  });
}
