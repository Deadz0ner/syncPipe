# Project SyncApp: Stuck Points & Solutions

This document tracks technical hurdles encountered during development and how they were resolved.

## 1. File Transfer Corruption (Base64)

- **Problem**: Files sent from the mobile App to the PC were arriving corrupted (un-openable, size mismatches).
- **Cause**: Standard Base64 encoding/decoding was misaligning chunks, or some characters were being misinterpreted during JSON stringification.
- **Solution**: First adjusted chunk sizes to be multiples of 3 (ensuring Base64 alignment). Later, moved to **raw binary WebSocket frames** (Binary Frames) which eliminated encoding errors entirely.

## 2. Expo FileSystem Deprecation

- **Problem**: Calling `FS.readAsStringAsync` in newer Expo Go builds resulted in a "deprecated" error that halted execution.
- **Solution**: Switched imports to `expo-file-system/legacy`. This allows the app to continue using the `readAsStringAsync` and `writeAsStringAsync` APIs while maintaining compatibility with the latest Expo SDK.

## 3. High CPU & Bandwidth usage (Base64)

- **Problem**: Sending large files (100MB+) was slow and made the phone hot due to Base64 CPU overhead and a ~33% increase in data size.
- **Solution**: Refactored the entire pipeline to use **Binary WebSocket frames**. Signals (Start, Meta, End) remain JSON, but file data is sent as raw bytes.

## 4. Mobile Binary Reception Backpressure

- **Problem**: Appending to a file in React Native while receiving binary frames was causing the UI to hang or the app to crash on large files.
- **Solution**: Implemented chunked writing via `FS.writeAsStringAsync` with `append: true` and `encoding: Base64`. While Expo requires Base64 for the bridge call, the underlying native code writes the bytes correctly, and using `setTimeout(0)` yields control back to the UI loop.

## 5. Go Server WebSocket Routing

- **Problem**: The Go server was expecting all messages to be JSON strings; binary frames caused unmarshal errors.
- **Solution**: Refactored the `handleClient` loop in Go to read the `messageType` first. If `websocket.BinaryMessage`, it routes to a binary handler; if `websocket.TextMessage`, it routes to the JSON parser.

## 6. REPL Prompt Interruption

- **Problem**: Background logs (e.g., "[Server] New connection") were printing over the REPL prompt, making it disappear or causing the cursor to move to an empty line.
- **Solution**:
  - **Go**: Implemented a `safeWriter` that clears the line with ANSI escapes (`\r\033[K`) before printing logs and then redraws the prompt.
  - **Node.js**: Created a custom `logger` that uses `readline.cursorTo(0)` and `rl.prompt(true)` to ensure the prompt is always at the bottom.

## 7. Android Internal Storage Root Access

- **Problem**: Files were being saved to the app's private sandbox (`documentDirectory`), making them invisible to the user in common file managers. The user wanted them in `Internal Storage/mcSync/`.
- **Solution**:
  - Updated `FileTransferService.js` to attempt writing to `file:///storage/emulated/0/mcSync/` on Android.
  - Implemented `async` directory creation checks to ensure the folder exists before writing.
  - Added a fallback to `App Storage` (sandbox) in case the OS blocks access to the root storage (Scoped Storage restrictions), ensuring the transfer doesn't simply crash.
  - Updated the UI to dynamically show the actual storage location (`Internal Storage` vs `App Storage`).

## 8. Node.js REPL Crash on Exit (ERR_USE_AFTER_CLOSE)

- **Problem**: During shutdown (Ctrl+C), the logger was attempting to call `rl.prompt(true)` after the readline interface had already been closed, causing a crash.
- **Solution**:
  - Introduced an `isClosing` flag in `index.js`.
  - Modified the custom logger to check `!isClosing` before attempting to redraw the prompt.
  - Added `process.stdout.isTTY` checks to prevent ANSI escape sequence errors in non-interactive environments.

## 9. File Corruption Race Condition (Backpressure)

- **Problem**: Files sent from the phone to the PC arrived **corrupted** — wrong size, unreadable, or with bytes out of order. The issue only surfaced with larger files or fast networks.
- **Cause**: The PC's Node.js WebSocket handler was calling `stream.write(data)` on every incoming binary chunk **without awaiting backpressure**. When the file-system couldn't flush fast enough, `write()` returned `false` (buffer full), but the code kept writing. This caused multiple chunks to be written **concurrently and out of order**, interleaving bytes in the output file. A secondary race existed on the mobile receiving side where binary frames could arrive before the destination file path was initialized.
- **Solution**:
  1. **PC side**: Added `drain` event handling — if `stream.write()` returns `false`, `await` a `drain` event before writing the next chunk. Also `await stream.end()` before declaring the file complete.
  2. **Mobile side**: Register the transfer **synchronously** in `_handleFileStart` and spin-wait in `_handleBinary` until the file is initialized, preventing dropped chunks.
- **See also**: [`issues/race-condition-file-corruption.md`](./race-condition-file-corruption.md) for a detailed breakdown.

---

_Note: Keep updating this as new issues arise._
