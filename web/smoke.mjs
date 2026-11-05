// Node smoke test for the wasm build: node web/smoke.mjs
import assert from 'node:assert/strict';
import createSapf from './build/sapf.mjs';

let out = '';
const sapf = await createSapf({ print: s => { out += s + '\n'; }, printErr: s => { out += s + '\n'; } });
const SR = 48000;
sapf.ccall('sapf_init', null, ['number', 'string'], [SR, 'sapf-prelude.txt']);
assert.match(out, /done loading file/, 'prelude loads');

const evalSapf = code => { out = ''; sapf.ccall('sapf_eval', null, ['string'], [code]); return out; };

// FFT through the fftw shim: impulse delayed by 2 -> 0.25*e^{-i*pi*k/2} (sapf scales forward by 2/n)
const fftOut = evalSapf('#[0 0 1 0 0 0 0 0] #[0 0 0 0 0 0 0 0] fft');
const nums = fftOut.match(/-?[\d.e-]+/g).map(Number).map(x => Math.round(x * 1e6) / 1e6 + 0);
assert.deepEqual(nums, [.25, 0, -.25, 0, .25, 0, -.25, 0, 0, -.25, 0, .25, 0, -.25, 0, .25], 'fft: ' + fftOut);
evalSapf('clear');

// Play a 440 Hz sine and render 1 s of audio
evalSapf('440 0 sinosc .3 * play');
assert.equal(sapf._sapf_num_playing(), 1, 'one stream playing');

const frames = 128, ch = 2, ptr = sapf._malloc(frames * ch * 4);
const blocks = SR / frames, left = new Float32Array(SR);
const t0 = performance.now();
for (let b = 0; b < blocks; ++b) {
  sapf._sapf_render(ptr, frames, ch);
  left.set(sapf.HEAPF32.subarray(ptr / 4, ptr / 4 + frames), b * frames);
}
const ms = performance.now() - t0;

let sumsq = 0, crossings = 0;
for (let i = 0; i < left.length; ++i) {
  sumsq += left[i] * left[i];
  if (i && left[i - 1] < 0 && left[i] >= 0) ++crossings;
}
const rms = Math.sqrt(sumsq / left.length);
assert.ok(Math.abs(rms - 0.3 / Math.SQRT2) < 0.01, `rms ${rms}`);
assert.ok(Math.abs(crossings - 440) <= 1, `freq ${crossings}`);

evalSapf('stop');
assert.equal(sapf._sapf_num_playing(), 0, 'stop removes stream');

console.log(`OK  rms=${rms.toFixed(4)} freq≈${crossings}Hz  rendered 1s in ${ms.toFixed(1)}ms`);
