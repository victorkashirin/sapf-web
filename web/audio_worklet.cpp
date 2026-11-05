// Browser audio output through an Emscripten Wasm Audio Worklet: the worklet shares the wasm
// memory with the evaluation thread and calls sapf_render on the audio thread.
// Only linked into the browser build (needs -sAUDIO_WORKLET -sWASM_WORKERS).
#include <emscripten/webaudio.h>
#include <cstdint>
#include <cstdio>

extern "C" {
void sapf_init(double sampleRate, const char* preludeFile);
void sapf_render(float* out, int frames, int channels);
}

// Lazy graphs are evaluated inside sapf_render and can recurse deeply; native audio threads get 512 KB+.
alignas(16) static uint8_t gWorkletStack[1024 * 1024];
static EMSCRIPTEN_WEBAUDIO_T gNode;

static bool process(int, const AudioSampleFrame*, int numOutputs, AudioSampleFrame* outputs,
                    int, const AudioParamFrame*, void*)
{
	if (numOutputs > 0) sapf_render(outputs[0].data, outputs[0].samplesPerChannel, outputs[0].numberOfChannels);
	return true;
}

static void processorCreated(EMSCRIPTEN_WEBAUDIO_T ctx, bool ok, void*)
{
	if (!ok) { printf("could not create the sapf audio worklet processor\n"); return; }
	int outputChannels[1] = {2};
	EmscriptenAudioWorkletNodeCreateOptions options = {};
	options.numberOfInputs = 0;
	options.numberOfOutputs = 1;
	options.outputChannelCounts = outputChannels;
	gNode = emscripten_create_wasm_audio_worklet_node(ctx, "sapf", &options, &process, nullptr);
	emscripten_audio_node_connect(gNode, ctx, 0, 0);
}

static void workletStarted(EMSCRIPTEN_WEBAUDIO_T ctx, bool ok, void*)
{
	if (!ok) { printf("could not start the audio worklet thread\n"); return; }
	WebAudioWorkletProcessorCreateOptions options = {};
	options.name = "sapf";
	emscripten_create_wasm_audio_worklet_processor_async(ctx, &options, &processorCreated, nullptr);
}

extern "C" {

// Call from a user gesture. Creates the AudioContext, initialises sapf at its sample rate and
// starts audio. Returns the context handle (emscriptenGetAudioObject(handle) gives the AudioContext).
EMSCRIPTEN_KEEPALIVE EMSCRIPTEN_WEBAUDIO_T sapf_start_audio(const char* preludeFile)
{
	EMSCRIPTEN_WEBAUDIO_T ctx = emscripten_create_audio_context(nullptr);
	sapf_init(emscripten_audio_context_sample_rate(ctx), preludeFile);
	emscripten_start_wasm_audio_worklet_thread_async(ctx, gWorkletStack, sizeof gWorkletStack, &workletStarted, nullptr);
	return ctx;
}

// Handle of sapf's AudioWorkletNode once it exists (0 before), e.g. to tap it with an analyser.
EMSCRIPTEN_KEEPALIVE EMSCRIPTEN_WEBAUDIO_T sapf_audio_node() { return gNode; }

}
