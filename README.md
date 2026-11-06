# sapf-web

sapf (Sound As Pure Form) running in the browser. James McCartney's [sapf](https://github.com/lfnoise/sapf)
is compiled to WebAssembly with Emscripten and plays through Web Audio, with a code editor, console,
scope and spectrum panels around it. It builds on the cross-platform fork,
[ahihi/sapf](https://github.com/ahihi/sapf).

The engine is sapf's own C++ source, mostly unchanged. The web code lives in [`web/`](web/):
shims for RtAudio, RtMidi and readline, a web entry point, the page and the build scripts.
[web/README.md](web/README.md) describes how it works, what differs from the desktop app, and
the bugs found along the way.

## Using it

Put the cursor on a line and press Cmd/Ctrl+Enter, for example on `440 0 sinosc .3 * play`.
Esc stops the sound. `helpall` lists every built-in; hovering a word shows its docs.

| Key | Evaluates |
|---|---|
| Cmd/Ctrl+Enter | the selection or the current line |
| Shift+Enter | the outermost `( )` block around the cursor |
| Cmd/Ctrl+Shift+Enter | the paragraph (text between blank lines) |
| Esc or Cmd/Ctrl+. | `stop` |

On touch screens, the Line, Block and Para buttons on the editor's title strip do the same.

Web-only features:

- **Sounds menu.** Upload sound files (or drop them on the page), preview them, and use them as `"name.wav" sf>`. Uploads survive a reload.
- **Sliders.** `"freq" 100 2000 440 xslider` adds a slider under the editor and returns its signal.
- **Files.** The File menu saves named texts in the browser and opens the example files.
- **My prelude.** A saved file that loads after the built-in prelude on every start; the `prelude` word opens it.
- **Downloads.** Recordings, `>sf` output and `sgram` images download instead of opening.

## Building

You need Node.js, CMake, [emsdk](https://emscripten.org/docs/getting_started/downloads.html)
(activated, e.g. `source ~/emsdk/emsdk_env.sh`) and the r8brain submodule:

```bash
git submodule update --init
```

Build the wasm dependencies (fftw, libsndfile and headers) once, into `web/deps`:

```bash
web/build-deps.sh
```

Build sapf and the editor:

```bash
web/build.sh
```

Serve the page. The dev server sends the cross-origin isolation headers that wasm threads
need, so plain `python3 -m http.server` will not work:

```bash
python3 web/serve.py 8765
```

Then open http://localhost:8765.

## Testing

```bash
node web/smoke.mjs
```

```bash
node web/sapf-text.test.mjs
```

```bash
node web/build/test_sapf.js
```

`smoke.mjs` runs sapf's 369 language tests from `unit-tests.txt` plus playback, threads and
sound-file checks on a Node build. `test_sapf.js` is sapf's C++ test suite.

## Deploying

Publishing a GitHub Release runs [`.github/workflows/web.yml`](.github/workflows/web.yml): it builds,
tests, deploys the page to a Cloudflare Worker and attaches `sapf-web.zip` to the release.
Prereleases get the zip but do not replace the live site. The repository needs the secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Desktop build

The native sources and meson build from upstream are still here. For desktop build
instructions, see [ahihi/sapf](https://github.com/ahihi/sapf). The original sapf documentation
is in [README.txt](README.txt).

## Licence

GPL-3.0, like sapf (see [COPYING](COPYING)). The deployed page links to the exact commit it was
built from.

Sample rate converter by Aleksey Vaneev of Voxengo (r8brain).
