// Web entry point: replaces src/main.cpp. JS calls sapf_init, sapf_eval and sapf_render.
#include "VM.hpp"
#include "ErrorCodes.hpp"
#include <RtAudio.h>
#include <emscripten/emscripten.h>
#include <locale.h>

extern void AddCoreOps();
extern void AddMathOps();
extern void AddStreamOps();
extern void AddUGenOps();
extern void AddSetOps();
extern void AddRandomOps();
extern void AddMidiOps();
extern void AddOscOps();
void loadFile(Thread& th, const char* filename);

static Thread* gThread;

extern "C" {

EMSCRIPTEN_KEEPALIVE void sapf_init(double sampleRate, const char* preludeFile)
{
	setlocale(LC_NUMERIC, "C");
	vm.setSampleRate(sampleRate);
	AddCoreOps();
	AddMathOps();
	AddStreamOps();
	AddRandomOps();
	AddUGenOps();
	AddMidiOps();
	AddOscOps();
	AddSetOps();
	gThread = new Thread();
	if (preludeFile && *preludeFile) loadFile(*gThread, preludeFile);
}

// Same as one iteration of Thread::repl, with the line taken from a string.
EMSCRIPTEN_KEEPALIVE void sapf_eval(const char* code)
{
	Thread& th = *gThread;
	try {
		P<Fun> compiledFun;
		if (th.compile(code, compiledFun, true)) compiledFun->runREPL(th);
		if (th.stackDepth()) { th.printStack(); post("\n"); }
	} catch (V& v) {
		post("error: "); v.print(th); post("\n");
	} catch (int err) {
		if (err <= -1000 && err > -1000 - kNumErrors) post("error: %s\n", errString[-1000 - err]);
		else post("error: %d\n", err);
	} catch (std::bad_alloc&) {
		post("not enough memory\n");
	} catch (...) {
		post("unknown error\n");
	}
}

// Pull `frames` frames from every playing stream, summed into planar `out` [channels][frames].
EMSCRIPTEN_KEEPALIVE void sapf_render(float* out, int frames, int channels)
{
	static std::vector<float> tmp;
	memset(out, 0, sizeof(float) * frames * channels);
	auto streams = RtAudio::streams(); // copy: a callback must not invalidate our iteration
	for (auto& s : streams) {
		tmp.assign((size_t)frames * s.nChannels, 0.f);
		s.cb(tmp.data(), nullptr, frames, 0., 0, s.user);
		for (int c = 0; c < channels && c < (int)s.nChannels; ++c)
			for (int i = 0; i < frames; ++i) out[c * frames + i] += tmp[c * frames + i];
	}
}

EMSCRIPTEN_KEEPALIVE int sapf_num_playing() { return (int)RtAudio::streams().size(); }

}
