//    SAPF - Sound As Pure Form
//    Copyright (C) 2019 James McCartney
//
//    This program is free software: you can redistribute it and/or modify
//    it under the terms of the GNU General Public License as published by
//    the Free Software Foundation, either version 3 of the License, or
//    (at your option) any later version.
//
//    This program is distributed in the hope that it will be useful,
//    but WITHOUT ANY WARRANTY; without even the implied warranty of
//    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//    GNU General Public License for more details.
//
//    You should have received a copy of the GNU General Public License
//    along with this program.  If not, see <https://www.gnu.org/licenses/>.

#include "dsp.hpp"
#include "ErrorCodes.hpp"
#include <string.h>
#include <stdio.h>
#include <cmath>

void FFT::init(size_t log2n) {
	this->n = pow(2, log2n);
	this->log2n = log2n;
    
#ifdef SAPF_ACCELERATE
	this->setup = vDSP_create_fftsetupD(this->log2n, kFFTRadix2);
#else
	this->in = (fftw_complex *) fftw_malloc(this->n * sizeof(fftw_complex));
	this->out = (fftw_complex *) fftw_malloc(this->n * sizeof(fftw_complex));
	// "Here, n is the “logical” size of the DFT, not necessarily the
	// physical size of the array. In particular, the real (double) array
	// has n elements, while the complex (fftw_complex) array has n/2+1
	// elements (where the division is rounded down). For an in-place
	// transform, in and out are aliased to the same array, which must be
	// big enough to hold both; so, the real array would actually have
	// 2*(n/2+1) elements, where the elements beyond the first n are unused
	// padding."
	// - https://fftw.org/fftw3_doc/One_002dDimensional-DFTs-of-Real-Data.html
	this->in_out_real = (double *) fftw_malloc(2 * (this->n / 2 + 1) * sizeof(double));
	
	this->forward_out_of_place_plan = fftw_plan_dft_1d(this->n, this->in, this->out, FFTW_FORWARD, FFTW_ESTIMATE);
	this->backward_out_of_place_plan = fftw_plan_dft_1d(this->n, this->in, this->out, FFTW_BACKWARD, FFTW_ESTIMATE);
	this->forward_in_place_plan = fftw_plan_dft_1d(this->n, this->in, this->in, FFTW_FORWARD, FFTW_ESTIMATE);
	this->backward_in_place_plan = fftw_plan_dft_1d(this->n, this->in, this->in, FFTW_BACKWARD, FFTW_ESTIMATE);
	this->forward_real_plan = fftw_plan_dft_r2c_1d(this->n, this->in_out_real, (fftw_complex *) this->in_out_real, FFTW_ESTIMATE);
	this->backward_real_plan = fftw_plan_dft_c2r_1d(this->n, (fftw_complex *) this->in_out_real, this->in_out_real, FFTW_ESTIMATE);
#endif // SAPF_ACCELERATE
}

FFT::~FFT() {
#ifdef SAPF_ACCELERATE
	vDSP_destroy_fftsetupD(this->setup);
#else
	fftw_destroy_plan(forward_out_of_place_plan);
	fftw_destroy_plan(backward_out_of_place_plan);
	fftw_destroy_plan(forward_in_place_plan);
	fftw_destroy_plan(backward_in_place_plan);
	fftw_destroy_plan(forward_real_plan);
	fftw_destroy_plan(backward_real_plan);
	
	fftw_free(this->in);
	fftw_free(this->out);
	fftw_free(this->in_out_real);
#endif // SAPF_ACCELERATE
}

void FFT::forward(double *inReal, double *inImag, double *outReal, double *outImag) {
	double scale = 2. / this->n;
#ifdef SAPF_ACCELERATE
	DSPDoubleSplitComplex in;
	DSPDoubleSplitComplex out;
	
	in.realp = inReal;
	in.imagp = inImag;
	out.realp = outReal;
	out.imagp = outImag;

	vDSP_fft_zopD(this->setup, &in, 1, &out, 1, this->log2n, FFT_FORWARD);

	vDSP_vsmulD(outReal, 1, &scale, outReal, 1, this->n);
	vDSP_vsmulD(outImag, 1, &scale, outImag, 1, this->n);
#else
	for(size_t i = 0; i < this->n; i++) {
		this->in[i][0] = inReal[i];
		this->in[i][1] = inImag[i];
	}
	fftw_execute(this->forward_out_of_place_plan);
	for(size_t i = 0; i < this->n; i++) {
		outReal[i] = this->out[i][0] * scale;
		outImag[i] = this->out[i][1] * scale;
	}
#endif // SAPF_ACCELERATE
}

void FFT::backward(double *inReal, double *inImag, double *outReal, double *outImag) {
	double scale = .5;
#ifdef SAPF_ACCELERATE
	DSPDoubleSplitComplex in;
	DSPDoubleSplitComplex out;
	
	in.realp = inReal;
	in.imagp = inImag;
	out.realp = outReal;
	out.imagp = outImag;

	vDSP_fft_zopD(this->setup, &in, 1, &out, 1, this->log2n, FFT_INVERSE);

	vDSP_vsmulD(outReal, 1, &scale, outReal, 1, this->n);
	vDSP_vsmulD(outImag, 1, &scale, outImag, 1, this->n);
#else
	for(size_t i = 0; i < this->n; i++) {
		this->in[i][0] = inReal[i];
		this->in[i][1] = inImag[i];
	}
	fftw_execute(this->backward_out_of_place_plan);
	for(size_t i = 0; i < this->n; i++) {
		outReal[i] = this->out[i][0] * scale;
		outImag[i] = this->out[i][1] * scale;
	}
#endif // SAPF_ACCELERATE
}

void FFT::forward_in_place(double *ioReal, double *ioImag) {
	double scale = 2. / this->n;
#ifdef SAPF_ACCELERATE
	DSPDoubleSplitComplex io;
	
	io.realp = ioReal;
	io.imagp = ioImag;

	vDSP_fft_zipD(this->setup, &io, 1, this->log2n, FFT_FORWARD);

	vDSP_vsmulD(ioReal, 1, &scale, ioReal, 1, this->n);
	vDSP_vsmulD(ioImag, 1, &scale, ioImag, 1, this->n);
#else
	for(size_t i = 0; i < this->n; i++) {
		this->in[i][0] = ioReal[i];
		this->in[i][1] = ioImag[i];
	}
	fftw_execute(this->forward_in_place_plan);
	for(size_t i = 0; i < this->n; i++) {
		ioReal[i] = this->in[i][0] * scale;
		ioImag[i] = this->in[i][1] * scale;
	}
#endif // SAPF_ACCELERATE
}

void FFT::backward_in_place(double *ioReal, double *ioImag) {
	double scale = .5;
#ifdef SAPF_ACCELERATE
	DSPDoubleSplitComplex io;
	
	io.realp = ioReal;
	io.imagp = ioImag;

	vDSP_fft_zipD(this->setup, &io, 1, this->log2n, FFT_INVERSE);

	vDSP_vsmulD(ioReal, 1, &scale, ioReal, 1, this->n);
	vDSP_vsmulD(ioImag, 1, &scale, ioImag, 1, this->n);
#else
	for(size_t i = 0; i < this->n; i++) {
		this->in[i][0] = ioReal[i];
		this->in[i][1] = ioImag[i];
	}
	fftw_execute(this->backward_in_place_plan);
	for(size_t i = 0; i < this->n; i++) {
		ioReal[i] = this->in[i][0] * scale;
		ioImag[i] = this->in[i][1] * scale;
	}
#endif // SAPF_ACCELERATE
}

void FFT::forward_real(double *inReal, double *outReal, double *outImag) {
	double scale = 2. / n;
	int n2 = this->n/2;
#ifdef SAPF_ACCELERATE
	DSPDoubleSplitComplex in;
	DSPDoubleSplitComplex out;

	vDSP_ctozD((DSPDoubleComplex*)inReal, 1, &in, 1, n2);
	
	out.realp = outReal;
	out.imagp = outImag;

	vDSP_fft_zropD(this->setup, &in, 1, &out, 1, this->log2n, FFT_FORWARD);

	vDSP_vsmulD(outReal, 1, &scale, outReal, 1, n2);
	vDSP_vsmulD(outImag, 1, &scale, outImag, 1, n2);
    
	out.realp[n2] = out.imagp[0];
	out.imagp[0] = 0.;
	out.imagp[n2] = 0.;
#else
	for(size_t i = 0; i < this->n; i++) {
		this->in_out_real[i] = inReal[i];
	}
	fftw_execute(this->forward_real_plan);
	for(size_t i = 0; i < n2; i++) {
		outReal[i] = this->in_out_real[2*i] * scale;
		outImag[i] = this->in_out_real[2*i+1] * scale;
	}
#endif // SAPF_ACCELERATE
}

void FFT::backward_real(double *inReal, double *inImag, double *outReal) {
	double scale = .5;
	int n2 = this->n/2;
#ifdef SAPF_ACCELERATE
	DSPDoubleSplitComplex in;
	
	in.realp = inReal;
	in.imagp = inImag;
	
	//in.imagp[0] = in.realp[n2];
	in.imagp[0] = 0.;

	vDSP_fft_zripD(this->setup, &in, 1, this->log2n, FFT_INVERSE);

	vDSP_ztocD(&in, 1, (DSPDoubleComplex*)outReal, 2, n2);

	vDSP_vsmulD(outReal, 1, &scale, outReal, 1, n);    
#else
	for(size_t i = 0; i < n2; i++) {
		this->in_out_real[2*i] = inReal[i];
		this->in_out_real[2*i+1] = inImag[i];
	}
	fftw_execute(this->backward_real_plan);
	for(size_t i = 0; i < this->n; i++) {
		outReal[i] = this->in_out_real[i] * scale;
	}
#endif // SAPF_ACCELERATE
}

FFT ffts[kMaxFFTLogSize+1];



void initFFT()
{
	for (int i = kMinFFTLogSize; i <= kMaxFFTLogSize; ++i) {
                ffts[i].init(i);
	}
}

void post(const char* fmt, ...);

// only sizes kMinFFTLogSize..kMaxFFTLogSize have plans; anything else would index past ffts[]
static FFT& fftForSize(int n)
{
	int log2n = n == 0 ? 0 : 64 - __builtin_clzll(n - 1);
	if (log2n < kMinFFTLogSize || log2n > kMaxFFTLogSize) {
		post("fft : size %d is out of range (%d to %d).\n", n, 1 << kMinFFTLogSize, 1 << kMaxFFTLogSize);
		throw errFailed;
	}
	return ffts[log2n];
}

void fft(int n, double* inReal, double* inImag, double* outReal, double* outImag)
{
	fftForSize(n).forward(inReal, inImag, outReal, outImag);
}

void ifft(int n, double* inReal, double* inImag, double* outReal, double* outImag)
{
	fftForSize(n).backward(inReal, inImag, outReal, outImag);
}

void fft(int n, double* ioReal, double* ioImag)
{
	fftForSize(n).forward_in_place(ioReal, ioImag);
}

void ifft(int n, double* ioReal, double* ioImag)
{
	fftForSize(n).backward_in_place(ioReal, ioImag);
}


void rfft(int n, double* inReal, double* outReal, double* outImag)
{
	fftForSize(n).forward_real(inReal, outReal, outImag);
}


void rifft(int n, double* inReal, double* inImag, double* outReal)
{
	fftForSize(n).backward_real(inReal, inImag, outReal);
}


#define USE_VFORCE 1

inline void complex_expD_conj(double& re, double& im)
{
	double rho = expf(re);
	re = rho * cosf(im);
	im = rho * sinf(im);
}

