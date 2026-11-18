/*
 *
 * $Source: x:/prj/tech/libsrc/timer/RCS/tmdecl.h $
 * $Revision: 1.5 $
 * $Author
 * $Date: 1997/06/18 02:13:25 $
 *
 * External declarations for timer functions.
 *
 * This file is part of the timer library.
 */

#include <fix.h>

typedef void (*pfv)();

extern volatile long tm_millisec;
extern volatile fix tm_fix;

#if !defined(_WIN32) && !defined(__linux__) && !defined(__EMSCRIPTEN__)
#define tm_get_millisec() (tm_millisec)
#define tm_get_millisec_unrecorded() (tm_millisec)
#define tm_get_fix() (tm_fix)
#else
EXTERN long LGAPI tm_get_millisec(void);
EXTERN long LGAPI tm_get_millisec_unrecorded(void);
EXTERN fix LGAPI tm_get_fix(void);
#endif

extern int tm_init_realtime (unsigned long rt_freq_in, unsigned long spec_freq, pfv fn);
extern long tm_get_rt_freq ();
extern int tm_add_process (pfv prot_func, int real_func, long denom);
