#!/bin/bash
# Build sapf for the web with Emscripten, with pthreads (evaluation thread, `go`, `sleep`) and a
# Wasm Audio Worklet (audio thread). Outputs:
#   web/build/sapf.mjs       browser build (needs cross-origin isolation, see web/serve.py)
#   web/build/sapf-node.mjs  Node build without audio output, for web/smoke.mjs
# usage: DEPS=/path/with/xsimd-and-eigen-and-fftw3.h-and-sndfile.h web/build.sh
set -e
cd "$(dirname "$0")/.."
: "${DEPS:?set DEPS to a dir containing xsimd-13.2.0/, eigen-3.4.0/ and inc/{fftw3.h,sndfile.h}}"
OUT=web/build; rm -rf $OUT/obj; mkdir -p $OUT/obj

FLAGS="-std=c++17 -O2 -msimd128 -fexceptions -pthread -D_USE_MATH_DEFINES -DSAMPLE_IS_DOUBLE=1 -DUSE_LIBEDIT=0
  -Iweb/shim -Iinclude -Ithird_party/r8brain/src -I$DEPS/inc -I$DEPS/xsimd-13.2.0/include -I$DEPS/eigen-3.4.0"

SRCS="$(grep -oE "'src/[A-Za-z_]+\.cpp'" meson.build | tr -d "'" | sort -u | grep -vE 'main.cpp|makeImage.cpp') web/sapf_web.cpp web/stubs.cpp web/fftw_shim.cpp third_party/r8brain/src/r8bbase.cpp"
OBJS=""
for f in $SRCS web/audio_worklet.cpp; do
  em++ $FLAGS -c $f -o $OUT/obj/$(basename $f .cpp).o &
done
wait
for f in $SRCS; do OBJS="$OBJS $OUT/obj/$(basename $f .cpp).o"; done

# Thread stacks: Emscripten's default is 64 KB; sapf's evaluator recurses deeply (native threads get 512 KB+).
LINK="-O2 -fexceptions -pthread -sMODULARIZE -sEXPORT_ES6 -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=256MB
  -sSTACK_SIZE=4MB -sDEFAULT_PTHREAD_STACK_SIZE=2MB -sPTHREAD_POOL_SIZE=4
  --embed-file sapf-prelude.txt"
EXPORTS=_sapf_init,_sapf_eval,_sapf_busy,_sapf_render,_sapf_num_playing,_malloc,_free

em++ $OBJS $OUT/obj/audio_worklet.o -o $OUT/sapf.mjs $LINK -sENVIRONMENT=web \
  -sAUDIO_WORKLET -sWASM_WORKERS -sEXPORTED_FUNCTIONS=$EXPORTS,_sapf_start_audio,_sapf_audio_node \
  -sEXPORTED_RUNTIME_METHODS=ccall,emscriptenGetAudioObject
em++ $OBJS -o $OUT/sapf-node.mjs $LINK -sENVIRONMENT=node -sEXPORTED_FUNCTIONS=$EXPORTS \
  -sEXPORTED_RUNTIME_METHODS=ccall,HEAPF32
echo "built $OUT/sapf.mjs and $OUT/sapf-node.mjs"
