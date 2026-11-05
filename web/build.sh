#!/bin/bash
# Build sapf for the web with Emscripten (single-threaded spike).
# usage: DEPS=/path/with/xsimd-and-eigen-and-fftw3.h-and-sndfile.h web/build.sh
set -e
cd "$(dirname "$0")/.."
: "${DEPS:?set DEPS to a dir containing xsimd-13.2.0/, eigen-3.4.0/ and inc/{fftw3.h,sndfile.h}}"
OUT=web/build; mkdir -p $OUT/obj

FLAGS="-std=c++17 -O2 -msimd128 -fexceptions -D_USE_MATH_DEFINES -DSAMPLE_IS_DOUBLE=1 -DUSE_LIBEDIT=0
  -Iweb/shim -Iinclude -Ithird_party/r8brain/src -I$DEPS/inc -I$DEPS/xsimd-13.2.0/include -I$DEPS/eigen-3.4.0"

SRCS="$(grep -oE "'src/[A-Za-z_]+\.cpp'" meson.build | tr -d "'" | sort -u | grep -vE 'main.cpp|makeImage.cpp') web/sapf_web.cpp web/stubs.cpp web/fftw_shim.cpp third_party/r8brain/src/r8bbase.cpp"
OBJS=""
for f in $SRCS; do
  o=$OUT/obj/$(basename $f .cpp).o
  [ $o -nt $f ] || em++ $FLAGS -c $f -o $o &
  OBJS="$OBJS $o"
done
wait

em++ $OBJS -o $OUT/sapf.mjs -O2 -fexceptions \
  -sMODULARIZE -sEXPORT_ES6 -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=256MB -sSTACK_SIZE=4MB \
  -sEXPORTED_FUNCTIONS=_sapf_init,_sapf_eval,_sapf_render,_sapf_num_playing,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=ccall,HEAPF32 \
  --embed-file sapf-prelude.txt
echo "built $OUT/sapf.mjs"
