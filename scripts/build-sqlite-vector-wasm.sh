#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/edgeproc-sqlite-vector.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM

SQLITE_URL=https://www.sqlite.org/2026/sqlite-src-3530400.zip
SQLITE_SHA3=b834d474b9b393d85a9e3ee4cc11f1329e007e9376a424ee740796f5c4bda3a8
VECTOR_COMMIT=0c2223ada9dce1fa33248c8835a15f51d9a0f655
EMSDK_IMAGE=emscripten/emsdk@sha256:27bc6267cb285223b8aebb7627bfebae7cb3ad2aaa0d5923b8aa5321793033e8
JS_SHA256=b96e0c4faa11f7220e4916788208302944bd995ba79d01c9f2ba726280b0fbc3
WASM_SHA256=a847545f7c58e1bdf9074cda354cfbd992c7edadf67cf4011e76297317c2565a
OPFS_PROXY_SHA256=0afe66f23424456c0eb1de5f599075fd676d869044a017a1058888007e2dbf92
# After the local patch set (src/vector/sqlite/assets/README.md, "Local patches").
PATCHED_JS_SHA256=9386833bbe0c3d723e1f2d25721917c790cfce4d01770c605c59ff2eb7b6d7b2
PATCHED_OPFS_PROXY_SHA256=e9a55a030682ca706c7ada8cb521718c6730a2637c6f1a8b63a677a635e035f7

curl --fail --location --silent --show-error "$SQLITE_URL" \
	--output "$WORK/sqlite-src.zip"
ACTUAL_SQLITE_SHA3=$(openssl dgst -sha3-256 "$WORK/sqlite-src.zip" | awk '{print $NF}')
test "$ACTUAL_SQLITE_SHA3" = "$SQLITE_SHA3"
unzip -q "$WORK/sqlite-src.zip" -d "$WORK"

git clone --quiet https://github.com/sqliteai/sqlite-vector.git "$WORK/sqlite-vector"
git -C "$WORK/sqlite-vector" checkout --quiet "$VECTOR_COMMIT"
test "$(git -C "$WORK/sqlite-vector" rev-parse HEAD)" = "$VECTOR_COMMIT"

cat > "$WORK/sqlite-src-3530400/ext/wasm/sqlite3_vector_wasm_init.c" <<'EOF'
#include "sqlite3.h"
#include "sqlite-vector.h"

int sqlite3_wasm_extra_init(const char *unused) {
  (void)unused;
  return sqlite3_auto_extension((void (*)(void))sqlite3_vector_init);
}
EOF

docker run --rm --platform linux/amd64 \
	-v "$WORK:/work" \
	"$EMSDK_IMAGE" \
	sh -ec '
		apt-get update
		apt-get install -y --no-install-recommends wabt=1.0.27-1
		rm -rf /var/lib/apt/lists/*
		cd /work/sqlite-src-3530400
		./configure --with-emsdk=/emsdk --disable-tcl
		make -j2 sqlite3.c
		cd ext/wasm
		make clean
		make -j2 emcc_opt=-Oz \
			"sqlite3_wasm_extra_init.c=sqlite3_vector_wasm_init.c /work/sqlite-vector/src/sqlite-vector.c /work/sqlite-vector/src/distance-cpu.c" \
			"cflags.wasm_extra_init=-DSQLITE_WASM_EXTRA_INIT -DSQLITE_CORE -include strings.h -I/work/sqlite-vector/src -I/work/sqlite-vector/libs" \
			b-bundler
	'

OUT=$WORK/sqlite-src-3530400/ext/wasm/jswasm
test "$(openssl dgst -sha256 "$OUT/sqlite3-bundler-friendly.mjs" | awk '{print $NF}')" = "$JS_SHA256"
test "$(openssl dgst -sha256 "$OUT/sqlite3.wasm" | awk '{print $NF}')" = "$WASM_SHA256"
test "$(openssl dgst -sha256 "$OUT/sqlite3-opfs-async-proxy.js" | awk '{print $NF}')" = "$OPFS_PROXY_SHA256"

install -m 0644 "$OUT/sqlite3-bundler-friendly.mjs" \
	"$ROOT/src/vector/sqlite/assets/sqlite3.mjs"
install -m 0644 "$OUT/sqlite3.wasm" \
	"$ROOT/src/vector/sqlite/assets/sqlite3.wasm"
install -m 0644 "$OUT/sqlite3-opfs-async-proxy.js" \
	"$ROOT/src/vector/sqlite/assets/sqlite3-opfs-async-proxy.js"

# Local patches: the OPFS async proxy is spawned inline (no network fetch) and
# the installer's zombie timer guards only the Worker load, not OPFS init
# (0001); the opfs-sahpool VFS reports RESERVED locks truthfully so a hot
# journal is rolled back after a crash (0002, upstream check-in ea1d55e202e6e).
for patch in "$ROOT"/scripts/sqlite-wasm-patches/*.patch; do
	git -C "$ROOT" apply --whitespace=nowarn "$patch"
done
test "$(openssl dgst -sha256 "$ROOT/src/vector/sqlite/assets/sqlite3.mjs" | awk '{print $NF}')" = "$PATCHED_JS_SHA256"
test "$(openssl dgst -sha256 "$ROOT/src/vector/sqlite/assets/sqlite3-opfs-async-proxy.js" | awk '{print $NF}')" = "$PATCHED_OPFS_PROXY_SHA256"
node "$ROOT/scripts/generate-opfs-proxy-source.mjs"

echo "Rebuilt the pinned SQLite + sqlite-vector browser runtime."
