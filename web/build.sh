#!/bin/bash
# Build sapf for the web with Emscripten, with pthreads (evaluation thread, `go`, `sleep`) and a
# Wasm Audio Worklet (audio thread). Outputs:
#   web/build/sapf.mjs       browser build (needs cross-origin isolation, see web/serve.py)
#   web/build/sapf-node.mjs  Node build without audio output, for web/smoke.mjs
#   web/build/test_sapf.js   sapf's C++ doctest suite (test/*.cpp); run: node web/build/test_sapf.js
# usage: web/build.sh   (prepare deps once with web/build-deps.sh; DEPS defaults to web/deps)
# SANITIZE=address (or undefined, ...) builds the two Node outputs with that sanitizer into
# web/build-<sanitizer>/ instead; run smoke.mjs against it with SAPF_NODE_MODULE.
set -e
cd "$(dirname "$0")/.."
DEPS="${DEPS:-$PWD/web/deps}"
# An emscripten config in $DEPS is used when EM_CONFIG is unset (e.g. Homebrew's emscripten lost its own)
[ -z "$EM_CONFIG" ] && [ -f "$DEPS/emscripten-config" ] && export EM_CONFIG="$DEPS/emscripten-config"
OUT=web/build${SANITIZE:+-$SANITIZE}; rm -rf $OUT/obj; mkdir -p $OUT/obj
SAN="${SANITIZE:+-fsanitize=$SANITIZE -g}"

FLAGS="-std=c++17 -O2 -msimd128 -fexceptions -pthread -sUSE_LIBJPEG=1 -D_USE_MATH_DEFINES -DSAMPLE_IS_DOUBLE=1 -DUSE_LIBEDIT=0
  -Iweb/shim -Iinclude -Ithird_party/r8brain/src -I$DEPS/prefix/include -I$DEPS/xsimd-13.2.0/include -I$DEPS/eigen-3.4.0 $SAN"

SRCS="$(grep -oE "'src/[A-Za-z_]+\.cpp'" meson.build | tr -d "'" | sort -u | grep -v main.cpp) web/sapf_web.cpp third_party/r8brain/src/r8bbase.cpp"
OBJS=""
TEST_SRCS="test/doctest.cpp test/ImageHelpers.cpp $(ls test/test_*.cpp)"
for f in $SRCS web/audio_worklet.cpp; do
  em++ $FLAGS -c $f -o $OUT/obj/$(basename $f .cpp).o &
done
for f in $TEST_SRCS; do
  em++ $FLAGS -DTEST_BUILD -Itest/helpers -I$DEPS/doctest-2.4.11/doctest -c $f -o $OUT/obj/$(basename $f .cpp).o &
done
wait
for f in $SRCS; do OBJS="$OBJS $OUT/obj/$(basename $f .cpp).o"; done
OBJS="$OBJS $DEPS/prefix/lib/libsndfile.a $DEPS/prefix/lib/libfftw3.a"

# Thread stacks: Emscripten's default is 64 KB; sapf's evaluator recurses deeply (native threads get 512 KB+).
BASE="-O2 -fexceptions -pthread -sUSE_LIBJPEG=1 -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=256MB
  -sSTACK_SIZE=4MB -sDEFAULT_PTHREAD_STACK_SIZE=2MB -sPTHREAD_POOL_SIZE=4 $SAN"
# Sanitizers make Emscripten default to EXIT_RUNTIME, which shuts a main-less module down right
# after start-up (killing the evaluation thread). Keep it running; test_sapf.js still checks leaks at exit.
LINK="$BASE -sMODULARIZE -sEXPORT_ES6 --embed-file sapf-prelude.txt ${SANITIZE:+-sEXIT_RUNTIME=0}"
EXPORTS=_sapf_init,_sapf_eval,_sapf_busy,_sapf_render,_sapf_num_playing,_malloc,_free

[ -n "$SANITIZE" ] || em++ $OBJS $OUT/obj/audio_worklet.o -o $OUT/sapf.mjs $LINK -sENVIRONMENT=web \
  -sAUDIO_WORKLET -sWASM_WORKERS -sEXPORTED_FUNCTIONS=$EXPORTS,_sapf_start_audio,_sapf_audio_node \
  -sEXPORTED_RUNTIME_METHODS=ccall,FS,emscriptenGetAudioObject
em++ $OBJS -o $OUT/sapf-node.mjs $LINK -sENVIRONMENT=node -sEXPORTED_FUNCTIONS=$EXPORTS \
  -sEXPORTED_RUNTIME_METHODS=ccall,FS,HEAPF32
# doctest's main runs on a pthread (PROXY_TO_PTHREAD), so tests may block and join threads;
# the process exit code is the test result.
TEST_OBJS=""; for f in $TEST_SRCS; do TEST_OBJS="$TEST_OBJS $OUT/obj/$(basename $f .cpp).o"; done
em++ $OBJS $TEST_OBJS -o $OUT/test_sapf.js $BASE -sENVIRONMENT=node -sPROXY_TO_PTHREAD -sEXIT_RUNTIME
echo "built $(ls $OUT/*.mjs $OUT/*.js | tr '\n' ' ')"
