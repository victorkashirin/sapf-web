// Tests for sapf-text.mjs: node web/sapf-text.test.mjs
import assert from 'node:assert/strict';
import { lineAt, blockAt, paragraphAt, formatSapf, parseHelp } from './sapf-text.mjs';

const t = 'a 1\n(\n  440 0 sinosc\n  (2 *) play\n)\n\nb 2\nc 3';
const at = s => t.indexOf(s);

assert.deepEqual(lineAt(t, at('440')), { from: at('  440'), to: at('\n  (2'), code: '440 0 sinosc' });
assert.deepEqual(lineAt(t, 0, 3), { from: 0, to: 3, code: 'a 1' }, 'selection wins');

// outermost block, from inside the inner one and right before the closing bracket
const outer = { from: at('(\n'), to: at(')\n\n') + 1, code: '\n  440 0 sinosc\n  (2 *) play\n' };
assert.deepEqual(blockAt(t, at('2 *')), outer);
assert.deepEqual(blockAt(t, at(')\n\n')), outer);
assert.equal(blockAt(t, at('b 2')).code, 'b 2', 'no block: the line');
// brackets in comments and strings (which may span lines) don't count
const u = '; a )\n(1 ")\n(" pr)';
assert.deepEqual(blockAt(u, u.indexOf('1')), { from: u.indexOf('(1'), to: u.length, code: '1 ")\n(" pr' });

assert.deepEqual(lineAt('\na', 0), { from: 0, to: 0, code: '' }, 'empty first line');

assert.deepEqual(paragraphAt(t, at('3')), { from: at('b 2'), to: t.length, code: 'b 2\nc 3' });
assert.equal(paragraphAt(t, 1).code, t.slice(0, at('\n\n')));
assert.equal(paragraphAt(t, at('\n\n') + 1).code, '', 'blank line: the (empty) line');

assert.equal(formatSapf('(\n440   0 sinosc\n[1\n2]\n;; c\n)'), '(\n  440 0 sinosc\n  [1\n    2]\n  ;; c\n)');
// strings and comments keep their spacing and their brackets don't indent; a line inside a string stays put
assert.equal(formatSapf('  "a  (b"   pr ; x  (\n1   2\n"s\n   t" ( \n3'), '"a  (b" pr ; x  (\n1 2\n"s\n   t" (\n  3');

const help = `BUILT IN FUNCTIONS

*** list ops ***
 at (seq index(es) --> value(s)) looks up item(s).
 choff @akk (channel(s) c n --> out) places it.
    more about choff
 ev-base - a form.

*** math ***
   All built-in binary math operators have the following variations defined:
 sig (a --> b)`;
assert.deepEqual(parseHelp(help), [
  { name: 'at', category: 'list ops', special: null, sig: '(seq index(es) --> value(s))', desc: 'looks up item(s).' },
  { name: 'choff', category: 'list ops', special: 'akk', sig: '(channel(s) c n --> out)', desc: 'places it.\nmore about choff' },
  { name: 'ev-base', category: 'list ops', special: null, sig: null, desc: 'a form.' },
  { name: 'sig', category: 'math', special: null, sig: '(a --> b)', desc: '' },
]);
console.log('sapf-text tests passed');
