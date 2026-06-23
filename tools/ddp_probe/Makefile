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
#   make akctl     — run the AK-direct experiment (akctl_probe): drive the
#                    engine via ak_set/ak_get, skipping the cmd param path
#   make setconfig — run the EFFECT_CMD_SET_CONFIG experiment (setconfig_probe):
#                    send cmd 1 to change sample rate / channels at runtime
#   make reshape   — run the structural-constant experiment (reshape_probe): prove
#                    genb/gebf reshape the GEQ live via the gebg commit, and that
#                    among the commit writes order is free (commit presence, not order)
#   make dump-tree     — branch-drawn AK tree: full per-param metadata + descriptions
#   make dump-defaults — print each root param's power-on default (4-CC = value)
#   make dump-types    — root leaves as a flat table + write-protection probe
#   make dump-docs     — every def's name · description · long help (rule-divided)
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
AKCTL    = $(BUILDDIR)/akctl_probe
SETCFG   = $(BUILDDIR)/setconfig_probe
RESHAPE  = $(BUILDDIR)/reshape_probe
LIBLOG   = $(LIBDIR)/liblog.so

# All other arm libs come from arm/build/lib/ unchanged. We just
# override liblog.so with our noisy version.
STAGED_LIBS = libdseffect.so libc.so libcutils.so libdl.so libm.so \
              libstdc++.so libutils.so

.PHONY: all run run-log akctl setconfig reshape dump-tree dump-defaults dump-types dump-docs clean

all: $(PROBE) $(AKCTL) $(SETCFG) $(RESHAPE) $(LIBLOG) $(addprefix $(LIBDIR)/,$(STAGED_LIBS))

$(PROBE): ddp_probe.c $(ARMHDR) | $(BUILDDIR)
	$(CC) $(CFLAGS) -I$(ARMDIR) -o $@ $< -ldl -lm

$(AKCTL): akctl_probe.c $(ARMHDR) | $(BUILDDIR)
	$(CC) $(CFLAGS) -I$(ARMDIR) -o $@ $< -ldl -lm

$(SETCFG): setconfig_probe.c $(ARMHDR) | $(BUILDDIR)
	$(CC) $(CFLAGS) -I$(ARMDIR) -o $@ $< -ldl -lm

$(RESHAPE): reshape_probe.c $(ARMHDR) | $(BUILDDIR)
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

akctl: all
	@echo "Running akctl_probe — stdout is the summary, stderr is the engine log."
	@LD_LIBRARY_PATH=$(LIBDIR) qemu-arm-static -L /usr/arm-linux-gnueabihf \
	  $(AKCTL) $(LIBDIR)/libdseffect.so

setconfig: all
	@echo "Running setconfig_probe — stdout is the summary, stderr is the engine log."
	@LD_LIBRARY_PATH=$(LIBDIR) qemu-arm-static -L /usr/arm-linux-gnueabihf \
	  $(SETCFG) $(LIBDIR)/libdseffect.so

reshape: all
	@echo "Running reshape_probe — stdout is the summary, stderr is the engine log."
	@LD_LIBRARY_PATH=$(LIBDIR) qemu-arm-static -L /usr/arm-linux-gnueabihf \
	  $(RESHAPE) $(LIBDIR)/libdseffect.so

dump-tree: all
	@LD_LIBRARY_PATH=$(LIBDIR) qemu-arm-static -L /usr/arm-linux-gnueabihf \
	  $(PROBE) $(LIBDIR)/libdseffect.so dump tree 2>/dev/null

dump-defaults: all
	@LD_LIBRARY_PATH=$(LIBDIR) qemu-arm-static -L /usr/arm-linux-gnueabihf \
	  $(PROBE) $(LIBDIR)/libdseffect.so dump defaults 2>/dev/null

dump-types: all
	@LD_LIBRARY_PATH=$(LIBDIR) qemu-arm-static -L /usr/arm-linux-gnueabihf \
	  $(PROBE) $(LIBDIR)/libdseffect.so dump types 2>/dev/null

dump-docs: all
	@LD_LIBRARY_PATH=$(LIBDIR) qemu-arm-static -L /usr/arm-linux-gnueabihf \
	  $(PROBE) $(LIBDIR)/libdseffect.so dump docs 2>/dev/null

clean:
	rm -rf $(BUILDDIR) engine.log
