/*
 * libutils_stub.cpp — ABI-compatible stubs for android::String8,
 * android::VectorImpl, and android::SortedVectorImpl.
 *
 * Must match AOSP 4.4–5.0 memory layout exactly. These classes are
 * only used during initialization and parameter management, not in the
 * real-time audio path.
 *
 * Compile: arm-linux-gnueabihf-g++ -shared -fPIC -o libutils.so libutils_stub.cpp
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/*
 * ══════════════════════════════════════════════════════════════════════
 *  SharedBuffer — AOSP-compatible reference-counted buffer
 *
 *  Memory layout:
 *    [4 bytes mRefs] [4 bytes mSize] [... data ...]
 *                                     ^ pointer returned to user
 * ══════════════════════════════════════════════════════════════════════
 */

struct SharedBuffer {
    int32_t  mRefs;
    uint32_t mSize;

    static SharedBuffer* alloc(uint32_t size) {
        SharedBuffer* sb = (SharedBuffer*)malloc(sizeof(SharedBuffer) + size);
        if (sb) {
            sb->mRefs = 1;
            sb->mSize = size;
            memset(sb + 1, 0, size);
        }
        return sb;
    }

    const void* data() const { return this + 1; }
    void* data() { return this + 1; }

    uint32_t size() const { return mSize; }

    SharedBuffer* editResize(uint32_t newSize) {
        SharedBuffer* sb = (SharedBuffer*)realloc(this, sizeof(SharedBuffer) + newSize);
        if (sb) sb->mSize = newSize;
        return sb;
    }

    void release() {
        if (--mRefs <= 0) free(this);
    }

    static SharedBuffer* bufferFromData(void* data) {
        return ((SharedBuffer*)data) - 1;
    }

    static const SharedBuffer* bufferFromData(const void* data) {
        return ((const SharedBuffer*)data) - 1;
    }
};


/*
 * ══════════════════════════════════════════════════════════════════════
 *  android::String8 — Simple string class
 *
 *  Memory layout (ARM32):
 *    offset 0: const char* mString   (4 bytes)
 *    total: 4 bytes
 *
 *  No vtable (no virtual methods).
 * ══════════════════════════════════════════════════════════════════════
 */

namespace android {

static const char* kEmptyString = "";

class String8 {
public:
    const char* mString;
    String8();
    String8(const char* s);
    String8(const String8& other);
    ~String8();
};

/* Out-of-line definitions — forces symbol emission */
String8::String8() : mString(kEmptyString) {}

String8::String8(const char* s) {
    if (s && *s) {
        size_t len = strlen(s);
        char* buf = (char*)malloc(len + 1);
        memcpy(buf, s, len + 1);
        mString = buf;
    } else {
        mString = kEmptyString;
    }
}

String8::String8(const String8& other) {
    if (other.mString && other.mString != kEmptyString) {
        size_t len = strlen(other.mString);
        char* buf = (char*)malloc(len + 1);
        memcpy(buf, other.mString, len + 1);
        mString = buf;
    } else {
        mString = kEmptyString;
    }
}

String8::~String8() {
    if (mString && mString != kEmptyString) {
        free((void*)mString);
    }
    mString = NULL;
}


/*
 * ══════════════════════════════════════════════════════════════════════
 *  android::VectorImpl — Dynamic array base class
 *
 *  Memory layout (ARM32):
 *    offset 0:  vtable*       (4 bytes, implicit from virtual methods)
 *    offset 4:  void* mStorage (4 bytes) — points past SharedBuffer header
 *    offset 8:  uint32_t mCount (4 bytes)
 *    offset 12: uint32_t mFlags (4 bytes)
 *    offset 16: uint32_t mItemSize (4 bytes)
 *    total: 20 bytes
 * ══════════════════════════════════════════════════════════════════════
 */

class VectorImpl {
public:
    /* Virtual methods — must match AOSP vtable order exactly */
    virtual             ~VectorImpl();
    virtual void        do_construct(void* storage, size_t num) const;
    virtual void        do_destroy(void* storage, size_t num) const;
    virtual void        do_copy(void* dest, const void* from, size_t num) const;
    virtual void        do_splat(void* dest, const void* item, size_t num) const;
    virtual void        do_move_forward(void* dest, const void* from, size_t num) const;
    virtual void        do_move_backward(void* dest, const void* from, size_t num) const;

    void clear();
    void finish_vector();

protected:
    VectorImpl(size_t itemSize, uint32_t flags);

    void*    _grow(size_t where, size_t amount);
    void     _shrink(size_t where, size_t amount);
    size_t   itemSize() const { return mItemSize; }
    void*    editItemLocation(size_t index);
    const void* itemLocation(size_t index) const;

    /* Fields — order and size must match exactly */
    void*       mStorage;       /* offset 4 */
    uint32_t    mCount;         /* offset 8 */
    const uint32_t mFlags;      /* offset 12 */
    const uint32_t mItemSize;   /* offset 16 */

private:
    void _do_construct(void* storage, size_t num) const;
    void _do_destroy(void* storage, size_t num) const;
    void _do_copy(void* dest, const void* from, size_t num) const;
    void _do_move_forward(void* dest, const void* from, size_t num) const;
    void _do_move_backward(void* dest, const void* from, size_t num) const;
};

/*
 * VectorImpl implementation
 */

VectorImpl::VectorImpl(size_t itemSize, uint32_t flags)
    : mStorage(NULL), mCount(0), mFlags(flags), mItemSize(itemSize)
{
}

VectorImpl::~VectorImpl() {
    finish_vector();
}

void VectorImpl::finish_vector() {
    if (mStorage) {
        if (mCount > 0) {
            do_destroy(mStorage, mCount);
        }
        SharedBuffer::bufferFromData(mStorage)->release();
        mStorage = NULL;
        mCount = 0;
    }
}

void VectorImpl::clear() {
    if (mStorage) {
        if (mCount > 0) {
            do_destroy(mStorage, mCount);
        }
        SharedBuffer::bufferFromData(mStorage)->release();
        mStorage = NULL;
        mCount = 0;
    }
}

void* VectorImpl::editItemLocation(size_t index) {
    return (uint8_t*)mStorage + index * mItemSize;
}

const void* VectorImpl::itemLocation(size_t index) const {
    return (const uint8_t*)mStorage + index * mItemSize;
}

void* VectorImpl::_grow(size_t where, size_t amount) {
    size_t new_count = mCount + amount;
    size_t new_size = new_count * mItemSize;

    if (!mStorage) {
        SharedBuffer* sb = SharedBuffer::alloc(new_size);
        mStorage = sb->data();
        mCount = new_count;
        return (uint8_t*)mStorage + where * mItemSize;
    }

    SharedBuffer* sb = SharedBuffer::bufferFromData(mStorage);
    sb = sb->editResize(new_size);
    mStorage = sb->data();

    /* Move items after 'where' to make room */
    if (where < mCount) {
        void* dest = (uint8_t*)mStorage + (where + amount) * mItemSize;
        const void* src = (uint8_t*)mStorage + where * mItemSize;
        do_move_forward(dest, src, mCount - where);
    }

    mCount = new_count;
    return (uint8_t*)mStorage + where * mItemSize;
}

void VectorImpl::_shrink(size_t where, size_t amount) {
    if (where + amount < mCount) {
        void* dest = (uint8_t*)mStorage + where * mItemSize;
        const void* src = (uint8_t*)mStorage + (where + amount) * mItemSize;
        do_move_backward(dest, src, mCount - where - amount);
    }
    mCount -= amount;
}

/* Default virtual method implementations (trivial / memcpy-based) */
void VectorImpl::do_construct(void* storage, size_t num) const {
    memset(storage, 0, num * mItemSize);
}

void VectorImpl::do_destroy(void* storage, size_t num) const {
    (void)storage; (void)num; /* trivial types: nothing to do */
}

void VectorImpl::do_copy(void* dest, const void* from, size_t num) const {
    memcpy(dest, from, num * mItemSize);
}

void VectorImpl::do_splat(void* dest, const void* item, size_t num) const {
    for (size_t i = 0; i < num; i++) {
        memcpy((uint8_t*)dest + i * mItemSize, item, mItemSize);
    }
}

void VectorImpl::do_move_forward(void* dest, const void* from, size_t num) const {
    memmove(dest, from, num * mItemSize);
}

void VectorImpl::do_move_backward(void* dest, const void* from, size_t num) const {
    memmove(dest, from, num * mItemSize);
}


/*
 * ══════════════════════════════════════════════════════════════════════
 *  android::SortedVectorImpl — Sorted dynamic array
 *
 *  Inherits VectorImpl, adds pure virtual do_compare.
 *  No additional data fields.
 *
 *  Memory layout: same as VectorImpl (20 bytes on ARM32)
 * ══════════════════════════════════════════════════════════════════════
 */

class SortedVectorImpl : public VectorImpl {
public:
    SortedVectorImpl(size_t itemSize, uint32_t flags);
    virtual ~SortedVectorImpl();

    ssize_t add(const void* item);
    ssize_t indexOf(const void* item) const;

    virtual int do_compare(const void* lhs, const void* rhs) const = 0;

private:
    ssize_t _indexOrderOf(const void* item, size_t* order) const;
};

SortedVectorImpl::SortedVectorImpl(size_t itemSize, uint32_t flags)
    : VectorImpl(itemSize, flags)
{
}

SortedVectorImpl::~SortedVectorImpl() {
}

ssize_t SortedVectorImpl::_indexOrderOf(const void* item, size_t* order) const {
    /* Binary search */
    ssize_t lo = 0;
    ssize_t hi = (ssize_t)mCount - 1;
    ssize_t mid = -1;
    int cmp = -1;

    while (lo <= hi) {
        mid = (lo + hi) / 2;
        cmp = do_compare(itemLocation(mid), item);
        if (cmp < 0) {
            lo = mid + 1;
        } else if (cmp > 0) {
            hi = mid - 1;
        } else {
            if (order) *order = (size_t)mid;
            return mid;
        }
    }

    if (order) {
        *order = (cmp > 0) ? (size_t)mid : (size_t)(mid + 1);
    }
    return -1; /* not found */
}

ssize_t SortedVectorImpl::add(const void* item) {
    size_t order;
    _indexOrderOf(item, &order);

    void* where = _grow(order, 1);
    if (where) {
        do_copy(where, item, 1);
    }
    return (ssize_t)order;
}

ssize_t SortedVectorImpl::indexOf(const void* item) const {
    return _indexOrderOf(item, NULL);
}

} /* namespace android */
