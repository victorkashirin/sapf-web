#pragma once

#if defined(SAPF_AUDIOTOOLBOX)
#include <AudioToolbox/AudioToolbox.h>
#elif defined(SAPF_RTAUDIO_H)
#include SAPF_RTAUDIO_H
#else
#include <RtAudio.h>
#endif
#include <cstdint>
#include <memory>

#ifdef SAPF_AUDIOTOOLBOX
class AUBuffers {
public:
    AUBuffers(AudioBufferList *inIoData);
    uint32_t count() const;
    float *data(int channel) const;
    uint32_t size(int channel) const;
    AudioBufferList *ioData;
};
typedef AUBuffers Buffers;
#else
class RtBuffers {
public:
    RtBuffers(float *inOut, uint32_t inCount, uint32_t inSize);
    RtBuffers(uint32_t inCount, uint32_t inSize);
    uint32_t count() const;
    float *data(int channel) const;
    // despite what this may imply, size isn't actually variable per buffer.
    // This is just for compatibility with AUBuffers
    uint32_t size(int channel) const;
    float *out;
    uint32_t theCount;
    uint32_t theSize;
private:
    std::unique_ptr<float[]> owned; // set by the (count, size) constructor, which allocates `out`
};
typedef RtBuffers Buffers;
#endif