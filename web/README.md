# sapf on the web (wasm spike)

This folder builds sapf to WebAssembly with Emscripten and runs it in a browser through Web Audio.
It is a proof of concept. It does not change any existing source file: it only adds shims, a web
entry point and a build script.

## Status

What works:

- All of `src/` compiles with `em++` (Emscripten 6.0.12) and links into `sapf.wasm`
  (2.8 MB, 490 KB gzipped).
- The prelude loads, code is evaluated like one REPL step, and the stack is printed.
- `play` and `stop` work, with up to 32 channels mixed into the browser output.
- `fft` and the other FFT ops work through a small built-in FFT (see `fftw_shim.cpp`).
- Tests that passed:
  - `node web/smoke.mjs`: prelude loads; `fft` of a shifted impulse gives the exact expected
    spectrum; `440 0 sinosc .3 * play` renders with the right level (RMS 0.212) and
    pitch (440 Hz); `stop` removes the stream. One second of audio renders in about 1.2 ms.
  - In the browser: `[300 1200] 0 sinosc .3 * play` gives 300 Hz on the left channel and
    1200 Hz on the right, both at the expected level.

What does not work yet:

| Feature | Status | Why / how to fix |
|---|---|---|
| Sound file read/write (`sf>`, `>sf`, `>sfo`, `record`) | Fails with a message | libsndfile is stubbed in `stubs.cpp`. Build libsndfile for wasm (CMake, `-DENABLE_EXTERNAL_LIBS=OFF`) and link it. Files would live in Emscripten's MEMFS/IDBFS. |
| Spectrogram JPEG output | Prints "not available" | `Bitmap` is stubbed. Use Emscripten's `-sUSE_LIBJPEG=1` port and compile `src/makeImage.cpp`. |
| `go`, `sleep` | Broken | The build is single-threaded. They need pthreads (see "Next steps"). |
| Recording (`AsyncAudioFileWriter`) | Broken | Needs a writer thread and libsndfile. |
| MIDI | No ports | `shim/RtMidi.h` reports zero ports. Could be bridged to Web MIDI. |
| OSC | Off | Browsers have no UDP. |
| Mouse UGens | Off | They are Carbon-only on desktop too. Could be fed from pointer events. |
| `prelude`, `examples`, `readme`, `logfile` ops; "open after write" | No-op | They call `system("open …")`. |
| Line editing and history | Not needed | The page sends code through `sapf_eval`. |

Known limits of the current approach:

- **Audio runs on the main thread.** `index.html` uses `ScriptProcessorNode`, a deprecated API.
  Heavy work in the page (or a slow evaluation) can cause audio dropouts.
- **The FFT is a simple radix-2 FFT.** It is correct, but slower than fftw. sapf only asks for
  power-of-two sizes; other sizes abort.
- **Only a few ops were tested.** `sapf-examples.txt` has not been run in the browser.
- The build needs external headers in a `DEPS` folder (see "Building"). They are not yet
  meson subprojects.

## How it works

sapf's audio model: the audio callback pulls samples from lazy lists (`ZIn::fill` in
`src/Play.cpp`), so the graph is evaluated on the audio thread. The web build keeps this model:

```
browser audio callback ──> sapf_render(out, frames, channels)
                              └─> for each open RtAudio "stream": rtPlayerBackendCallback (src/Play.cpp)
                                     └─> fillBufferList ──> ZIn::fill (lazy graph)
```

| File | Purpose |
|---|---|
| `sapf_web.cpp` | Replaces `src/main.cpp`. Exports `sapf_init(sampleRate, preludePath)`, `sapf_eval(code)`, `sapf_render(out, frames, channels)` and `sapf_num_playing()`. |
| `shim/RtAudio.h` | Fake RtAudio. `openStream` records the callback; `sapf_render` calls every recorded callback and sums them. `src/Play.cpp` builds unchanged. |
| `shim/RtMidi.h` | RtMidi with no ports. |
| `shim/readline/*.h` | Empty readline API, so `src/VM.cpp` builds with `USE_LIBEDIT=0`. |
| `fftw_shim.cpp` | The 7 fftw3 functions that `src/dsp.cpp` and `src/Spectrogram.cpp` use. |
| `stubs.cpp` | Stubs for libsndfile and `Bitmap` (JPEG). |
| `build.sh` | Compiles every `src/*.cpp` listed in `meson.build` (except `main.cpp` and `makeImage.cpp`), plus the files above and `r8bbase.cpp`, and links `build/sapf.mjs` and `build/sapf.wasm`. `sapf-prelude.txt` is embedded. |
| `smoke.mjs` | Node test (assert-based). |
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

Build and test:

```bash
DEPS=/path/to/deps web/build.sh
node web/smoke.mjs
```

Run the demo (ES modules and wasm do not load from `file://`):

```bash
python3 -m http.server 8765 --directory web
```

Then open http://localhost:8765, put the cursor on a line and press Cmd/Ctrl+Enter.
Esc stops the sound.

## Next steps

1. **Move audio off the main thread.** Build with `-pthread -sAUDIO_WORKLET -sWASM_WORKERS`.
   Run the interpreter in a Worker and call `sapf_render` from a Wasm Audio Worklet over shared
   memory. This also makes `go`, `sleep` and recording work. It requires:
   - The page must be served with cross-origin isolation headers
     (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`)
     for `SharedArrayBuffer`.
   - The audio worklet thread cannot block with `Atomics.wait`. Lazy lists take a
     `std::shared_mutex` (`include/lock.hpp`) inside `fill`, so locking on the audio thread
     must be tested. It may need a spin lock.
2. **Build the real libraries.** Build libsndfile and fftw (or pocketfft) for wasm and remove the
   stubs. Use `-sUSE_LIBJPEG=1` for images.
3. **Move the build into meson.** Use an Emscripten cross file and a `web` option that turns off
   rtaudio, rtmidi, libedit and OSC, and get xsimd and eigen from the existing wraps.
4. **Write a proper Web Audio backend.** Replace the RtAudio shim with a `#ifdef __EMSCRIPTEN__`
   backend in `src/Play.cpp`, next to the AudioToolbox and RtAudio ones.
5. **Add file access.** Preload `sapf-examples.txt` and keep user files in IDBFS. Replace the
   `system("open …")` calls with browser downloads.

## Licence

sapf is GPL-3.0. A public web deployment must offer the corresponding source.
