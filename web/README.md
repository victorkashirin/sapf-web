# sapf on the web (wasm spike)

This folder builds sapf to WebAssembly with Emscripten and runs it in a browser through Web Audio.
It is a proof of concept. It does not change any existing source file: it only adds shims, a web
entry point and a build script.

## Status

What works:

- All of `src/` compiles with `em++` (Emscripten 6.0.12) and links into `sapf.wasm`
  (3.7 MB, 920 KB gzipped). It uses the same libraries as the native portable build: fftw 3.3.10,
  libsndfile 1.2.2 and libjpeg, all compiled to wasm. fftw accounts for most of the size
  (it was 2.6 MB with the earlier hand-written FFT).
- The threading model matches the native app:
  - code is evaluated on its own thread (a wasm pthread)
  - audio is rendered on the browser's audio thread (a Wasm Audio Worklet)
  - both share the same memory
  - `go` starts new threads and `sleep` blocks the calling thread
- The prelude loads, code is evaluated like one REPL step, and the stack is printed.
- `play` and `stop` work, with up to 32 channels mixed into the browser output. `stop` fades
  each sound out over 10 ms instead of cutting it, so it does not click (see "How it works").
  This differs from the desktop app, which cuts the sound.
- `fft` and the other FFT ops use fftw.
- Sound files work through libsndfile: `>sf` writes, `sf>` reads, and `record` plays and writes
  through its writer thread. Files live in Emscripten's in-memory file system; recordings go to
  `/tmp` as on the desktop.
- `sgram` writes spectrogram JPEGs through libjpeg (to `/tmp`).
- Tests that passed:
  - `node web/smoke.mjs` (Node plays the audio thread's role):
    - the prelude loads
    - `fft` of a shifted impulse gives the exact expected spectrum
    - `440 0 sinosc .3 * play` renders with the right level (RMS 0.212) and pitch (440 Hz)
    - one second of audio renders while the evaluation thread is blocked in `1 sleep`
    - a `go` thread runs and prints
    - `stop` fades out: while stopping, no step between two samples is larger than the sine's
      own steepest step, and the output ends in silence. With the fade removed, the same test
      fails with a 0.166 jump
    - `>sf` writes a WAV of the expected size, and `sf>` reads back the exact samples
    - `record` writes every rendered frame (25,600 of 25,600), and the file holds the sine
    - `sgram` writes a valid JPEG, and its `open` call does not reach the host shell
  - In the browser (Chromium), through the Wasm Audio Worklet:
    - `[300 1200] 0 sinosc .3 * play` gives 300 Hz on the left channel and 1200 Hz on the
      right, both at the expected level
    - a 6-second evaluation (`ord 3000000 N +/`) did not affect the audio: the level stayed at
      0.212 in all 117 measurements taken during it
    - the page stayed responsive during that evaluation (a 50 ms timer was never late)
    - `\[.5 sleep "from go" pr cr] go` printed after 0.5 s while the main evaluation continued
    - `fft` gives the exact expected spectrum
    - `[300 1200] 0 sinosc .3 * "webrec" record` for about a second wrote a 2-channel WAV of
      1.09 s, which `sf>` reads back
    - `sgram` writes a valid JPEG
    - `stop` does not click: in 5 trials, analyser snapshots taken every 2 ms during `stop`
      never showed a step larger than the playing sine's own, and each `stop` finished in
      9–14 ms
    - syntax errors are printed to the page log, and the console shows no errors
  - sapf's own language tests (`unit-tests.txt`): all 369 pass on the Node build. This is not
    yet part of `smoke.mjs`.

What does not work yet:

| Feature | Status | Why / how to fix |
|---|---|---|
| Getting files in and out of the browser | No UI | Recordings, `>sf` output and spectrograms are written to the in-memory file system and are lost on reload. The page has no way to download them or to load your own sound files yet. From devtools: `sapf.FS.readFile('/tmp/name.wav')`. Fix: download links, file upload, IDBFS for persistence. |
| Compressed sound files (FLAC, Ogg, Opus, MP3) | Not supported | libsndfile is built without external codec libraries (`-DENABLE_EXTERNAL_LIBS=OFF`). WAV, AIFF and the other uncompressed formats work. |
| MIDI | No ports | `shim/RtMidi.h` reports zero ports. Could be bridged to Web MIDI. |
| OSC | Off | Browsers have no UDP. |
| Mouse UGens | Off | They are Carbon-only on desktop too. Could be fed from pointer events. |
| `prelude`, `examples`, `readme`, `logfile` ops; "open after write" (`>sfo`, `sgram`) | No-op | They call `system("open …")`, which the web build refuses (see `sapf_web.cpp`). |
| Line editing and history | Not needed | The page sends code through `sapf_eval`. |

Known limits of the current approach:

- **The page must be cross-origin isolated.** Shared memory (`SharedArrayBuffer`) needs the
  headers `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy:
  require-corp`. `serve.py` sends them; any real host must too. Without them the page shows a
  message and audio cannot start.
- **Locks on the audio thread spin.** The audio thread cannot block with `Atomics.wait`, so when
  it has to wait for a mutex, Emscripten makes it busy-wait. This affects the lazy-list locks in
  `include/lock.hpp` and the stream-list lock in `shim/RtAudio.h`. Critical sections are short,
  and no glitches were seen, but heavy contention (for example `go` threads forcing the same
  lists that are playing) has not been tested.
- **Starting or stopping a sound waits for the current audio block.** `sapf_render` holds the
  stream-list lock for the whole render, so `play` and `stop` wait for the block in progress
  (128 frames, about 3 ms). This keeps `stop` from deleting a `Player` while the audio thread
  still uses it, the same guarantee a real `RtAudio::stopStream` gives.
- **`stop` fades sounds out one after another.** `Play.cpp` stops and deletes players one at a
  time, and each one waits for its 10 ms fade, so stopping N sounds takes about N × 10 ms. If
  audio is not running (for example the AudioContext is suspended), each waits at most 210 ms
  and is then cut.
- **Only tested in Chromium.** Firefox and Safari support Wasm Audio Worklets and cross-origin
  isolation, but this was not checked.
- **Only a few ops were tested.** `sapf-examples.txt` has not been run in the browser.
- The dependencies are built by a separate script into a `DEPS` folder (see "Building"), not
  through meson.
- fftw has no wasm SIMD code, so it runs its portable C version, which is slower than native
  fftw. FFT speed has not been measured.

## How it works

sapf's audio model: the audio callback pulls samples from lazy lists (`ZIn::fill` in
`src/Play.cpp`), so the graph is evaluated on the audio thread. The web build keeps this model
and the native thread layout:

```
main thread (index.html)        eval thread (pthread)          audio thread (Wasm Audio Worklet)
  sapf_start_audio  ──────────>  load prelude                    started by sapf_start_audio
  sapf_eval(code)   ──queue───>  compile + run, like the REPL    process() every 128 frames:
  log  <─────print───────────    play/stop open/close streams      sapf_render(out, frames, ch)
                                 `go` starts more pthreads           └─> each open stream: rtPlayerBackendCallback
                                                                          └─> fillBufferList ──> ZIn::fill (lazy graph)
```

| File | Purpose |
|---|---|
| `sapf_web.cpp` | Replaces `src/main.cpp`. Overrides `system()` to do nothing: sapf ops run `open <file>` through it, and under Node Emscripten's `system()` would run that on the host shell. Exports `sapf_init(sampleRate, preludePath)` (starts the evaluation thread, which loads the prelude), `sapf_eval(code)` (queues code and returns at once), `sapf_busy()` (non-zero while code is queued or running), `sapf_render(out, frames, channels)` and `sapf_num_playing()`. |
| `audio_worklet.cpp` | Browser build only. `sapf_start_audio(preludePath)` creates the AudioContext, calls `sapf_init` with its sample rate, and starts a Wasm Audio Worklet whose `process` callback calls `sapf_render`. `sapf_audio_node()` returns the node's handle, for example to connect an analyser. |
| `shim/RtAudio.h` | Fake RtAudio. `openStream` records the callback; `sapf_render` calls every recorded callback and sums them. A mutex guards the list. `stopStream` marks the stream as fading and waits; `sapf_render` applies a 10 ms linear fade and then drops the stream, after which `Play.cpp` deletes the `Player`. `src/Play.cpp` builds unchanged. |
| `shim/RtMidi.h` | RtMidi with no ports. |
| `shim/readline/*.h` | Empty readline API, so `src/VM.cpp` builds with `USE_LIBEDIT=0`. |
| `build-deps.sh` | Downloads xsimd, eigen, fftw and libsndfile (checking SHA-256 hashes) into `$DEPS`, and builds fftw and libsndfile as static wasm libraries with `-pthread` into `$DEPS/prefix`. |
| `build.sh` | Compiles every `src/*.cpp` listed in `meson.build` (except `main.cpp`), plus `sapf_web.cpp`, `audio_worklet.cpp` and `r8bbase.cpp`, with `-pthread`. Links fftw and libsndfile from `$DEPS/prefix` and libjpeg from Emscripten's port (`-sUSE_LIBJPEG=1`, fetched by Emscripten on first use). Exports `FS` so the page can reach files. Links two outputs: `build/sapf.mjs` (browser, with `-sAUDIO_WORKLET -sWASM_WORKERS`) and `build/sapf-node.mjs` (Node, no audio output). `sapf-prelude.txt` is embedded. Thread stacks are 2 MB (Emscripten's default of 64 KB is too small for sapf); the audio worklet stack is 1 MB. |
| `smoke.mjs` | Node test (assert-based), using `build/sapf-node.mjs`. |
| `serve.py` | Dev server with the cross-origin isolation headers. |
| `index.html` | Demo page: code editor, Run/Stop buttons and log. |

## Building

You need:

1. [emsdk](https://emscripten.org/docs/getting_started/downloads.html), installed and activated
   (`source ~/emsdk/emsdk_env.sh`).
2. The r8brain submodule: `git submodule update --init`.
3. CMake (for building fftw and libsndfile).

Prepare the dependencies once. This downloads xsimd 13.2.0, eigen 3.4.0, fftw 3.3.10 and
libsndfile 1.2.2, checks their hashes, and builds fftw and libsndfile for wasm. It takes about
two minutes:

```bash
DEPS=/path/to/deps web/build-deps.sh
```

Then build and test (a full build takes about 15 seconds):

```bash
DEPS=/path/to/deps web/build.sh
node web/smoke.mjs
```

Run the demo. Plain `python3 -m http.server` will not work, because it does not send the
cross-origin isolation headers:

```bash
python3 web/serve.py 8765
```

Then open http://localhost:8765, put the cursor on a line and press Cmd/Ctrl+Enter.
Esc stops the sound.

## Next steps

Hardening the wasm engine:

1. **Run the existing test suites on wasm.** Add `unit-tests.txt` to `smoke.mjs` (it already
   passes), and build the C++ doctest suite in `test/` with `em++` and run it under Node.
2. **Run under AddressSanitizer.** Wasm does not trap on most out-of-bounds or use-after-free
   accesses inside its memory; they silently corrupt data. Emscripten supports
   `-fsanitize=address` with pthreads, so the test suites can run under it.
3. **Check stack overflow.** Wasm threads have no guard page. Deep recursion in user code can
   run past the 2 MB thread stack into other memory instead of crashing. Test it, and consider
   `-sSTACK_OVERFLOW_CHECK=2` so it fails cleanly.
4. **Stress the audio thread.** Heavy evaluation, `go` threads touching playing lists, and many
   simultaneous sounds. The audio thread busy-waits on locks, including the allocator's global
   lock when it allocates; `-sMALLOC=mimalloc` (per-thread heaps) may reduce that.
5. **Test other browsers.** Firefox and Safari.

Later:

6. **Add file access.** Add download links for recordings and spectrograms, and file upload for
   `sf>`. Keep user files in IDBFS so they survive a reload, and preload `sapf-examples.txt`.
7. **Move the build into meson.** Use an Emscripten cross file and a `web` option that turns off
   rtaudio, rtmidi, libedit and OSC, and get xsimd and eigen from the existing wraps.
8. **Write a proper Web Audio backend.** Replace the RtAudio shim with a `#ifdef __EMSCRIPTEN__`
   backend in `src/Play.cpp`, next to the AudioToolbox and RtAudio ones.
9. **Add compressed formats.** Build libogg, libvorbis, FLAC and Opus for wasm and turn on
   libsndfile's external libraries, if those formats are needed.

## Licence

sapf is GPL-3.0. A public web deployment must offer the corresponding source.
