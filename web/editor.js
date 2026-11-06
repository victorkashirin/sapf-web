// The code editor: CodeMirror 6 with the vs-sapf extension's features (highlighting, hover docs,
// completion, line/block/paragraph evaluation with a flash, formatting). Bundled by `npm run build`.
import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, hoverTooltip, keymap } from '@codemirror/view';
import { StreamLanguage, LanguageSupport, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { completionStatus } from '@codemirror/autocomplete';
import docs from './build/sapf-docs.json';
import { lineAt, blockAt, paragraphAt, formatSapf, playsSound } from './sapf-text.mjs';
export { lineAt, blockAt, paragraphAt, playsSound }; // for the page's run buttons and Solo

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

// run(code) evaluates code in sapf; onChange(text), if given, gets the text after each edit. Returns the EditorView,
// with evalWith(lineAt | blockAt | paragraphAt), setTheme(name) (a key of `themes`) and setDoc(text): replaces the text and the undo history (so undo can't bring back another file), without onChange.
export function createEditor(parent, doc, run, onChange) {
  let flashTimer, themeName = 'amber';
  const palette = new Compartment();
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
  const extensions = [
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
    // On a Mac, Option+Shift+F types "Ï", and the keymap above never maps an Option-only combo back to
    // its key (Option is how Mac users type characters), so match the physical key instead.
    Prec.highest(EditorView.domEventHandlers({
      keydown: (e, view) => e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyF'
        && (e.preventDefault(), format(view)),
    })),
    basicSetup,
    new LanguageSupport(sapfLang, sapfLang.data.of({ autocomplete: complete })),
    hover,
    flashField,
    theme,
    palette.of(syntaxHighlighting(themes.amber)),
    EditorView.updateListener.of(u => { if (u.docChanged && onChange) onChange(u.state.doc.toString()); }),
  ];
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions }) });
  view.evalWith = pick => evalWith(pick)(view); // the run buttons: same flash and code as the keys
  view.setTheme = name => {
    themeName = themes[name] ? name : 'amber';
    view.dispatch({ effects: palette.reconfigure(syntaxHighlighting(themes[themeName])) });
  };
  view.setDoc = text => {
    view.setState(EditorState.create({ doc: text, extensions }));
    view.setTheme(themeName); // the new state starts from the compartment's initial theme
    view.scrollDOM.scrollTo(0, 0); // setState keeps the old scroll position
  };
  return view;
}

// Dark "screen" look; the page draws the bezel around it.
const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--code-size, 14px)', color: '#c8ccd2', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.55' },
  '.cm-content': { caretColor: '#ffb454', padding: '10px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid #ffb454' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: '#2c3a4d' },
  '.cm-gutters': { backgroundColor: 'transparent', color: '#4a5059', border: 'none', borderRight: '1px solid #23272d' },
  '.cm-activeLine': { backgroundColor: '#ffffff08' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#9aa1ab' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: '#ffb45426', outline: 'none' },
  '.cm-searchMatch': { backgroundColor: '#ffb45433' },
  '.cm-panels': { backgroundColor: '#1a1d21', color: '#c8ccd2' },
  // an engraved edge against the code: a dark groove, then the bezels' faint highlight
  '.cm-panels-bottom': { borderTop: '1px solid #000', boxShadow: 'inset 0 1px 0 #ffffff14, 0 -4px 12px #0006' },
  '.cm-panels-top': { borderBottom: '1px solid #000', boxShadow: 'inset 0 -1px 0 #ffffff14, 0 4px 12px #0006' },
  // search panel: inputs like the File menu's, buttons as the page's keycaps, all in the button font, a plain × close
  '.cm-panel.cm-search': { padding: '4px 36px 6px 6px' },
  '.cm-panel.cm-search > *': { verticalAlign: 'middle' },
  '.cm-textfield': { font: '13px var(--ui)', color: '#c8ccd2', padding: '4px 8px', border: 0, borderRadius: '4px',
    backgroundColor: '#121417', boxShadow: 'inset 0 1px 3px #000' },
  '.cm-textfield:focus': { outline: '1px solid #ffb45480' },
  '.cm-panel.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '4px', font: '12px var(--ui)',
    textTransform: 'uppercase', color: '#7d848e' },
  // the extra .cm-panel.cm-search outranks CodeMirror's own &light/&dark .cm-button
  '.cm-panel.cm-search .cm-button': { font: '12px var(--ui)', color: '#d6d9de', padding: '5px 12px', margin: '4px 6px 4px 0',
    border: '1px solid #0009', borderRadius: '5px', backgroundImage: 'linear-gradient(#4a4e55, #33363b)',
    boxShadow: 'inset 0 1px 0 #ffffff26, 0 2px 0 #131518, 0 3px 6px #0007' },
  '.cm-panel.cm-search .cm-button:hover': { backgroundImage: 'linear-gradient(#52565e, #383b41)' },
  '.cm-panel.cm-search .cm-button:active': { transform: 'translateY(2px)', backgroundImage: 'linear-gradient(#36393e, #303338)',
    boxShadow: 'inset 0 1px 2px #0008, 0 0 0 #131518' },
  '.cm-panel.cm-search input[type=checkbox]': { margin: 0, accentColor: '#ffb454' },
  '.cm-panel.cm-search [name=close]': { top: '50%', right: '8px', transform: 'translateY(-50%)', width: '24px', height: '24px',
    fontSize: '18px', lineHeight: '1', color: '#7d848e', background: 'none', boxShadow: 'none', textTransform: 'none' },
  '.cm-panel.cm-search [name=close]:hover': { color: '#c8ccd2', background: 'none' },
  '.cm-tooltip': { backgroundColor: '#1e2126', color: '#c8ccd2', border: '1px solid #343a42', borderRadius: '4px',
    boxShadow: '0 6px 18px #000a' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: '#2c3a4d', color: '#fff' },
  '.sapf-flash': { backgroundColor: '#ffb45455' },
  '.sapf-doc': { padding: '4px 8px', maxWidth: '520px', whiteSpace: 'pre-wrap' },
  '.sapf-doc-cat': { color: '#7d848e', margin: '2px 0' },
}, { dark: true });

// Syntax colours, picked in the editor's settings. Order: keyword, string, number, comment, atom,
// operator, bracket, definition, other words; comments are italic except in `contrast`.
const style = (k, s, n, c, a, o, b, d, v, italic = true) => HighlightStyle.define([
  { tag: t.keyword, color: k },
  { tag: t.string, color: s },
  { tag: t.number, color: n },
  { tag: t.comment, color: c, fontStyle: italic ? 'italic' : 'normal' },
  { tag: t.atom, color: a },
  { tag: t.operator, color: o },
  { tag: t.bracket, color: b },
  { tag: t.definition(t.variableName), color: d },
  { tag: t.variableName, color: v },
]);
export const themes = {
  amber: style('#ffb454', '#a6d189', '#79c0ff', '#5c636d', '#d2a8ff', '#ff7b72', '#7d848e', '#f2cc60', '#c8ccd2'),
  phosphor: style('#7ee787', '#b4f0b8', '#a8e6a3', '#3f6a49', '#9fe0a0', '#7ee787', '#4f7d5a', '#d2f7cf', '#9fcfa4'),
  contrast: style('#ffcc66', '#b5f28a', '#8fd0ff', '#8a929c', '#e3c2ff', '#ff9488', '#aab2bc', '#ffe08a', '#f0f2f5', false),
  plain: style('#e6e8eb', '#c8ccd2', '#c8ccd2', '#5c636d', '#c8ccd2', '#c8ccd2', '#7d848e', '#e6e8eb', '#c8ccd2'),
};
