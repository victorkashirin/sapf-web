#pragma once
// Web shim for RtAudio: instead of opening a device, openStream() registers the
// callback; JS pulls audio by calling sapf_render() (see web/sapf_web.cpp),
// which runs every open stream's callback and sums them.
#include <string>
#include <vector>
#include <algorithm>
#include <iostream> // Play.cpp relies on the real RtAudio.h pulling this in
#include <mutex>

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

	struct Stream { RtAudioCallback cb; void* user; unsigned int nChannels; };
	static std::vector<Stream>& streams() { static std::vector<Stream> s; return s; }
	// Guards streams(). sapf_render holds it for the whole render, so closeStream waits for a
	// running callback to finish before Play.cpp deletes the Player (like a real stopStream).
	static std::mutex& streamsMutex() { static std::mutex m; return m; }

	unsigned int getDeviceCount() { return 1; }
	unsigned int getDefaultOutputDevice() { return 0; }

	int openStream(StreamParameters* out, StreamParameters*, RtAudioFormat, unsigned int,
	               unsigned int*, RtAudioCallback cb, void* user, StreamOptions* = nullptr) {
		mUser = user;
		std::lock_guard<std::mutex> lock(streamsMutex());
		streams().push_back({cb, user, out->nChannels});
		mOpen = true;
		return 0;
	}
	int startStream() { return 0; }
	int stopStream() { return 0; }
	int abortStream() { return 0; }
	void closeStream() {
		std::lock_guard<std::mutex> lock(streamsMutex());
		auto& s = streams();
		s.erase(std::remove_if(s.begin(), s.end(), [&](const Stream& x) { return x.user == mUser; }), s.end());
		mOpen = false;
	}
	bool isStreamOpen() const { return mOpen; }
	bool isStreamRunning() const { return mOpen; }
	~RtAudio() { if (mOpen) closeStream(); }

private:
	void* mUser = nullptr;
	bool mOpen = false;
};
