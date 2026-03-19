# Binary WebSocket File Transfer Refactor

This document summarizes the changes made to move from Base64-encoded JSON messages to raw binary WebSocket frames for file transfer.

## 📅 Date: 2026-03-10

**Goal**: Reduce bandwidth by 25-33%, lower CPU usage, and fix file corruption.

---

### 1. Protocol Changes (`protocol.js` / `messages.go`)

- **Added `FILE_META`**: A new JSON message type describing the file (`name`, `size`, `transfer_id`) before binary transmission starts.
- **Support for Binary Frames**: The protocol now treats a raw binary frame (no JSON framing) as a file chunk.

### 2. PC Node.js Server (`pc-node/src/internal/server.js`)

- **`handleWebSocket`**: Modified to check the `isBinary` flag provided by `ws.on('message')`.
- **`handleBinaryChunk`**: Now writes incoming raw `Buffer` chunks directly into a `fs.createWriteStream`.
- **`handleFileEnd`**: Simplified to close the writable stream and verify the final file size/hash.
- **`sendFile`**: Refactored to send the `FILE_META` message, followed by chunks as raw `Buffer` binaries via `ws.send(data, { binary: true })`.

### 3. PC Go Server (`pc/internal/server/server.go`)

- **`handleClient` loop**: Updated to read `messageType` from the Gorilla WebSocket.
- **`handleBinaryChunk`**: Added logic to handle raw bytes without JSON unmarshaling.
- **`SendFile`**: Refactored to stream using `websocket.BinaryMessage`.
- **`FileTransfer` struct**: Added `Hasher hash.Hash` to compute SHA-256 incrementaly as chunks arrive.

### 4. Mobile App (React Native/Expo)

- **`WebSocketService.js`**:
  - `onmessage`: Emits a `'binary'` event when `typeof event.data !== "string"`.
  - Added `sendBinary(data)` method to send raw `ArrayBuffer` or `Uint8Array`.
- **`FileTransferService.js`**:
  - **Sending**: Refactored `sendFile` to read 64KB chunks as Base64 (from Expo FS), convert to `Uint8Array`, and send as raw binary frames.
  - **Receiving**: Introduced `_handleBinary` to process incoming `ArrayBuffer` frames and append them to the local file.
  - **Progress tracking**: Updated to accurately reflect decimal progress based on actual bytes received vs. expected total size.

---

### 🚀 Benefits Observed

- **Speed**: Transmission is noticeably faster (no Base64 overhead).
- **Stability**: Files are no longer corrupt when arriving at the PC.
- **Memory**: Drastically reduced memory spikes on the phone during 100MB+ transfers.
- **Simplicity**: Removed complex Base64 padding/alignment logic.
