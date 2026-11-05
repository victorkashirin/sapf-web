// Node smoke test for the threaded wasm build: node web/smoke.mjs
// Here Node's main thread plays the audio thread's role and calls sapf_render itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

// sapf's own language tests. throwOnError off, so every failure is listed, not just the first.
const unitSrc = fs.readFileSync(new URL('../unit-tests.txt', import.meta.url), 'utf8');
assert.match(unitSrc, /^1 = throwOnError/m, 'unit-tests.txt header changed');
const unitOut = await evalSapf(unitSrc.replace(/^1 = throwOnError/m, '0 = throwOnError'));
const unitTests = unitOut.split(/^Testing : /m).slice(1); // one chunk per test, starting with its source
const unitRun = unitTests.length;
assert.ok(unitRun > 300, `unit tests ran: ${unitRun}`);
const unitFailed = unitTests.filter(t => !/^Passed$/m.test(t)).map(t => t.split('\n')[0]);
assert.deepEqual(unitFailed, [], 'unit tests failed');
await evalSapf('clear');

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

// `stop` fades out (RtAudio shim) instead of cutting, which clicks. Keep rendering while it stops:
// the output must never jump by more than the sine's own steepest step (0.3 * 2pi * 440 / SR = 0.0173).
sapf.ccall('sapf_eval', null, ['string'], ['stop\n']);
const tail = [left[left.length - 1]];
for (let b = 0; b < 400 && sapf._sapf_num_playing(); ++b) {
  sapf._sapf_render(ptr, frames, ch);
  tail.push(...sapf.HEAPF32.subarray(ptr / 4, ptr / 4 + frames));
  if (b % 4 === 3) await sleepMs(0); // let the evaluation thread run
}
assert.equal(sapf._sapf_num_playing(), 0, 'stop removes stream');
let maxStep = 0;
for (let i = 1; i < tail.length; ++i) maxStep = Math.max(maxStep, Math.abs(tail[i] - tail[i - 1]));
assert.ok(maxStep < 0.02, `stop clicks: jump of ${maxStep}`);
assert.equal(tail[tail.length - 1], 0, 'silent after the fade');
await idle();

// `go` runs a function on a new thread
out = '';
sapf.ccall('sapf_eval', null, ['string'], ['\\[.2 sleep "from go" pr cr] go\n']);
for (let i = 0; i < 100 && !/from go/.test(out); ++i) await sleepMs(10);
assert.match(out, /from go/, 'go thread ran');

// Sound files through libsndfile (Emscripten's in-memory FS; recordings go to /tmp)
await evalSapf('clear 440 0 sinosc .3 * 4800 N "t" >sf');
assert.equal(sapf.FS.stat('/tmp/t.wav').size, 80 + 4800 * 4, '>sf writes 4800 float frames');
const readBack = (await evalSapf('"/tmp/t.wav" sf> 3 N')).match(/-?[\d.e-]+/g).map(Number);
[0, 1, 2].forEach(i => assert.ok(Math.abs(readBack[i] - 0.3 * Math.sin(2 * Math.PI * 440 * i / SR)) < 1e-6, 'sf> reads back: ' + readBack));

// `record` plays and writes through the async writer thread
await evalSapf('clear 440 0 sinosc .3 * "rec" record');
const recBlocks = 200;
for (let b = 0; b < recBlocks; ++b) sapf._sapf_render(ptr, frames, ch);
await evalSapf('stop');
for (let i = 0; i < 100 && !sapf.FS.analyzePath('/tmp/rec.wav').exists; ++i) await sleepMs(10);
const recFrames = (sapf.FS.stat('/tmp/rec.wav').size - 80) / 4;
assert.equal(recFrames, recBlocks * frames, 'record wrote every rendered frame');
const recStart = (await evalSapf('"/tmp/rec.wav" sf> 3 N')).match(/-?[\d.e-]+/g).map(Number);
[0, 1, 2].forEach(i => assert.ok(Math.abs(recStart[i] - 0.3 * Math.sin(2 * Math.PI * 440 * i / SR)) < 1e-6, 'recording holds the sine: ' + recStart));
await evalSapf('clear');

// Spectrogram JPEG through libjpeg; its `open` call must not reach the host shell
const sgramOut = await evalSapf('clear 440 0 sinosc 4800 N -60 "spec" sgram');
const jpg = sapf.FS.readFile('/tmp/spec-60.jpg');
assert.deepEqual([...jpg.subarray(0, 3)], [0xff, 0xd8, 0xff], 'sgram writes a JPEG');
assert.doesNotMatch(sgramOut, /does not exist/, 'system() did not run on the host');

console.log(`OK  unit-tests.txt ${unitRun}/${unitRun};  rms=${rms.toFixed(4)} freq≈${crossings}Hz  rendered 1s in ${ms.toFixed(1)}ms while eval slept; go works;` +
  ` >sf/sf> ok; record wrote ${recFrames} frames; sgram jpeg ${jpg.length} bytes`);
process.exit(0); // pthread workers keep Node alive
