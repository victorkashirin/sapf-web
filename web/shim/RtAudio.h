#pragma once
// Web shim for RtAudio: instead of opening a device, openStream() registers the
// callback; the audio thread pulls audio by calling sapf_render() (see web/sapf_web.cpp),
// which runs every open stream's callback and sums them.
#include <string>
#include <vector>
#include <algorithm>
#include <chrono>
#include <iostream> // Play.cpp relies on the real RtAudio.h pulling this in
#include <mutex>
#include <thread>

typedef unsigned long RtAudioFormat;
typedef unsigned int RtAudioStreamFlags;
typedef unsigned int RtAudioStreamStatus;
static const RtAudioFormat RTAUDIO_FLOAT32 = 0x10;
static const RtAudioStreamFlags RTAUDIO_NONINTERLEAVED = 0x1;

typedef int (*RtAudioCallback)(void* outputBuffer, void* inputBuffer, unsigned int nFrames,
                               double streamTime, RtAudioStreamStatus status, void* userData);

class RtAudio {
public:
	struct StreamParameters { unsigned int deviceId = 0, nChannels = 0, firstChannel = 0; };
	struct StreamOptions { RtAudioStreamFlags flags = 0; };

	// fadeLeft < 0: playing. fadeLeft >= 0: fading out, frames left; sapf_render drops it at 0.
	struct Stream { RtAudioCallback cb; void* user; unsigned int nChannels; int fadeLeft; int fadeTotal; };
	static std::vector<Stream>& streams() { static std::vector<Stream> s; return s; }
	// Guards streams(). sapf_render holds it for the whole render, so closeStream waits for a
	// running callback to finish before Play.cpp deletes the Player (like a real stopStream).
	static std::mutex& streamsMutex() { static std::mutex m; return m; }

	static constexpr double kFadeSeconds = 0.01;
	// How long stopStream waits for the audio thread beyond the fade (audio may be suspended).
	static constexpr double kFadeTimeoutSeconds = 0.2;

	unsigned int getDeviceCount() { return 1; }
	unsigned int getDefaultOutputDevice() { return 0; }

	int openStream(StreamParameters* out, StreamParameters*, RtAudioFormat, unsigned int sampleRate,
	               unsigned int*, RtAudioCallback cb, void* user, StreamOptions* = nullptr) {
		mUser = user;
		mFadeFrames = std::max(1, (int)(sampleRate * kFadeSeconds));
		std::lock_guard<std::mutex> lock(streamsMutex());
		streams().push_back({cb, user, out->nChannels, -1, 0});
		mOpen = mRunning = true;
		return 0;
	}
	int startStream() { return 0; }

	// Fades the stream out instead of cutting it (a cut clicks). Play.cpp deletes the Player right
	// after stopping, so this waits until the audio thread has played the fade and dropped the stream.
	int stopStream() {
		mRunning = false;
		{
			std::lock_guard<std::mutex> lock(streamsMutex());
			Stream* s = find();
			if (!s) return 0;
			s->fadeLeft = s->fadeTotal = mFadeFrames;
		}
		auto deadline = std::chrono::steady_clock::now() +
			std::chrono::duration<double>(kFadeSeconds + kFadeTimeoutSeconds);
		while (std::chrono::steady_clock::now() < deadline) {
			{
				std::lock_guard<std::mutex> lock(streamsMutex());
				if (!find()) return 0;
			}
			std::this_thread::sleep_for(std::chrono::milliseconds(1));
		}
		return 0; // audio thread is not running; closeStream removes the stream
	}
	int abortStream() { return stopStream(); }
	void closeStream() {
		std::lock_guard<std::mutex> lock(streamsMutex());
		auto& s = streams();
		s.erase(std::remove_if(s.begin(), s.end(), [&](const Stream& x) { return x.user == mUser; }), s.end());
		mOpen = mRunning = false;
	}
	bool isStreamOpen() const { return mOpen; }
	bool isStreamRunning() const { return mRunning; }
	~RtAudio() { if (mOpen) closeStream(); }

private:
	// caller holds streamsMutex()
	Stream* find() {
		for (auto& s : streams()) if (s.user == mUser) return &s;
		return nullptr;
	}

	void* mUser = nullptr;
	int mFadeFrames = 1;
	bool mOpen = false;
	bool mRunning = false;
};
