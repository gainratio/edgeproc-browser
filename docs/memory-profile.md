# SQLite memory profile

**TL;DR:** keep big indexes in persistent SQLite on OPFS and let SQLite's own page cache and
heap limits keep memory small. `memoryProfile` picks the numbers for you: `"full"`,
`"lite"`, `"minimal"`, or `"auto"` (the default).

**Why:** an in-memory SQLite index (`persistence: "memory"`) holds the whole index in the
wasm heap. On iPhone Safari that ends in `[wasm] RangeError: Out of memory`. A persistent
index keeps data on disk and only caches pages. This is plain SQLite PRAGMAs, not new code.

## Use it

```ts
import { createSqliteVectorIndex } from "@gainratio/browser/vector/sqlite";

// Default: persistent on OPFS, profile chosen for this device.
const index = await createSqliteVectorIndex({ name: "my-catalog", dimension: 384 });

// Force a tier, for example to test the iPhone path on a desktop.
const small = await createSqliteVectorIndex({
	name: "my-catalog",
	dimension: 384,
	memoryProfile: "minimal",
});
```

The SQLite state store takes the same option: `createSqliteStateStore({ ..., memoryProfile })`.

To see what `"auto"` would pick, or to read the PRAGMAs of an open handle:

```ts
import { detectMemoryTier, currentMemoryEnvironment } from "@gainratio/browser/sqlite";
console.log(detectMemoryTier(currentMemoryEnvironment())); // "full" | "lite" | "minimal"
```

## The tiers

| Tier | `cache_size` | `soft_heap_limit` | `hard_heap_limit` | `temp_store` | `mmap_size` |
| --- | --- | --- | --- | --- | --- |
| `full` | 64 MiB | 128 MiB | 192 MiB | memory | 0 |
| `lite` | 16 MiB | 48 MiB | 96 MiB | memory | 0 |
| `minimal` | 4 MiB | 16 MiB | 48 MiB | file | 0 |

`hard_heap_limit` turns a would-be crash into a SQLite out-of-memory error you can catch.
`mmap_size` is 0 because the wasm build has no mmap.

## How `"auto"` decides

`navigator.deviceMemory` exists only in Chromium, so it is never required.

- iPhone, iPad, iPod, or an iPad posing as a Mac (touch points > 1): `minimal`.
- `deviceMemory` known: 8 or more is `full`, above 2 is `lite`, 2 or less is `minimal`.
- `deviceMemory` unknown (Safari desktop, Firefox): `lite`. Only an explicit 8 earns `full`.
- 2 or fewer CPU cores: at most `lite`.
- The weakest signal wins.

## Guarantees

- After applying, the profile is read back with `PRAGMA`. If SQLite ignored one, opening
  throws instead of running with the wrong limits.
- This does not make the in-memory fallback (used only when OPFS is unavailable) bigger or
  smaller than before; the profile is applied there too.

## Not yet verified

The tier numbers are starting points. They are checked against SQLite here, not measured on a
real iPhone. Tune them from device measurements.
