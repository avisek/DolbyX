# ═══════════════════════════════════════════════════════════════════════
# Makefile — Build the libdseffect.so evidence harness for QEMU.
#
# Standalone: cross-compiles the probes (ARMv7-A) and every Android stub
# lib, stages the vendored libdseffect.so, and symlinks the libc family
# from the ARM Linux sysroot — no other build required.
#
# Prerequisites:
#   apt install gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf \
#               qemu-user-static
#   libdseffect.so comes from ../../vendored/.
#
# Usage:
#   make           — build the probe binaries and the staged libs
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
#   make vis       — run the native-vs-custom visualizer experiment (vis_native_probe):
#                    prove vc* is the native vn* data resampled onto a host-set band grid,
#                    and that the native grid (vnnb/vnbf) is itself rate-derived (sec C)
#   make dump-tree     — branch-drawn AK tree: full per-param metadata + descriptions
#   make dump-defaults — print each root param's power-on default (4-CC = value)
#   make dump-types    — root leaves as a flat table + write-protection probe
#   make dump-docs     — every def's name · description · long help (rule-divided)
#   make clean
# ═══════════════════════════════════════════════════════════════════════

CC       = arm-linux-gnueabihf-gcc
CXX      = arm-linux-gnueabihf-g++
CFLAGS   = -O0 -Wall -Wno-misleading-indentation -g \
           -march=armv7-a -mfpu=neon -mfloat-abi=hard
CXXFLAGS = $(CFLAGS) -fno-exceptions -fno-rtti

VENDORED = $(abspath ../../vendored)
SYSROOT  = /usr/arm-linux-gnueabihf/lib

BUILDDIR = build
LIBDIR   = $(BUILDDIR)/lib

PROBE    = $(BUILDDIR)/ddp_probe
AKCTL    = $(BUILDDIR)/akctl_probe
SETCFG   = $(BUILDDIR)/setconfig_probe
RESHAPE  = $(BUILDDIR)/reshape_probe
VIS      = $(BUILDDIR)/vis_native_probe
PROBES   = $(PROBE) $(AKCTL) $(SETCFG) $(RESHAPE) $(VIS)

# Staged alongside the engine: the noisy liblog override (root) plus the
# silent Android stubs (stubs/), plus sysroot symlinks for the libc family.
STUB_LIBS    = liblog.so libutils.so libcutils.so
SYSROOT_LIBS = libc.so libdl.so libm.so libstdc++.so
STAGED       = $(LIBDIR)/libdseffect.so \
               $(addprefix $(LIBDIR)/,$(STUB_LIBS) $(SYSROOT_LIBS))

.PHONY: all run run-log akctl setconfig reshape vis dump-tree dump-defaults dump-types dump-docs clean

all: $(PROBES) $(STAGED)

$(PROBES): $(BUILDDIR)/%: %.c audio_effect_defs.h | $(BUILDDIR)
	$(CC) $(CFLAGS) -o $@ $< -ldl -lm

$(LIBDIR)/liblog.so: liblog_stub.c | $(LIBDIR)
	$(CC) $(CFLAGS) -shared -fPIC -o $@ $<

$(LIBDIR)/libutils.so: stubs/libutils_stub.cpp | $(LIBDIR)
	$(CXX) $(CXXFLAGS) -shared -fPIC -o $@ $<

$(LIBDIR)/libcutils.so: stubs/libcutils_stub.c | $(LIBDIR)
	$(CC) $(CFLAGS) -shared -fPIC -o $@ $<

$(LIBDIR)/libdseffect.so: $(VENDORED)/libdseffect.so | $(LIBDIR)
	cp $< $@

# Android soname → ARM Linux sysroot symlinks
$(addprefix $(LIBDIR)/,$(SYSROOT_LIBS)): $(LIBDIR)/%.so: | $(LIBDIR)
	ln -sf "$$(find $(SYSROOT) -name '$*.so.*' -not -name '*.py' | head -1)" $@

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

vis: all
	@echo "Running vis_native_probe — stdout is the summary, stderr is the engine log."
	@LD_LIBRARY_PATH=$(LIBDIR) qemu-arm-static -L /usr/arm-linux-gnueabihf \
	  $(VIS) $(LIBDIR)/libdseffect.so

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
