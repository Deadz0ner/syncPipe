# File Transfer Logic

This document details the mechanics and network logic of how mcSync sends files bidirectionally between the Mobile App and the PC over WebSocket.

## 1. File Chunking & Network Transport

To transfer large files dependably without overflowing RAM or dropping packets, mcSync fragments files into smaller discrete payloads.

- **Chunk Size**: The application is strictly optimized to use **60 KB (61,440 bytes)** chunks. This specific constraint is used because 60 KB is a multiple of 3, allowing for safe conversions into Base64 strings across chunks without causing decoding padding issues across arbitrary network boundaries.
- **Protocol**: File data is sent as raw binary WebSocket frames for maximum efficiency. However, the exact JS representation used varies on each platform because of Node.js vs React Native differences.

## 2. PC Sending to Mobile

### Step 1: Start Initialization

The PC reads the requested file's metadata on disk and sends a `FILE_META` (JSON) message to the Mobile App containing the filename, size, and a generated `transfer_id`.
The Mobile sets up the local storage pointers (determining if it needs SAF URI permissions or app storage) and answers with an `ACK(0)` response indicating it is ready.

### Step 2: Binary Delivery Loop

The PC opens an asynchronous file stream. For every iteration, it performs the following:

1. It reads exactly 60 KB of raw buffer data from disk.
2. It hashes the data dynamically into a persistent SHA256 checksum state.
3. It emits the chunk directly natively over the connection as a generic binary frame: `ws.send(data)`.
4. **Flow Control (Backpressure):** The PC pauses the stream and institutes an 8s timeout. It explicitly waits for an `ACK` JSON message from Mobile verifying it received chunk `N` before reading and sending chunk `N+1`.

### Step 3: Mobile Reception & Re-assembly

Because `expo-file-system` lacks streaming filesystem appends native to React Native, Mobile must collect chunks in memory:

1. If binary data arrives correctly, the arraybuffer is securely re-structured into a continuous Base64 payload string natively using JS (`base64` and integer masking).
2. The converted chunk is pushed into an array (`transfer.chunks.push(base64)`).
3. **Yielding Thread:** To prevent garbling the JS thread/garbage-collector on massive files, the loop manually yields `setTimeout(resolve, 1)` every 50 chunks.

### Step 4: Transfer Finalization

When finished streaming, the PC issues a `FILE_END` JSON frame detailing total chunks and its SHA256 verification sum. Mobile reacts by `.join("")`ing its massive Base64 array string together safely and doing **a single atomic file flush** of the entire string natively to disk, preventing filesystem corruption.

## 3. Mobile Sending to PC

### Step 1: Initialization

The Mobile app probes the file (even abstract SAF URIs internally get locally temporarily copied using `FileSystem.copyAsync` if needed) and resolves a real `System URI`. It derives size and name, emitting a `FILE_META` object across the WebSocket to the PC.
The PC dynamically ensures the filename is globally unique inside the receive folder (`file_1.png` if `file.png` exists). It provisions a native `fs.createWriteStream`, acknowledges Mobile with `ACK(0)`, and begins awaiting chunks.

### Step 2: Read & Delivery Mechanism

The Mobile App calculates total chunk length explicitly. For each loop iterant:

1. It asynchronously slice-reads `CHUNK_SIZE` directly off disk using `FS.readAsStringAsync` passing the exact `position`.
2. Expo returns the 60 KB chunk explicitly formatted as `Base64`.
3. The custom `base64ToUint8Array` helper decodes the string to a native binary buffer on the Mobile App, ensuring it uses pure binary WebSockets.
4. It sends the payload: `ws.sendBinary()`.
5. Finally, it awaits the corresponding `ACK` index from the PC or aborts heavily if timeout strikes.

### Step 3: Server Ingestion (PC)

The PC's WebSocket catches the binary frame. It funnels the buffer backpressure accurately using `stream.write()`. If the OS disk buffer gets overwhelmed (write returns `false`), Node explicitly binds `stream.once("drain", ...)` to hold before telling the JS engine it successfully accumulated the bytes and sending `ACK`s back to the phone.

### Step 4: Finalization

Upon `FILE_END`, the stream stream flushes cleanly to destination, emitting a final write verification (`"status": "ok"`).
