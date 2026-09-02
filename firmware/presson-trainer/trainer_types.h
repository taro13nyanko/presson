/* Small types used by presson-trainer.ino.  They live in a header because the
 * Arduino builder inserts its auto-generated function prototypes above any
 * struct defined in the .ino, and a prototype such as
 * `void playSeq(const Note *, int)` must already know the type. */
#pragma once
#include <stdint.h>

struct Note { uint16_t f; uint16_t ms; };           // buzzer sequencer step (f = 0 -> rest)
struct DemoSeg { float rate, depth, seconds; bool pause; };
