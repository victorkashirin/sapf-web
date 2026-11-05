#pragma once
// Web shim: no line-editing history on web.
static inline void add_history(const char*) {}
static inline int write_history(const char*) { return 0; }
static inline int read_history(const char*) { return 0; }
static inline void using_history() {}
static inline void stifle_history(int) {}
