// Node smoke test for the threaded wasm build: node web/smoke.mjs
// Here Node's main thread plays the audio thread's role and calls sapf_render itself.
import assert from 'node:assert/strict';
import createSapf from './build/sapf-node.mjs';

let out = '';
const sapf = await createSapf({ print: s => { out += s + '\n'; }, printErr: s => { out += s + '\n'; } });
const SR = 48000;
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
const idle = async () => { while (sapf._sapf_busy()) await sleepMs(5); await sleepMs(20); }; // 20 ms: let proxied prints arrive
const evalSapf = async code => { out = ''; sapf.ccall('sapf_eval', null, ['string'], [code + '\n']); await idle(); return out; };

sapf.ccall('sapf_init', null, ['number', 'string'], [SR, 'sapf-prelude.txt']);
await idle();
assert.match(out, /done loading file/, 'prelude loads');

// FFT through the fftw shim: impulse delayed by 2 -> 0.25*e^{-i*pi*k/2} (sapf scales forward by 2/n)
const fftOut = await evalSapf('#[0 0 1 0 0 0 0 0] #[0 0 0 0 0 0 0 0] fft');
const nums = fftOut.match(/-?[\d.e-]+/g).map(Number).map(x => Math.round(x * 1e6) / 1e6 + 0);
assert.deepEqual(nums, [.25, 0, -.25, 0, .25, 0, -.25, 0, 0, -.25, 0, .25, 0, -.25, 0, .25], 'fft: ' + fftOut);
await evalSapf('clear');

// Play a 440 Hz sine
await evalSapf('440 0 sinosc .3 * play');
assert.equal(sapf._sapf_num_playing(), 1, 'one stream playing');

// Block the evaluation thread with `sleep`; audio must keep rendering meanwhile.
out = '';
sapf.ccall('sapf_eval', null, ['string'], ['1 sleep "woke" pr cr\n']);
await sleepMs(50);
assert.ok(sapf._sapf_busy(), 'evaluation thread is sleeping');

const frames = 128, ch = 2, ptr = sapf._malloc(frames * ch * 4);
const left = new Float32Array(SR);
const t0 = performance.now();
for (let b = 0; b < SR / frames; ++b) {
  sapf._sapf_render(ptr, frames, ch);
  left.set(sapf.HEAPF32.subarray(ptr / 4, ptr / 4 + frames), b * frames);
}
const ms = performance.now() - t0;
assert.ok(sapf._sapf_busy(), 'rendered 1 s of audio while evaluation was still blocked');

let sumsq = 0, crossings = 0;
for (let i = 0; i < left.length; ++i) {
  sumsq += left[i] * left[i];
  if (i && left[i - 1] < 0 && left[i] >= 0) ++crossings;
}
const rms = Math.sqrt(sumsq / left.length);
assert.ok(Math.abs(rms - 0.3 / Math.SQRT2) < 0.01, `rms ${rms}`);
assert.ok(Math.abs(crossings - 440) <= 1, `freq ${crossings}`);

await idle();
assert.match(out, /woke/, 'sleep returns and evaluation continues');

// `go` runs a function on a new thread
out = '';
sapf.ccall('sapf_eval', null, ['string'], ['\\[.2 sleep "from go" pr cr] go\n']);
for (let i = 0; i < 100 && !/from go/.test(out); ++i) await sleepMs(10);
assert.match(out, /from go/, 'go thread ran');

await evalSapf('stop');
assert.equal(sapf._sapf_num_playing(), 0, 'stop removes stream');

console.log(`OK  rms=${rms.toFixed(4)} freq≈${crossings}Hz  rendered 1s in ${ms.toFixed(1)}ms while eval slept; go works`);
process.exit(0); // pthread workers keep Node alive
