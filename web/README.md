# sapf on the web (wasm spike)

This folder builds sapf to WebAssembly with Emscripten and runs it in a browser through Web Audio.
It is a proof of concept. It adds shims, a web entry point and build scripts. The only changes
to existing source files are fixes for bugs that AddressSanitizer found (see "AddressSanitizer"),
which apply to the desktop build too, and two small changes in `src/Midi.cpp` for page sliders:
`ZCtl` now starts from the ZRef's value instead of an uninitialised one, and `zctl_` is no
longer `static`. `src/UGen.cpp` also builds the mouse UGens under Emscripten, and
`src/SndfileSoundFile.cpp` no longer reports an empty write as a failure (`>sf` printed
"failed to write audio data to file - No Error" when the signal ended on a buffer boundary).
Under Emscripten, `sf>` (`src/SoundFiles.cpp`) reads the whole file when it runs instead of block
by block as the sound is pulled: a played sound is pulled on the audio worklet thread, which cannot
reach the file system, so `["x.wav" sf> head #[0] cyc] $/ play` played silence. `sf>` called
inside an `ola` function still plays silence, as that function runs on the audio thread: read the
file first (`"x.wav" sf> head = b  \[b 0 pan2] .25 1 2 ola play`).

## Status

What works:

- All of `src/` compiles with `em++` (Emscripten 5.0.7) and links into `sapf.wasm`
  (3.0 MB, 840 KB gzipped). It uses the same libraries as the native portable build: fftw 3.3.10,
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
- Sound bank: the Sounds menu uploads sound files, lists them, and inserts `"name" sf>` at the
  cursor. Files live in `/sounds`, sapf's working directory, so `"blip.wav" sf>` reads one.
  Built-in sounds are served from `web/sounds` (`blip.wav`, which also replaces the macOS-only
  `/System/Library/Sounds/Submarine.aiff` in the built-in function examples). Uploads are kept in
  IndexedDB and survive a reload. Formats libsndfile cannot read (MP3, Ogg, FLAC, ...) are decoded
  by the browser at upload and stored as 32-bit float WAV at 48 kHz.
- "Open" means download: `>sfo`, `sgram` and `prelude` run `system("open <file>")`; the web build
  runs no command and instead hands the file to the page, which downloads it.
- Mouse UGens (`mousex`, `mousey`, `xmousex`, `xmousey` and their `1` forms) follow the pointer
  over the page window, clamped to [0,1] (y is 1 at the top), instead of the whole screen as on the desktop.
- Page sliders (web only): `name lo hi default slider` (linear) and `xslider` (exponential) add a
  slider under the editor and return its smoothed signal, e.g.
  `"freq" 100 2000 440 xslider 0 sinosc "amp" 0 1 .3 slider * play`. Each name keeps one slider for
  the session; running the code again keeps its position, clamped to the new range. Sliders write
  the value straight to a ZRef (`sapf_set_ctl`), so they respond while the evaluation thread is busy.
  Sliders are never removed until the page is reloaded.
  To name a slider for reuse, store a function, not its signal:
  `\["freq" 100 2000 440 xslider] = freq` then `freq 0 sinosc freq 1.5 * 0 sinosc + .2 * play`.
  Each use reads the same slider afresh. Storing the signal (`... xslider = f`) works inside one
  expression, but `f` keeps everything the slider ever produced in memory, and playing `f` again
  later replays old slider moves before it catches up. The "Add control" button inserts such a
  definition (`\["ctl1" 0 1 .5 slider] = ctl1  ctl1 pop`) on a new line above the cursor's line and
  runs it. The trailing `ctl1 pop` calls it once, so the slider shows whenever that line runs (after
  a reload too), not only at `ctl1`'s first use.
- Tests that passed:
  - `node web/smoke.mjs` (Node plays the audio thread's role):
    - all 369 of sapf's own language tests in `unit-tests.txt` pass. The test lists any that
      fail; checked by breaking one test on purpose
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
    - `xslider` reports its name, range and value to the page and plays its default (220 Hz);
      `sapf_set_ctl` moves it to 880 Hz while the evaluation thread is in `1 sleep`; running it
      again with a smaller range keeps the position, clamped; a range through zero is an error
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
    - the slider example adds `freq` and `amp` sliders; after dragging them, the output pitch
      (766 Hz) matched the `freq` slider (767.3)
  - `node web/build/test_sapf.js`: sapf's C++ doctest suite (`test/*.cpp`) passes on wasm:
    29 of 29 test cases, 9,974,926 assertions, in under a second. It covers math ops,
    oscillator UGens, stream ops, MIDI packets, sound files (libsndfile, resampling),
    the async file writer thread, and spectrogram images. A failing test makes the process
    exit with a non-zero code (checked with a deliberately failing test).
  - Both suites also pass under AddressSanitizer (see below).

What does not work yet:

| Feature | Status | Why / how to fix |
|---|---|---|
| Getting files in and out of the browser | Partly | `>sfo` and `sgram` put a download link in the console, and download at once if the key press that ran the code still counts as a user action (Chrome: about 5 s), so Chrome does not ask about repeated downloads. `>sf` and `record` output stays in the in-memory file system and is lost on reload. Sound files can be uploaded through the Sounds menu and are kept in IndexedDB. From devtools: `sapf.FS.readFile('/tmp/name.wav')`. Fix: list `/tmp` output in the Sounds menu. |
| Compressed sound files (FLAC, Ogg, Opus, MP3) | Upload only | libsndfile is built without external codec libraries (`-DENABLE_EXTERNAL_LIBS=OFF`), so `sf>` reads only WAV, AIFF and the other uncompressed formats. The Sounds menu decodes compressed uploads in the browser and stores them as WAV. |
| MIDI | No ports | `shim/RtMidi.h` reports zero ports. Could be bridged to Web MIDI. |
| OSC | Off | Browsers have no UDP. |
| `examples`, `readme`, `logfile` ops | No-op | They have no file to open on the web. |
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

Two build choices matter for speed:

- **Signal blocks are 128 frames, not sapf's default 512** (`sapf_init`). The worklet asks for 128
  frames per callback. With 512-frame blocks, one callback in four computed all the audio, so a
  patch could drop out at under 20% average CPU (one run of a 48-voice patch averaged 18% and its
  slowest callback took 116%). With 128-frame blocks the average cost is about 30% higher, but
  the slowest callback costs about a third as much, so about 2.5 times as many voices fit before
  audio breaks up. Measured on a 48-voice `dust`/`apverb6` patch, as a share of the 2.67 ms one
  callback may take: mean 14%, slowest 1% of callbacks 58% before; 19% and 21% after. The 45
  examples in `sapf-examples.txt` whose output is the same on every run give the same audio with
  either block size. One difference from the desktop: `kr` and `krc` accept only factors that
  divide 128, so `256 kr` and `512 kr` are errors ("out of range").
- **C++ exceptions are native wasm exceptions** (`-fwasm-exceptions`). With `-fexceptions`,
  Emscripten emulates them through JavaScript: every call that can throw, inside a function with a
  `P<>` local, went from wasm to JavaScript and back. That made evaluation about 4 times slower
  (`ord 3000000 N +/`: 3.2 s before, 0.8 s after), made audio rendering about 20% slower, and
  added 0.7 MB to `sapf.wasm`.

| File | Purpose |
|---|---|
| `sapf_web.cpp` | Replaces `src/main.cpp`. Overrides `system()` so it never runs a command (under Node Emscripten's `system()` would use the host shell); `open <file>` instead calls the page's `onSapfOpen`, which downloads the file. Exports `sapf_set_mouse(x, y)` for the mouse UGens. Exports `sapf_init(sampleRate, preludePath)` (starts the evaluation thread, which loads the prelude), `sapf_eval(code)` (queues code and returns at once), `sapf_busy()` (non-zero while code is queued or running), `sapf_render(out, frames, channels)` and `sapf_num_playing()`. |
| `audio_worklet.cpp` | Browser build only. `sapf_start_audio(preludePath)` creates the AudioContext, calls `sapf_init` with its sample rate, and starts a Wasm Audio Worklet whose `process` callback calls `sapf_render`. `sapf_audio_node()` returns the node's handle, for example to connect an analyser. |
| `shim/RtAudio.h` | Fake RtAudio. `openStream` records the callback; `sapf_render` calls every recorded callback and sums them. A mutex guards the list. `stopStream` marks the stream as fading and waits; `sapf_render` applies a 10 ms linear fade and then drops the stream, after which `Play.cpp` deletes the `Player`. `src/Play.cpp` builds unchanged. |
| `shim/RtMidi.h` | RtMidi with no ports. |
| `shim/readline/*.h` | Empty readline API, so `src/VM.cpp` builds with `USE_LIBEDIT=0`. |
| `build-deps.sh` | Downloads xsimd, eigen, doctest, fftw and libsndfile (checking SHA-256 hashes) into `$DEPS`, and builds fftw and libsndfile as static wasm libraries with `-pthread` into `$DEPS/prefix`. |
| `build.sh` | Compiles every `src/*.cpp` listed in `meson.build` (except `main.cpp`), plus `sapf_web.cpp`, `audio_worklet.cpp` and `r8bbase.cpp`, with `-pthread`. Links fftw and libsndfile from `$DEPS/prefix` and libjpeg from Emscripten's port (`-sUSE_LIBJPEG=1`, fetched by Emscripten on first use). Exports `FS` so the page can reach files. Links three outputs: `build/sapf.mjs` (browser, with `-sAUDIO_WORKLET -sWASM_WORKERS`), `build/sapf-node.mjs` (Node, no audio output; `sapf-prelude.txt` is embedded in both), and `build/test_sapf.js` (the C++ test suite in `test/`, whose `main` runs on a pthread through `-sPROXY_TO_PTHREAD` so tests can block and join threads). Thread stacks are 2 MB (Emscripten's default of 64 KB is too small for sapf); the audio worklet stack is 1 MB. |
| `smoke.mjs` | Node test (assert-based), using `build/sapf-node.mjs` (or `SAPF_NODE_MODULE`). Also runs `unit-tests.txt`. |
| `run-examples.mjs` | Runs every example in `sapf-examples.txt` on a Node build, rendering audio for the ones that play. Stops at the first sanitizer report. |
| `serve.py` | Dev server with the cross-origin isolation headers. |
| `index.html` | The page: editor and console side by side, File menu, Sounds menu (sound bank), Run/Stop/Add control buttons, page sliders, About dialog. |
| `sounds/` | Built-in sounds, loaded into `/sounds` in sapf's file system with the page (`blip.wav`). |
| `editor.js` | The page's code editor: CodeMirror 6 with the features of the [vs-sapf](https://github.com/victorkashirin/vs-sapf) VS Code extension (highlighting, hover docs, completion, line/block/paragraph evaluation, formatting). `npm run build` (in `web/`, called by `build.sh`) bundles it with esbuild into `build/editor.js`. |
| `sapf-text.mjs` | Text logic ported from vs-sapf: the line, `( )` block and paragraph under the cursor, the formatter, and the `helpall` parser. Tested by `sapf-text.test.mjs`. |
| `gen-docs.mjs` | Runs `helpall` on `build/sapf-node.mjs` and writes `build/sapf-docs.json`, the editor's hover and completion docs, so they always match the built-ins and the prelude. |

## Building

You need:

1. Node.js with npm (for the editor bundle and the tests).
1. [emsdk](https://emscripten.org/docs/getting_started/downloads.html), installed and activated
   (`source ~/emsdk/emsdk_env.sh`).
2. The r8brain submodule: `git submodule update --init`.
3. CMake (for building fftw and libsndfile).

Prepare the dependencies once. This downloads xsimd 13.2.0, eigen 3.4.0, doctest 2.4.11,
fftw 3.3.10 and libsndfile 1.2.2, checks their hashes, and builds fftw and libsndfile for wasm. It takes about
two minutes. The dependencies go into `web/deps` (gitignored), or into `$DEPS` if you set it (an absolute path):

```bash
web/build-deps.sh
```

Then build and test (a full build takes about 15 seconds):

```bash
web/build.sh
node web/smoke.mjs
node web/sapf-text.test.mjs
node web/build/test_sapf.js
```

After changing only `editor.js` or `sapf-text.mjs`, `npm --prefix web run build` rebuilds the editor
without recompiling sapf.

Run the demo. Plain `python3 -m http.server` will not work, because it does not send the
cross-origin isolation headers:

```bash
python3 web/serve.py 8765
```

Then open http://localhost:8765, put the cursor on a line and press Cmd/Ctrl+Enter.
The keys follow vs-sapf:

| Key | Action |
|---|---|
| Cmd/Ctrl+Enter | evaluate the selection or the current line |
| Shift+Enter | evaluate the selection or the outermost `( )` block around the cursor (else the line) |
| Cmd/Ctrl+Shift+Enter | evaluate the selection or the paragraph (text between blank lines) |
| Esc or Cmd/Ctrl+. | `stop` |
| Cmd/Ctrl+Shift+. | `clear` (clears the stack) |
| Cmd/Ctrl+K | clear the console (also the Clear button above it) |
| Shift+Alt+F | format (vs-sapf uses Cmd/Ctrl+Shift+I, which opens the browser's devtools) |
| Ctrl+Space (Mac: also Option+` or Option+I) | open completion, even with nothing typed |

The File menu keeps named files in the browser's local storage: type a name and Save, then each
edit saves the file. New and the two example files (`sapf-examples.txt`, `sapf-bif-examples.txt`, which
`npm run build` copies into `build/`) open an unsaved text; leaving it once edited asks first.

Hovering a word shows its documentation; completion offers built-ins and prelude functions.
With "Solo" on (the default), evaluating code that calls `play` or `record` stops the
current sound first, so there's no need for Cmd/Ctrl+. between takes. It looks for those words in the
evaluated text only, so calling a function that plays (`\[... play] = f`, then `f`) doesn't replace.

## Deploying

`.github/workflows/web.yml` deploys the page to a Cloudflare Worker that serves static files
(`wrangler.jsonc`). It runs when a GitHub Release is published, or by hand from the Actions tab
("Web release"). It builds the dependencies (cached between runs), runs `build.sh`, `smoke.mjs`,
`sapf-text.test.mjs` and `test_sapf.js`, copies `index.html`, `_headers`, `favicon.png`, `sounds/`, `build/sapf.mjs`, `build/sapf.wasm` and `build/editor.js` into
`web/dist`, deploys that folder with wrangler 4, and attaches it as `sapf-web.zip` to the
release. A prerelease gets the zip but does not replace the live site.

- `_headers` sends the cross-origin isolation headers, like `serve.py` does.
- The page's Source link is rewritten to the deployed commit, to meet the GPL (see "Licence").
- The repository needs the secrets `CLOUDFLARE_API_TOKEN` (from the "Edit Cloudflare Workers"
  token template) and `CLOUDFLARE_ACCOUNT_ID`.
- To try the deployed setup locally, build, assemble `web/dist` as the workflow does, and run
  `npx wrangler@4 dev` in `web/`.

## AddressSanitizer

Wasm does not trap on most out-of-bounds or use-after-free accesses inside its memory; they
silently corrupt data. So the Node builds can be built with a sanitizer:

```bash
SANITIZE=address web/build.sh      # builds into web/build-address/
SAPF_NODE_MODULE=./build-address/sapf-node.mjs node web/smoke.mjs
node web/build-address/test_sapf.js
node web/run-examples.mjs web/build-address/sapf-node.mjs   # every example in sapf-examples.txt
```

`test_sapf.js` also runs LeakSanitizer at exit. The `sapf-node.mjs` module does not: Emscripten
turns on `EXIT_RUNTIME` for sanitizer builds, which made the module (it has no `main`) shut
down right after start-up, so `build.sh` turns it back off for the module.

Bugs it found and that are fixed. All of them also affect the desktop build:

- **`unspell` reads past its buffer and hashes garbage.** `vlistToString` and `zlistToString`
  (`src/StreamOps.cpp`) created the `String` right after `malloc`, before writing the text. The
  `String` constructor hashes its text, so it read uninitialised memory past the buffer until it
  met a zero byte, and the string got a hash of garbage instead of its contents. In the release
  wasm build this crashed the evaluation thread (`RuntimeError: unreachable`) on the example
  `"reverse a string" Z reverse unspell`. Fix: create the `String` after the text is written.
- **Out-of-bounds table reads at the clamp edge.** Four interpolated lookup tables are read one
  entry past their end when the input sits at its clamped maximum: `lut()` reads `index` and
  `index + 1`, and the clamp puts `index` on the last entry. The interpolation weight is 0 there,
  but if the value past the end is NaN or infinite, the result is NaN.
  - `gDecayTable` (`calcDecay`, used by delay UGens such as allpass; ratio clamped to 2). Hit by
    an example using `AllpassN`.
  - `gTableForNumHarmonics` (band-limited oscillators in `src/OscilUGens.cpp`; harmonics clamped
    to 1290, which happens at low frequencies or a frequency of 0). Hit by an example using the
    pulse-width oscillator (`OscPWM`).
  - `gFirstOrderCoeffTable` (`t_firstOrderCoeff`; frequency clamped to 1000). Same pattern,
    found by reading the code.
  - `gFreqToTable` (`freqToTable`; clamped to 20000). Same pattern; currently unused.

  Fix: each table gets one more entry (`+2`), filled like the rest, the same way `gDBAmpTable`
  already does (`include/MathFuns.hpp`, `src/MathFuns.cpp`, `src/OscilUGens.cpp`).
- **Memory leak in `RtBuffers(count, size)`.** That constructor allocates the sample buffer with
  `new[]` but nothing frees it. Only the C++ tests use it. Fix: the buffer is held in a
  `std::unique_ptr` (`include/Buffers.hpp`, `src/Buffers.cpp`).

Results after the fixes:

- `test_sapf.js`: 29 of 29 test cases pass; no ASan errors and no leaks.
- `smoke.mjs` (including all 369 language tests, playback, `sleep`, `go`, the stop fade, sound
  files, `record` and `sgram`): passes; no ASan errors.
- `run-examples.mjs`: all 353 examples run without memory errors, except five that could not
  finish under ASan: #229 and #344 run the ASan allocator out of memory (dense `osc-syn`
  textures; the 2 GB wasm limit minus ASan's shadow memory and quarantine), and #303, #318 and
  #329 are long computations that take over 3 minutes under ASan. All five run in the normal
  build, where wasm memory stayed at its initial 256 MB across all examples.
- `run-examples.mjs` on the normal build: all 353 examples run, 198 of them play audio, and
  none crash. 63 print a sapf error: 18 used the mouse UGens, which were not available on web then,
  and the rest come from the runner splitting multi-paragraph examples at blank lines.

## Next steps

Hardening the wasm engine:

1. **Check stack overflow.** Wasm threads have no guard page. Deep recursion in user code can
   run past the 2 MB thread stack into other memory instead of crashing. Test it, and consider
   `-sSTACK_OVERFLOW_CHECK=2` so it fails cleanly.
2. **Stress the audio thread.** Heavy evaluation, `go` threads touching playing lists, and many
   simultaneous sounds. The audio thread busy-waits on locks, including the allocator's global
   lock when it allocates; `-sMALLOC=mimalloc` (per-thread heaps) may reduce that.
3. **Test other browsers.** Firefox and Safari.

Later:

4. **Add file access.** List recordings and other `/tmp` output in the Sounds menu.
5. **Move the build into meson.** Use an Emscripten cross file and a `web` option that turns off
   rtaudio, rtmidi, libedit and OSC, and get xsimd and eigen from the existing wraps.
6. **Write a proper Web Audio backend.** Replace the RtAudio shim with a `#ifdef __EMSCRIPTEN__`
   backend in `src/Play.cpp`, next to the AudioToolbox and RtAudio ones.
7. **Add compressed formats.** Build libogg, libvorbis, FLAC and Opus for wasm and turn on
   libsndfile's external libraries, if those formats are needed.

## Licence

sapf is GPL-3.0. A public web deployment must offer the corresponding source. The page links to
the GitHub repository, and the deploy workflow points that link at the exact deployed commit.
