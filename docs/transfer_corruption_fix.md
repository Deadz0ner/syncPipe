# File Transfer Corruption Fixes

## Problem 1: React Native Android `ArrayBuffer` over JS Bridge

React Native struggles to natively hand off chunks of raw binary `ArrayBuffer` data cleanly over its JavaScript bridge under heavy WebSocket load. The original implementation resulted in corrupted bytes, failed decoding states, or even outright connection drops when `typeof event.data` was coerced.

_Fix:_ We bypassed bridging `ArrayBuffer` natively. The `mobile` WebSocket service now uses `binaryType = "blob"`. During chunk digestion, we rely on the native `FileReader.readAsDataURL` bridge API to decode the Binary Blob string entirely in native code before safely ferrying the true Base64 text to JavaScript!

## Problem 2: Storage Access Framework `content://` URI Crashes

The user configured their Downloads folder utilizing Android's Storage Access Framework, generating an internal `content://` URI.
The system actively crashed when `ExpoSharing.shareAsync(content://...)` was invoked, as the sharing API rigorously checks for `file://` locally hosted URIs to avoid permission sandboxing issues.

_Fix:_ Downloads are instantly sandboxed inside `FS.documentDirectory` natively under the safe `file://` architecture upon chunk completion. Share actions now directly target this flawless local copy! Once successfully built in App storage, the entire contiguous file is synchronously forwarded via `FS.copyAsync` directly into the targeted SAF folder safely without risking `append` data drops!

## Problem 3: `append: true` Expo FileSystem Truncation Bug

A massive flaw was discovered actively triggering inside the `expo-file-system` Android backend. When running Android 11+ utilizing `writeAsStringAsync` combined with `encoding: Base64` AND `append: true`, Expo utterly overwrites the destination instead of appending! The user reported receiving a 25.97KB file which perfectly mirrors the final single 64KB Base64 chunk!

_Fix:_ Memory buffering strings solves the Base64 fragmentation limitations! The JS core handles 10-150MB string arrays seamlessly in modern Hermes execution. Chunk string aggregation allows absolute precision, culminating in a single atomic `writeAsStringAsync` block upon reception completion.
\n## Problem 4: Base64 Chunk Alignment Concatenation Data Loss\nThe user reported receiving a 1.5MB file scaled down to exactly 65.54KB (or ~64KB chunk sizes). After the previous memory buffering strings update, the concatenated Native string array failed to decode beyond the first chunk! \n\n*Fix:* Standard Base64 natively pads chunks to multiples of 4 by appending `==` signs exactly when the string terminates. If multiple chunks are naively buffered individually without chunk-sizes evenly matching multiples of 3, intermittent `==` padding blocks emerge amidst the string vector! The `FS.writeAsStringAsync` decoder strictly HALTS processing immediately when the first termination padding strikes, dropping off 100% of traversing chunk data! Instead of executing complex un-padding arithmetic loops inside JS over potentially 500+ string arrays during download, the system-wide global chunk length configuration across all branches (Mobile/PC-Node/Go) was explicitly shifted from `64 * 1024` (65536) strictly down to `61440` (60KB). Since 61440 perfectly maps into standard 3-byte boundaries without fraction carryover, zero intermediate chunks incur Native padding generation! All chunks stitch fully seamless and the resulting string drops the un-padded Base64 stream right onto the Native disk directly decoded and 100% physically clean!

## Problem 5: The "Heisenbug" JS Thread Starvation (WebSockets Backpressure)

The physical WebSocket streaming speed from a local PC to a phone often far outpaces the single-threaded JS engine's capability to process Native Base64 chunks and manage Garbage Collection (GC). Because the mobile app used to instantly fire an `ACK` inside JS right after pushing a chunk into the memory array—without any delay—the PC would immediately blast the next chunk. This flooded the React Native JS bridge and overwhelmed OS-level WebSocket buffers.

**Symptom:** Silent dropped chunks, corrupt files from mangled streams, or App OOM (Out-of-Memory) crashes on large file transfers. Interestingly, the problem magically "fixed" itself when excessive `console.log` statements were added for debugging. The heavy delay of serializing strings over the Native Bridge acted as an artificial throttle—a classic "Heisenbug".

**Fix:** Since true synchronous `append: true` writing isn't genuinely supported in Expo `FileSystem` (which would naturally provide backpressure via `await`ing the disk write), we must emulate backpressure. We introduced explicit thread-yielding: `await new Promise(resolve => setTimeout(resolve, 1))` every 50 chunks (approx 3MB). This intentional 1ms JS pause gives exactly enough time for the Garbage Collector to cycle, prevents WebSocket buffer overflows, and gracefully throttles the PC's sending speed to a safely manageable rate in production environments.
