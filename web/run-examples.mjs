// Evaluates every example in sapf-examples.txt on a Node build; for examples that play, renders
// 0.25 s of audio and stops. Meant for sanitizer builds: stops at the first sanitizer report.
// usage: node web/run-examples.mjs [path/to/sapf-node.mjs] [first example index]
//   e.g. node web/run-examples.mjs web/build-address/sapf-node.mjs
// Examples are split at blank lines, so multi-paragraph examples report syntax errors or
// undefined words; mouse UGens (xmousex, mousex, mousey) are not available on web.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , modArg = 'web/build/sapf-node.mjs', first = '0'] = process.argv;
const { default: createSapf } = await import(pathToFileURL(path.resolve(modArg)).href);
const kLimitMs = 180000; // some examples are long computations, slow under ASan

let out = '', sanitizer = false;
const sapf = await createSapf({
  print: s => { out += s + '\n'; },
  printErr: s => { out += s + '\n'; if (/Sanitizer/.test(s)) sanitizer = true; process.stderr.write(s + '\n'); },
});
const SR = 48000, frames = 128, ch = 2, ptr = sapf._malloc(frames * ch * 4);
const wait = ms => new Promise(r => setTimeout(r, ms));

async function evalWait(code) {
  out = '';
  sapf.ccall('sapf_eval', null, ['string'], [code + '\n']);
  const t0 = Date.now();
  while (sapf._sapf_busy()) {
    if (sanitizer) return 'sanitizer report';
    if (Date.now() - t0 > kLimitMs) return 'timeout';
    for (let i = 0; i < 4; ++i) sapf._sapf_render(ptr, frames, ch); // keep audio flowing, as in a browser
    await wait(1);
  }
  await wait(5);
  return sanitizer ? 'sanitizer report' : 'ok';
}

sapf.ccall('sapf_init', null, ['number', 'string'], [SR, 'sapf-prelude.txt']);
while (sapf._sapf_busy()) await wait(5);

const src = fs.readFileSync(new URL('../sapf-examples.txt', import.meta.url), 'utf8');
const examples = src.split(/\n\s*\n/).map(s => s.trim()).filter(s => s && !/^;+[^\n]*$/.test(s));
const stats = { ran: 0, errors: 0, played: 0 };
for (let i = +first; i < examples.length; ++i) {
  const ex = examples[i];
  let r = await evalWait(ex);
  if (r === 'ok') {
    stats.ran++;
    if (/error/i.test(out)) {
      stats.errors++;
      console.log(`#${i} ${ex.split('\n')[0].slice(0, 60)}  =>  ${out.split('\n').filter(l => /error/i.test(l))[0]}`);
    }
    if (sapf._sapf_num_playing()) {
      stats.played++;
      for (let b = 0; b < SR / 4 / frames && !sanitizer; ++b) sapf._sapf_render(ptr, frames, ch);
      r = await evalWait('stop clear'); // evalWait renders while stop waits for the fade
    } else r = await evalWait('clear');
  }
  if (r !== 'ok') {
    console.log(`\n#${i} ${r}:\n${ex}\n--- output:\n${out.slice(-3000)}`);
    console.log(`stopped at #${i}`, stats, `(resume with: node web/run-examples.mjs ${modArg} ${i + 1})`);
    process.exit(1);
  }
}
console.log(`examples #${first}-#${examples.length - 1}`, stats);
process.exit(0);
