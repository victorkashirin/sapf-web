#!/bin/bash
# Download and build sapf's web dependencies with Emscripten into $DEPS.
# Header-only: xsimd, eigen, doctest (for the C++ tests). Built as static wasm libraries (with -pthread, since sapf's web build
# uses shared memory): fftw3 (double precision) and libsndfile (WAV/AIFF/etc., no external codecs).
# usage: DEPS=/path/to/deps web/build-deps.sh
set -e
: "${DEPS:?set DEPS to the directory to download and build dependencies in}"
mkdir -p "$DEPS" && cd "$DEPS"
PREFIX="$DEPS/prefix"

fetch() { # url file sha256
  [ -f "$2" ] || curl -sSL -o "$2" "$1"
  echo "$3  $2" | shasum -a 256 -c - >/dev/null || { echo "checksum mismatch for $2" >&2; exit 1; }
}
fetch https://github.com/xtensor-stack/xsimd/archive/refs/tags/13.2.0.tar.gz xsimd.tgz edd8cd3d548c185adc70321c53c36df41abe64c1fe2c67bc6d93c3ecda82447a
fetch https://gitlab.com/libeigen/eigen/-/archive/3.4.0/eigen-3.4.0.tar.bz2 eigen.tbz b4c198460eba6f28d34894e3a5710998818515104d6e74e5cc331ce31e46e626
fetch https://github.com/doctest/doctest/archive/refs/tags/v2.4.11.tar.gz doctest.tgz 632ed2c05a7f53fa961381497bf8069093f0d6628c5f26286161fbd32a560186
fetch https://www.fftw.org/fftw-3.3.10.tar.gz fftw.tgz 56c932549852cddcfafdab3820b0200c7742675be92179e59e6215b340e26467
fetch https://github.com/libsndfile/libsndfile/releases/download/1.2.2/libsndfile-1.2.2.tar.xz sndfile.txz 3799ca9924d3125038880367bf1468e53a1b7e3686a934f098b7e1d286cdb80e
for f in xsimd.tgz eigen.tbz doctest.tgz fftw.tgz sndfile.txz; do tar xf $f; done

CFLAGS="-O3 -pthread"
# fftw 3.3.10 and libsndfile 1.2.2 declare CMake minimums below 3.5, which CMake 4 rejects
export CMAKE_POLICY_VERSION_MINIMUM=3.5
emcmake cmake -S fftw-3.3.10 -B build-fftw -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  -DCMAKE_C_FLAGS="$CFLAGS" -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTS=OFF -DENABLE_THREADS=OFF -DENABLE_OPENMP=OFF
cmake --build build-fftw -j8 && cmake --install build-fftw

emcmake cmake -S libsndfile-1.2.2 -B build-sndfile -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  -DCMAKE_C_FLAGS="$CFLAGS" -DBUILD_SHARED_LIBS=OFF -DBUILD_PROGRAMS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_TESTING=OFF \
  -DENABLE_EXTERNAL_LIBS=OFF -DENABLE_MPEG=OFF -DENABLE_CPACK=OFF -DINSTALL_MANPAGES=OFF
cmake --build build-sndfile -j8 && cmake --install build-sndfile

echo "dependencies ready in $DEPS (libraries in $PREFIX)"
