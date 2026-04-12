# ═══════════════════════════════════════════════════════════════════════
# Makefile — Cross-compile DDP processor for ARM (runs under QEMU)
#
# Prerequisites (install in WSL2 Ubuntu):
#   sudo apt update
#   sudo apt install gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf \
#                    qemu-user-static
#
# Usage:
#   make          — build everything
#   make test     — quick smoke test
#   make clean    — remove build artifacts
# ═══════════════════════════════════════════════════════════════════════

CC     = arm-linux-gnueabihf-gcc
CXX    = arm-linux-gnueabihf-g++
CFLAGS = -O2 -Wall -march=armv7-a -mfpu=neon -mfloat-abi=hard
CXXFLAGS = $(CFLAGS) -fno-exceptions -fno-rtti

BUILDDIR = build
LIBDIR   = $(BUILDDIR)/lib

# Where the original libdseffect.so is placed
ORIG_LIB = lib/libdseffect.so

.PHONY: all clean test install

all: $(BUILDDIR)/ddp_processor $(LIBDIR)/liblog.so $(LIBDIR)/libutils.so \
     $(LIBDIR)/libcutils.so $(LIBDIR)/libdseffect.so

# ── Main processor ────────────────────────────────────────────────────

$(BUILDDIR)/ddp_processor: ddp_processor.c audio_effect_defs.h | $(BUILDDIR)
	$(CC) $(CFLAGS) -o $@ $< -ldl -lm

# ── Stub libraries ───────────────────────────────────────────────────

$(LIBDIR)/liblog.so: stubs/liblog_stub.c | $(LIBDIR)
	$(CC) $(CFLAGS) -shared -fPIC -o $@ $<

$(LIBDIR)/libutils.so: stubs/libutils_stub.cpp | $(LIBDIR)
	$(CXX) $(CXXFLAGS) -shared -fPIC -o $@ $<

$(LIBDIR)/libcutils.so: stubs/libcutils_stub.c | $(LIBDIR)
	$(CC) $(CFLAGS) -shared -fPIC -o $@ $<

# ── Copy original library ────────────────────────────────────────────

$(LIBDIR)/libdseffect.so: $(ORIG_LIB) | $(LIBDIR)
	cp $< $@
	@# Create symlinks for Android soname → Linux soname
	ln -sf $$(find /usr/arm-linux-gnueabihf/lib -name 'libdl.so.*' | head -1) $(LIBDIR)/libdl.so 2>/dev/null || true
	ln -sf $$(find /usr/arm-linux-gnueabihf/lib -name 'libc.so.*' | head -1) $(LIBDIR)/libc.so 2>/dev/null || true
	ln -sf $$(find /usr/arm-linux-gnueabihf/lib -name 'libm.so.*' | head -1) $(LIBDIR)/libm.so 2>/dev/null || true
	ln -sf $$(find /usr/arm-linux-gnueabihf/lib -name 'libstdc++.so.*' -not -name '*.py' | head -1) $(LIBDIR)/libstdc++.so 2>/dev/null || true

# ── Extra Android system libs that the linker might look for ─────────
# libdseffect.so also NEEDS libdl, libc, libstdc++, libm — but those
# are provided by the ARM Linux sysroot (/usr/arm-linux-gnueabihf/lib/)

# ── Directories ──────────────────────────────────────────────────────

$(BUILDDIR):
	mkdir -p $(BUILDDIR)

$(LIBDIR):
	mkdir -p $(LIBDIR)

# ── Test ──────────────────────────────────────────────────────────────

test: all
	@echo "=== Smoke test: checking if QEMU can load the processor ==="
	LD_LIBRARY_PATH=$(LIBDIR) \
	  qemu-arm-static -L /usr/arm-linux-gnueabihf \
	  $(BUILDDIR)/ddp_processor $(LIBDIR)/libdseffect.so < /dev/null 2>&1 \
	  | head -20 || true
	@echo "=== If you saw 'Effect created successfully', it works! ==="

# ── Clean ─────────────────────────────────────────────────────────────

clean:
	rm -rf $(BUILDDIR)

# ── Install (copy DDP config alongside binary) ───────────────────────

install: all
	@echo "Build complete. Files in $(BUILDDIR)/"
	@echo ""
	@echo "To run manually:"
	@echo "  LD_LIBRARY_PATH=$(LIBDIR) qemu-arm-static -L /usr/arm-linux-gnueabihf \\"
	@echo "    $(BUILDDIR)/ddp_processor $(LIBDIR)/libdseffect.so"
