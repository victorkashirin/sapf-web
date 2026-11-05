// Minimal stand-in for the 7 fftw3 functions src/dsp.cpp uses, so the web build needs no fftw.
// shortcut: radix-2 only and slower than fftw; sapf only plans power-of-two sizes. Upgrade to a real fftw/pocketfft wasm build for speed.
#include <fftw3.h>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <complex>
#include <vector>

typedef std::complex<double> C;

struct fftw_plan_s {
	enum Kind { c2c, r2c, c2r } kind;
	int n, sign;
	void* in;
	void* out;
};

static void fftInPlace(C* a, int n, int sign)
{
	for (int i = 1, j = 0; i < n; ++i) { // bit reversal
		int bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) std::swap(a[i], a[j]);
	}
	for (int len = 2; len <= n; len <<= 1) {
		double ang = sign * 2 * M_PI / len;
		C wl(cos(ang), sin(ang));
		for (int i = 0; i < n; i += len) {
			C w(1);
			for (int k = 0; k < len / 2; ++k, w *= wl) {
				C u = a[i + k], v = a[i + k + len / 2] * w;
				a[i + k] = u + v;
				a[i + k + len / 2] = u - v;
			}
		}
	}
}

static fftw_plan mk(fftw_plan_s::Kind k, int n, int sign, void* in, void* out)
{
	if (n & (n - 1)) abort(); // non power of two: never requested by sapf
	return new fftw_plan_s{k, n, sign, in, out};
}

extern "C" {
void* fftw_malloc(size_t n) { return malloc(n); }
void fftw_free(void* p) { free(p); }
void fftw_destroy_plan(fftw_plan p) { delete p; }
fftw_plan fftw_plan_dft_1d(int n, fftw_complex* in, fftw_complex* out, int sign, unsigned) { return mk(fftw_plan_s::c2c, n, sign, in, out); }
fftw_plan fftw_plan_dft_r2c_1d(int n, double* in, fftw_complex* out, unsigned) { return mk(fftw_plan_s::r2c, n, FFTW_FORWARD, in, out); }
fftw_plan fftw_plan_dft_c2r_1d(int n, fftw_complex* in, double* out, unsigned) { return mk(fftw_plan_s::c2r, n, FFTW_BACKWARD, in, out); }

void fftw_execute(const fftw_plan p)
{
	int n = p->n;
	if (p->kind == fftw_plan_s::c2c) {
		C* out = (C*)p->out;
		if (p->in != p->out) memcpy(out, p->in, n * sizeof(C));
		fftInPlace(out, n, p->sign);
		return;
	}
	std::vector<C> t(n); // temp: sapf runs r2c/c2r in place
	if (p->kind == fftw_plan_s::r2c) {
		double* in = (double*)p->in;
		for (int i = 0; i < n; ++i) t[i] = in[i];
		fftInPlace(t.data(), n, FFTW_FORWARD);
		memcpy(p->out, t.data(), (n / 2 + 1) * sizeof(C));
	} else {
		C* in = (C*)p->in;
		for (int i = 0; i <= n / 2; ++i) t[i] = in[i];
		for (int i = n / 2 + 1; i < n; ++i) t[i] = std::conj(in[n - i]);
		fftInPlace(t.data(), n, FFTW_BACKWARD);
		double* out = (double*)p->out;
		for (int i = 0; i < n; ++i) out[i] = t[i].real();
	}
}
}
