// Link stubs for libraries not yet built for wasm.
#include "makeImage.hpp"
#include "VM.hpp"

// shortcut: spectrogram JPEG output disabled, upgrade by building libjpeg (emscripten port USE_LIBJPEG).
Bitmap::Bitmap(int width, int height) : mWidth(width), mHeight(height), mBytesPerRow(width * 3) {}
Bitmap::~Bitmap() {}
void Bitmap::setPixel(int, int, int, int, int) {}
void Bitmap::fillRect(int, int, int, int, int, int, int) {}
void Bitmap::write(const char*) const { post("image output is not available on web\n"); }

// shortcut: sound file read/write disabled (sf_open fails cleanly), upgrade by building libsndfile for wasm.
#include <sndfile.h>
extern "C" {
SNDFILE* sf_open(const char*, int, SF_INFO*) { return nullptr; }
int sf_close(SNDFILE*) { return 0; }
const char* sf_strerror(SNDFILE*) { return "sound files are not available on web yet"; }
sf_count_t sf_readf_double(SNDFILE*, double*, sf_count_t) { return 0; }
sf_count_t sf_write_float(SNDFILE*, const float*, sf_count_t) { return 0; }
sf_count_t sf_seek(SNDFILE*, sf_count_t, int) { return -1; }
}
