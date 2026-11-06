// Web entry point: replaces src/main.cpp.
// JS calls sapf_init once, then sapf_eval to queue code. Code runs on a dedicated evaluation
// thread (like the REPL thread in src/main.cpp), so a slow evaluation blocks neither the page
// nor the audio. The audio side calls sapf_render (see audio_worklet.cpp and web/smoke.mjs).
#include "VM.hpp"
#include "ErrorCodes.hpp"
#include <RtAudio.h>
#include <emscripten/emscripten.h>
#include <locale.h>
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <map>
#include <string>
#include <thread>
#include <vector>

extern void AddCoreOps();
extern void AddMathOps();
extern void AddStreamOps();
extern void AddUGenOps();
extern void AddSetOps();
extern void AddRandomOps();
extern void AddMidiOps();
extern void AddOscOps();
void loadFile(Thread& th, const char* filename);
void zctl_(Thread& th, Prim* prim); // src/Midi.cpp

// Ops like sgram, >sfo and prelude run `open <file>` through system(). Never run a command (under
// Node Emscripten's system() would use the host shell); hand an `open`ed file to the page instead,
// which downloads it. Sync, so the path string outlives the call.
extern "C" int system(const char* cmd)
{
	if (!cmd || strncmp(cmd, "open ", 5)) return -1;
	std::string path(cmd + 5);
	while (!path.empty() && (path.back() == '\n' || path.back() == ' ')) path.pop_back();
	if (path.size() >= 2 && path.front() == '"' && path.back() == '"') path = path.substr(1, path.size() - 2);
	MAIN_THREAD_EM_ASM({ if (Module.onSapfOpen) Module.onSapfOpen(UTF8ToString($0)); }, path.c_str());
	return 0;
}

void setMousePosition(float x, float y); // src/UGen.cpp

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

// Page sliders. Each name owns one ZRef for the session; `slider` returns its smoothed signal
// (zctl) and the page writes it through sapf_set_ctl, so moves never wait for the eval queue.
static std::mutex gCtlMutex;
static std::map<std::string, int> gCtlIds; // entries are never removed, so key pointers stay valid
static std::vector<P<ZRef>> gCtls;

static void slider(Thread& th, bool exponential)
{
	const char* op = exponential ? "xslider" : "slider";
	Z def = th.popFloat(op);
	Z hi = th.popFloat(op);
	Z lo = th.popFloat(op);
	P<String> name = th.popString(op);
	if (exponential && !(lo * hi > 0.)) { post("xslider : lo and hi must be non-zero with the same sign\n"); throw errOutOfRange; }
	if (lo > hi) std::swap(lo, hi);
	P<ZRef> ref;
	int id;
	const char* key;
	{
		std::lock_guard<std::mutex> lock(gCtlMutex);
		auto [it, isNew] = gCtlIds.try_emplace(name->s, (int)gCtls.size());
		if (isNew) gCtls.push_back(new ZRef(def));
		id = it->second;
		key = it->first.c_str();
		ref = gCtls[id];
		ref->z = std::clamp(ref->z, lo, hi); // re-running keeps the slider's position, within the new range
	}
	// Async so evaluation never waits on the page.
	MAIN_THREAD_ASYNC_EM_ASM({ if (Module.onSapfSlider) Module.onSapfSlider($0, UTF8ToString($1), $2, $3, $4, $5); },
		id, key, lo, hi, ref->z, (int)exponential);
	th.push(ref);
	zctl_(th, nullptr);
}

extern "C" {

// Called by the page when a slider moves.
EMSCRIPTEN_KEEPALIVE void sapf_set_ctl(int id, double value)
{
	std::lock_guard<std::mutex> lock(gCtlMutex);
	if (id >= 0 && id < (int)gCtls.size()) gCtls[id]->z = value;
}

// Called by the page on pointer moves: x and y in [0,1], y = 1 at the top, as on the desktop.
EMSCRIPTEN_KEEPALIVE void sapf_set_mouse(float x, float y)
{
	setMousePosition(x, y);
}

EMSCRIPTEN_KEEPALIVE void sapf_init(double sampleRate, const char* preludeFile)
{
	setlocale(LC_NUMERIC, "C");
	// The audio worklet pulls 128 frames per callback. With sapf's default 512-frame signal blocks, one
	// callback in four computes all the audio and the others nearly nothing, so audio drops out at
	// under 20% average CPU. Cost: `kr`/`krc` factors must divide 128. kr as in VM::setSampleRate.
	vm.ar = Rate(sampleRate, 128);
	vm.kr = Rate(vm.ar, kDefaultControlBlockSize);
	AddCoreOps();
	AddMathOps();
	AddStreamOps();
	AddRandomOps();
	AddUGenOps();
	AddMidiOps();
	AddOscOps();
	AddSetOps();
	vm.addBifHelp("\n*** page sliders (web) ***");
	vm.def("slider", 4, 1, [](Thread& th, Prim*) { slider(th, false); },
		"(name lo hi default --> out) smoothed signal of a page slider with the linear range [lo,hi]. Running it again keeps the slider's position.");
	vm.def("xslider", 4, 1, [](Thread& th, Prim*) { slider(th, true); },
		"(name lo hi default --> out) smoothed signal of a page slider with the exponential range [lo,hi]. Running it again keeps the slider's position.");
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
	auto& streams = RtAudio::streams();
	for (auto& s : streams) {
		tmp.assign((size_t)frames * s.nChannels, 0.f);
		s.cb(tmp.data(), nullptr, frames, 0., 0, s.user);
		int fadeStart = s.fadeLeft;
		for (int c = 0; c < channels && c < (int)s.nChannels; ++c) {
			float* src = tmp.data() + c * frames;
			if (fadeStart >= 0) // linear fade-out requested by RtAudio::stopStream, then silence
				for (int i = 0; i < frames; ++i) src[i] *= i < fadeStart ? (float)(fadeStart - i) / s.fadeTotal : 0.f;
			for (int i = 0; i < frames; ++i) out[c * frames + i] += src[i];
		}
		if (fadeStart >= 0) s.fadeLeft = std::max(0, fadeStart - frames);
	}
	// faded out: drop it so the waiting stopStream returns and Play.cpp can delete the Player
	streams.erase(std::remove_if(streams.begin(), streams.end(), [](const RtAudio::Stream& s) { return s.fadeLeft == 0; }), streams.end());
}

EMSCRIPTEN_KEEPALIVE int sapf_num_playing()
{
	std::lock_guard<std::mutex> lock(RtAudio::streamsMutex());
	return (int)RtAudio::streams().size();
}

}
