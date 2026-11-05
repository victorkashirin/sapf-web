// Writes build/sapf-docs.json, the hover and completion docs for the editor, from the engine's own
// `helpall` (built-ins plus prelude). Needs build/sapf-node.mjs from web/build.sh. usage: node web/gen-docs.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHelp } from './sapf-text.mjs';

const { default: createSapf } = await import('./build/sapf-node.mjs');
let out = '';
const sapf = await createSapf({ print: s => { out += s + '\n'; }, printErr: s => { out += s + '\n'; } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const idle = async () => { while (sapf._sapf_busy()) await sleep(5); await sleep(20); }; // 20 ms: let proxied prints arrive

sapf.ccall('sapf_init', null, ['number', 'string'], [48000, 'sapf-prelude.txt']);
await idle();
// Prints arrive asynchronously from the evaluation thread, so wait for an end marker rather than for idle.
const END = '@@helpall-end';
out = '';
sapf.ccall('sapf_eval', null, ['string'], [`helpall "${END}" pr cr\n`]);
for (const t0 = Date.now(); !out.includes(END); await sleep(10)) assert.ok(Date.now() - t0 < 30000, 'helpall timed out');

const docs = parseHelp(out.slice(0, out.indexOf(END)));
assert.ok(docs.length > 800, `helpall parsed: ${docs.length} entries`);
assert.deepEqual(docs.find(d => d.name === 'sinosc'),
  { name: 'sinosc', category: 'oscillator unit generators', special: 'zz', sig: '(freq phase --> out)', desc: 'sine wave oscillator.' });
fs.writeFileSync(new URL('build/sapf-docs.json', import.meta.url), JSON.stringify(docs));
console.log(`wrote build/sapf-docs.json (${docs.length} entries)`);
process.exit(0); // the evaluation thread keeps Node alive
