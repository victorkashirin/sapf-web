#pragma once
// Web shim for RtMidi: no MIDI ports. shortcut: MIDI is disabled, upgrade to Web MIDI when needed.
#include <string>
#include <vector>

class RtMidiError {
public:
	const std::string& getMessage() const { return mMsg; }
private:
	std::string mMsg = "no MIDI on web";
};

class RtMidi {
public:
	virtual ~RtMidi() = default;
	unsigned int getPortCount() { return 0; }
	std::string getPortName(unsigned int) { return ""; }
	void openPort(unsigned int = 0, const std::string& = "") {}
	void closePort() {}
	bool isPortOpen() const { return false; }
};

class RtMidiIn : public RtMidi {
public:
	typedef void (*RtMidiCallback)(double timeStamp, std::vector<unsigned char>* message, void* userData);
	void setCallback(RtMidiCallback, void* = nullptr) {}
	void ignoreTypes(bool = true, bool = true, bool = true) {}
};

class RtMidiOut : public RtMidi {
public:
	void sendMessage(const std::vector<unsigned char>*) {}
	void sendMessage(const unsigned char*, size_t) {}
};
