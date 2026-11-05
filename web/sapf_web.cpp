// Web entry point: replaces src/main.cpp.
// JS calls sapf_init once, then sapf_eval to queue code. Code runs on a dedicated evaluation
// thread (like the REPL thread in src/main.cpp), so a slow evaluation blocks neither the page
// nor the audio. The audio side calls sapf_render (see audio_worklet.cpp and web/smoke.mjs).
#include "VM.hpp"
#include "ErrorCodes.hpp"
#include <RtAudio.h>
#include <emscripten/emscripten.h>
#include <locale.h>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <string>
#include <thread>

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
static std::mutex gQueueMutex;
static std::condition_variable gQueueCV;
static std::deque<std::string> gQueue;
static std::atomic<int> gPending{0}; // queued + running evaluations

// Same as one iteration of Thread::repl, with the line taken from a string.
static void evalNow(const char* code)
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

static void evalLoop(std::string preludeFile)
{
	if (!preludeFile.empty()) loadFile(*gThread, preludeFile.c_str());
	--gPending;
	for (;;) {
		std::string code;
		{
			std::unique_lock<std::mutex> lock(gQueueMutex);
			gQueueCV.wait(lock, [] { return !gQueue.empty(); });
			code = std::move(gQueue.front());
			gQueue.pop_front();
		}
		evalNow(code.c_str());
		--gPending;
	}
}

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
	gPending = 1; // the prelude
	std::thread(evalLoop, std::string(preludeFile ? preludeFile : "")).detach();
}

// Queues code for the evaluation thread and returns at once. Output arrives through print.
EMSCRIPTEN_KEEPALIVE void sapf_eval(const char* code)
{
	++gPending;
	{
		std::lock_guard<std::mutex> lock(gQueueMutex);
		gQueue.emplace_back(code);
	}
	gQueueCV.notify_one();
}

// Non-zero while the prelude or queued code has not finished evaluating.
EMSCRIPTEN_KEEPALIVE int sapf_busy() { return gPending.load(); }

// Pull `frames` frames from every playing stream, summed into planar `out` [channels][frames].
EMSCRIPTEN_KEEPALIVE void sapf_render(float* out, int frames, int channels)
{
	static std::vector<float> tmp; // only ever used by the audio thread
	memset(out, 0, sizeof(float) * frames * channels);
	std::lock_guard<std::mutex> lock(RtAudio::streamsMutex());
	for (auto& s : RtAudio::streams()) {
		tmp.assign((size_t)frames * s.nChannels, 0.f);
		s.cb(tmp.data(), nullptr, frames, 0., 0, s.user);
		for (int c = 0; c < channels && c < (int)s.nChannels; ++c)
			for (int i = 0; i < frames; ++i) out[c * frames + i] += tmp[c * frames + i];
	}
}

EMSCRIPTEN_KEEPALIVE int sapf_num_playing()
{
	std::lock_guard<std::mutex> lock(RtAudio::streamsMutex());
	return (int)RtAudio::streams().size();
}

}
