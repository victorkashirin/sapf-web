# sapf on the web (wasm spike)

This folder builds sapf to WebAssembly with Emscripten and runs it in a browser through Web Audio.
It is a proof of concept. It does not change any existing source file: it only adds shims, a web
entry point and a build script.

## Status

What works:

- All of `src/` compiles with `em++` (Emscripten 6.0.12) and links into `sapf.wasm`
  (2.6 MB, 505 KB gzipped).
- The threading model matches the native app:
  - code is evaluated on its own thread (a wasm pthread)
  - audio is rendered on the browser's audio thread (a Wasm Audio Worklet)
  - both share the same memory
  - `go` starts new threads and `sleep` blocks the calling thread
- The prelude loads, code is evaluated like one REPL step, and the stack is printed.
- `play` and `stop` work, with up to 32 channels mixed into the browser output.
- `fft` and the other FFT ops work through a small built-in FFT (see `fftw_shim.cpp`).
- Tests that passed:
  - `node web/smoke.mjs` (Node plays the audio thread's role):
    - the prelude loads
    - `fft` of a shifted impulse gives the exact expected spectrum
    - `440 0 sinosc .3 * play` renders with the right level (RMS 0.212) and pitch (440 Hz)
    - one second of audio renders while the evaluation thread is blocked in `1 sleep`
    - a `go` thread runs and prints
    - `stop` removes the stream
  - In the browser (Chromium), through the Wasm Audio Worklet:
    - `[300 1200] 0 sinosc .3 * play` gives 300 Hz on the left channel and 1200 Hz on the
      right, both at the expected level
    - a 6-second evaluation (`ord 3000000 N +/`) did not affect the audio: the level stayed at
      0.212 in all 117 measurements taken during it
    - the page stayed responsive during that evaluation (a 50 ms timer was never late)
    - `\[.5 sleep "from go" pr cr] go` printed after 0.5 s while the main evaluation continued
    - syntax errors are printed to the page log, and the console shows no errors

What does not work yet:

| Feature | Status | Why / how to fix |
|---|---|---|
| Sound file read/write (`sf>`, `>sf`, `>sfo`, `record`) | Fails with a message | libsndfile is stubbed in `stubs.cpp`. Build libsndfile for wasm (CMake, `-DENABLE_EXTERNAL_LIBS=OFF`) and link it. Files would live in Emscripten's MEMFS/IDBFS. The recording writer thread itself should now work. |
| Spectrogram JPEG output | Prints "not available" | `Bitmap` is stubbed. Use Emscripten's `-sUSE_LIBJPEG=1` port and compile `src/makeImage.cpp`. |
| MIDI | No ports | `shim/RtMidi.h` reports zero ports. Could be bridged to Web MIDI. |
| OSC | Off | Browsers have no UDP. |
| Mouse UGens | Off | They are Carbon-only on desktop too. Could be fed from pointer events. |
| `prelude`, `examples`, `readme`, `logfile` ops; "open after write" | No-op | They call `system("open …")`. |
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
- **Only tested in Chromium.** Firefox and Safari support Wasm Audio Worklets and cross-origin
  isolation, but this was not checked.
- **The FFT is a simple radix-2 FFT.** It is correct, but slower than fftw. sapf only asks for
  power-of-two sizes; other sizes abort.
- **Only a few ops were tested.** `sapf-examples.txt` has not been run in the browser.
- The build needs external headers in a `DEPS` folder (see "Building"). They are not yet
  meson subprojects.

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
| `sapf_web.cpp` | Replaces `src/main.cpp`. Exports `sapf_init(sampleRate, preludePath)` (starts the evaluation thread, which loads the prelude), `sapf_eval(code)` (queues code and returns at once), `sapf_busy()` (non-zero while code is queued or running), `sapf_render(out, frames, channels)` and `sapf_num_playing()`. |
| `audio_worklet.cpp` | Browser build only. `sapf_start_audio(preludePath)` creates the AudioContext, calls `sapf_init` with its sample rate, and starts a Wasm Audio Worklet whose `process` callback calls `sapf_render`. `sapf_audio_node()` returns the node's handle, for example to connect an analyser. |
| `shim/RtAudio.h` | Fake RtAudio. `openStream` records the callback; `sapf_render` calls every recorded callback and sums them. A mutex guards the list. `src/Play.cpp` builds unchanged. |
| `shim/RtMidi.h` | RtMidi with no ports. |
| `shim/readline/*.h` | Empty readline API, so `src/VM.cpp` builds with `USE_LIBEDIT=0`. |
| `fftw_shim.cpp` | The 7 fftw3 functions that `src/dsp.cpp` and `src/Spectrogram.cpp` use. |
| `stubs.cpp` | Stubs for libsndfile and `Bitmap` (JPEG). |
| `build.sh` | Compiles every `src/*.cpp` listed in `meson.build` (except `main.cpp` and `makeImage.cpp`), plus the files above and `r8bbase.cpp`, with `-pthread`. Links two outputs: `build/sapf.mjs` (browser, with `-sAUDIO_WORKLET -sWASM_WORKERS`) and `build/sapf-node.mjs` (Node, no audio output). `sapf-prelude.txt` is embedded. Thread stacks are 2 MB (Emscripten's default of 64 KB is too small for sapf); the audio worklet stack is 1 MB. |
| `smoke.mjs` | Node test (assert-based), using `build/sapf-node.mjs`. |
| `serve.py` | Dev server with the cross-origin isolation headers. |
| `index.html` | Demo page: code editor, Run/Stop buttons and log. |

## Building

You need:

1. [emsdk](https://emscripten.org/docs/getting_started/downloads.html), installed and activated
   (`source ~/emsdk/emsdk_env.sh`).
2. The r8brain submodule: `git submodule update --init`.
3. A `DEPS` folder with these header-only libraries and headers:

```
$DEPS/xsimd-13.2.0/   https://github.com/xtensor-stack/xsimd/archive/refs/tags/13.2.0.tar.gz
$DEPS/eigen-3.4.0/    https://gitlab.com/libeigen/eigen/-/archive/3.4.0/eigen-3.4.0.tar.bz2
$DEPS/inc/fftw3.h     api/fftw3.h from https://www.fftw.org/fftw-3.3.10.tar.gz
$DEPS/inc/sndfile.h   an installed libsndfile 1.2.x header (for example from Homebrew)
```

Only headers are used from fftw and libsndfile. Their code is replaced by `fftw_shim.cpp` and
`stubs.cpp`.

Build and test (a full build takes about 15 seconds):

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

1. **Build the real libraries.** Build libsndfile and fftw (or pocketfft) for wasm and remove the
   stubs. That enables sound files and `record`. Use `-sUSE_LIBJPEG=1` for images.
2. **Test under load.** Run `sapf-examples.txt` in the browser. Test `go` threads that touch
   playing lists, and test Firefox and Safari.
3. **Move the build into meson.** Use an Emscripten cross file and a `web` option that turns off
   rtaudio, rtmidi, libedit and OSC, and get xsimd and eigen from the existing wraps.
4. **Write a proper Web Audio backend.** Replace the RtAudio shim with a `#ifdef __EMSCRIPTEN__`
   backend in `src/Play.cpp`, next to the AudioToolbox and RtAudio ones.
5. **Add file access.** Preload `sapf-examples.txt` and keep user files in IDBFS. Replace the
   `system("open …")` calls with browser downloads.

## Licence

sapf is GPL-3.0. A public web deployment must offer the corresponding source.
