// AudioWorklet that hosts the whole sapf wasm module, so audio renders on the audio thread.
// The page sends {type:'eval', code} on the node's port; output comes back as {type:'print', text}.
import createSapf from './build/sapf.mjs';

// AudioWorkletGlobalScope may lack these; Emscripten calls them for clocks and random seeds.
globalThis.performance ??= { now: () => Date.now() };
globalThis.crypto ??= { getRandomValues: v => { for (let i = 0; i < v.length; ++i) v[i] = Math.random() * 256; return v; } };

const kMaxFrames = 4096; // render quantum is 128 today; leave room for configurable quanta

class SapfProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { wasmBytes, preludeFile } = options.processorOptions;
    const print = text => this.port.postMessage({ type: 'print', text });
    this.pending = [];
    this.port.onmessage = e => {
      if (e.data.type !== 'eval') return;
      if (this.sapf) this.eval(e.data.code); else this.pending.push(e.data.code);
    };
    createSapf({
      print, printErr: print,
      // the worklet has no fetch, so the page hands us the wasm bytes
      instantiateWasm: (imports, receive) => {
        WebAssembly.instantiate(wasmBytes, imports).then(r => receive(r.instance));
        return {};
      },
    }).then(m => {
      m.ccall('sapf_init', null, ['number', 'string'], [sampleRate, preludeFile]);
      this.ptr = m._malloc(kMaxFrames * options.outputChannelCount[0] * 4);
      this.sapf = m;
      for (const code of this.pending) this.eval(code);
      this.pending = [];
      this.port.postMessage({ type: 'ready' });
    }, err => print('sapf failed to start: ' + err));
  }

  // Runs on the audio thread between render quanta: a slow evaluation delays audio.
  eval(code) {
    this.sapf.ccall('sapf_eval', null, ['string'], [code]);
    this.port.postMessage({ type: 'playing', count: this.sapf._sapf_num_playing() });
  }

  process(inputs, outputs) {
    const out = outputs[0], m = this.sapf;
    if (!m) return true;
    const frames = out[0].length, ch = out.length;
    m._sapf_render(this.ptr, frames, ch);
    const base = this.ptr / 4;
    for (let c = 0; c < ch; ++c) out[c].set(m.HEAPF32.subarray(base + c * frames, base + (c + 1) * frames));
    return true;
  }
}

registerProcessor('sapf', SapfProcessor);
