# ═══════════════════════════════════════════════════════════════════════
# Makefile — Build the libdseffect.so evidence harness for QEMU.
#
# Cross-compiles ddp_probe (ARMv7-A) and a noisy liblog override.
# Reuses the same toolchain and library staging as arm/.
#
# Prerequisites:
#   apt install gcc-arm-linux-gnueabihf qemu-user-static
#   The harness loads libdseffect.so from arm/build/lib/, so run
#   `make -C ../../arm` first (or any equivalent that produces
#   ../../arm/build/lib/libdseffect.so and the other stub libs).
#
# Usage:
#   make           — build the probe binary and the noisy liblog
#   make run       — build then run under qemu-arm-static; stdout is
#                    the test summary, stderr is the engine's own log
#   make run-log   — like run but redirects engine log to engine.log
#   make dump      — print every param's intrinsic power-on default
#   make clean
# ═══════════════════════════════════════════════════════════════════════

CC      = arm-linux-gnueabihf-gcc
CFLAGS  = -O0 -Wall -Wno-misleading-indentation -g \
          -march=armv7-a -mfpu=neon -mfloat-abi=hard

ARMDIR  = $(abspath ../../arm)
ARMHDR  = $(ARMDIR)/audio_effect_defs.h
ARMLIB  = $(ARMDIR)/build/lib

BUILDDIR = build
LIBDIR   = $(BUILDDIR)/lib

PROBE    = $(BUILDDIR)/ddp_probe
LIBLOG   = $(LIBDIR)/liblog.so

# All other arm libs come from arm/build/lib/ unchanged. We just
# override liblog.so with our noisy version.
STAGED_LIBS = libdseffect.so libc.so libcutils.so libdl.so libm.so \
              libstdc++.so libutils.so

.PHONY: all run run-log dump clean

all: $(PROBE) $(LIBLOG) $(addprefix $(LIBDIR)/,$(STAGED_LIBS))

$(PROBE): ddp_probe.c $(ARMHDR) | $(BUILDDIR)
	$(CC) $(CFLAGS) -I$(ARMDIR) -o $@ $< -ldl -lm

$(LIBLOG): liblog_stub.c | $(LIBDIR)
	$(CC) $(CFLAGS) -shared -fPIC -o $@ $<

$(LIBDIR)/%.so: $(ARMLIB)/%.so | $(LIBDIR)
	cp $< $@

$(BUILDDIR):
	mkdir -p $(BUILDDIR)

$(LIBDIR):
	mkdir -p $(LIBDIR)

run: all
	@echo "Running ddp_probe — stdout is the summary, stderr is the engine log."
	@LD_LIBRARY_PATH=$(LIBDIR) qemu-arm-static -L /usr/arm-linux-gnueabihf \
	  $(PROBE) $(LIBDIR)/libdseffect.so

run-log: all
	@echo "Running ddp_probe — engine log → engine.log"
	@LD_LIBRARY_PATH=$(LIBDIR) qemu-arm-static -L /usr/arm-linux-gnueabihf \
	  $(PROBE) $(LIBDIR)/libdseffect.so 2>engine.log

dump: all
	@DUMP_DEFAULTS=1 LD_LIBRARY_PATH=$(LIBDIR) qemu-arm-static -L /usr/arm-linux-gnueabihf \
	  $(PROBE) $(LIBDIR)/libdseffect.so 2>/dev/null

clean:
	rm -rf $(BUILDDIR) engine.log
