# Base64-Encoded Strings vs Raw Binary for WebSocket File Transfer

## Context

When we first implemented file transfer over WebSocket, file chunks were sent as
base64-encoded strings inside JSON messages. This works, but it's inefficient.
The codebase has since been refactored to use raw binary WebSocket frames.

This document explains **why raw binary is better** and **how base64 overhead works**
under the hood.

---

## The Two Approaches

### Approach 1: Base64-in-JSON (what we did initially)

```
┌──────────────────────────────────────────────────────┐
│  { "type": "FILE_CHUNK",                             │
│    "data": {                                         │
│      "transfer_id": "abc123",                        │
│      "index": 0,                                     │
│      "data": "SGVsbG8gV29ybGQhIFRoaXMgaXMgYm...",   │  ← base64 string
│      "size": 65536                                   │
│    }                                                 │
│  }                                                   │
│                         TEXT FRAME                    │
└──────────────────────────────────────────────────────┘
```

- Read file chunk as base64 string
- Wrap it inside a JSON message
- Send as a WebSocket **text frame**
- Receiver `JSON.parse()`s it, then decodes the base64 back to bytes

### Approach 2: Raw Binary Frames (what we use now)

```
┌──────────────────────────────────────────────────────┐
│  [ raw bytes: 48 65 6C 6C 6F 20 57 6F 72 6C 64 ... ]│
│                                                      │
│                       BINARY FRAME                   │
└──────────────────────────────────────────────────────┘
```

- Read file chunk, convert to `Uint8Array`
- Send directly via `ws.send(uint8array)`
- Receiver gets the exact bytes back — no parsing, no decoding

---

## How Base64 Encoding Actually Works

### The Problem It Solves

Binary data can contain any byte value (0–255). Some of those values are unsafe
in text contexts — null bytes, control characters, characters that break JSON, etc.

Base64 re-encodes binary data using only 64 "safe" ASCII characters so it can
travel through text-only channels.

### The Base64 Alphabet (64 Characters)

```
A B C D E F G H I J K L M N O P Q R S T U V W X Y Z   → 26
a b c d e f g h i j k l m n o p q r s t u v w x y z   → 26
0 1 2 3 4 5 6 7 8 9                                     → 10
+ /                                                     →  2
                                                        ─────
                                                     Total: 64
```

Each character in this alphabet represents **6 bits** of data (because 2⁶ = 64).

### The 3-Bytes-to-4-Characters Conversion

A regular byte is **8 bits**. A base64 character encodes **6 bits**.

To align evenly, base64 works in groups:

```
3 bytes = 3 × 8 = 24 bits
24 bits ÷ 6 bits per base64 char = 4 characters
```

So every **3 bytes** of real data become **4 characters** of base64 text.

### Step-by-Step Example

Encoding the string `"Hey"` (3 bytes: H=72, e=101, y=121):

```
Step 1: Write out the raw bits of each byte

  H = 72  → 01001000
  e = 101 → 01100101
  y = 121 → 01111001

Step 2: Concatenate all 24 bits

  010010000110010101111001

Step 3: Re-split into groups of 6 bits (instead of 8)

  010010 | 000110 | 010101 | 111001

Step 4: Convert each 6-bit group to a decimal number

  010010 → 18
  000110 →  6
  010101 → 21
  111001 → 57

Step 5: Look up each number in the base64 alphabet

  18 → 'S'
   6 → 'G'
  21 → 'V'
  57 → '5'

Result: "Hey" (3 bytes) becomes "SGV5" (4 characters)
```

### Padding

When the input isn't a multiple of 3 bytes, base64 adds `=` padding characters:

```
"He"  (2 bytes) → "SGU="   (padded with 1 '=')
"H"   (1 byte)  → "SA=="   (padded with 2 '=')
"Hey" (3 bytes) → "SGV5"   (no padding needed)
```

---

## The Cost of Base64

### Size Overhead: +33%

```
Raw data:    3 bytes  → sent as 3 bytes
Base64 text: 3 bytes  → sent as 4 bytes (each is 1 ASCII byte)

Overhead = (4 - 3) / 3 = 33.3%
```

At scale:

| File Size | Raw Binary on Wire | Base64 on Wire | Wasted Bandwidth |
| --------- | ------------------ | -------------- | ---------------- |
| 1 MB      | 1 MB               | ~1.33 MB       | 0.33 MB          |
| 10 MB     | 10 MB              | ~13.3 MB       | 3.3 MB           |
| 100 MB    | 100 MB             | ~133 MB        | 33 MB            |
| 1 GB      | 1 GB               | ~1.33 GB       | 333 MB           |

### CPU Overhead

Both the sender and receiver must do work:

- **Sender:** encode raw bytes → base64 string
- **Receiver:** decode base64 string → raw bytes

With raw binary, this step doesn't exist at all.

### Memory Overhead

When using base64-in-JSON, you temporarily hold:

1. The raw bytes (from file read)
2. The base64 string (33% bigger)
3. The complete JSON string (even bigger, with all the wrapper fields)

Three representations of the same data, simultaneously in memory.

### JSON.parse() Cost

The receiver has to `JSON.parse()` the entire message — including the giant
base64 string — just to extract the chunk data. For a 64 KB chunk, that means
parsing an ~87 KB JSON string. Multiply that by hundreds or thousands of chunks.

---

## Why Base64 Exists At All

Base64 was designed for situations where binary data **must** travel through a
text-only channel:

- **Email (MIME)** — the original use case, email protocols were text-only
- **JSON APIs** — JSON has no binary type, so embedding images/files requires encoding
- **Data URIs** — `data:image/png;base64,iVBOR...` in HTML/CSS
- **XML** — same as JSON, no native binary support

These are all cases where you have **no choice** — the transport only supports text.

---

## Why It's Unnecessary Over WebSocket

WebSocket has **native support for two frame types**:

1. **Text frames** — for UTF-8 strings (JSON messages, chat, etc.)
2. **Binary frames** — for raw bytes (files, images, any binary data)

When you call `ws.send(uint8Array)`, WebSocket automatically sends it as a binary
frame. The receiver gets the exact same bytes back. No encoding, no decoding,
no overhead.

Using base64 over WebSocket is solving a problem that doesn't exist — like
bringing an umbrella indoors.

---

## How Our Code Handles This Now

### Sending (Mobile → PC)

```javascript
// FileTransferService.js

// 1. Read chunk from file (Expo returns base64, that's just how the API works)
const chunkBase64 = await FS.readAsStringAsync(localUri, {
  encoding: FS.EncodingType.Base64,
  length,
  position: bytesSent,
});

// 2. Convert base64 → Uint8Array (raw bytes)
const chunkBinary = base64ToUint8Array(chunkBase64);

// 3. Send raw bytes over WebSocket binary frame
wsService.sendBinary(chunkBinary);
```

Note: We still have to deal with base64 at the Expo file-read level because
`readAsStringAsync` only returns strings. But we immediately convert to binary
and send raw bytes over the wire — the base64 never leaves the device.

### Receiving (PC → Mobile)

The WebSocket `onmessage` handler checks if the incoming data is a string
(JSON text frame) or binary (ArrayBuffer). Binary frames go directly to the
file transfer handler without any decoding step.

### Protocol Flow

```
Sender                          Wire                          Receiver
──────                          ────                          ────────
FILE_META (JSON text frame)  →  {"type":"FILE_META",...}   →  Parse JSON, prepare file
Binary frame (raw bytes)     →  [raw chunk bytes]          →  Write bytes directly to file
Binary frame (raw bytes)     →  [raw chunk bytes]          →  Write bytes directly to file
  ...                             ...                           ...
FILE_END  (JSON text frame)  →  {"type":"FILE_END",...}    →  Parse JSON, finalize file
```

JSON is used for the control messages (start/end), raw binary for the actual data.
Best of both worlds.

---

## TL;DR

|                       | Base64-in-JSON                             | Raw Binary Frames                                         |
| --------------------- | ------------------------------------------ | --------------------------------------------------------- |
| **Wire size**         | +33% bloat                                 | Exact file size                                           |
| **CPU**               | Encode + decode on both sides              | Zero conversion                                           |
| **Memory**            | 3x copies (bytes + base64 + JSON)          | 1 copy (just the bytes)                                   |
| **Parsing**           | JSON.parse() on huge strings               | No parsing for data chunks                                |
| **WebSocket support** | ✅ but misusing text frames                | ✅ native binary frame support                            |
| **When to use**       | When you have no choice (JSON APIs, email) | When the transport supports binary (WebSocket, TCP, HTTP) |
