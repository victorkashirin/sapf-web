#pragma once
// Web shim: the terminal REPL is never used on web; code comes in through sapf_eval().
static char* rl_prompt = nullptr;
static inline char* readline(char*) { return nullptr; }
static inline void rl_set_prompt(const char*) {}
static inline int rl_insert(int, int) { return 0; }
static inline int rl_bind_key(int, int (*)(int, int)) { return 0; }
