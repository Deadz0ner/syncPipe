# Race Condition: File Corruption During Phone → PC Transfer

> **Status**: ✅ Fixed  
> **Affected direction**: Phone → PC (receiving side)  
> **Components**: `pc-node/src/internal/server.js`, `mobile/src/services/FileTransferService.js`

---

## Section 1 — Technical Deep-Dive

### What Was Happening

When the phone sent a file to the PC, the received file was **corrupted**: wrong size, garbled content, or completely unreadable. The corruption was intermittent — small files often worked fine, but anything over a few hundred KB would break.

### Root Cause: Write-Stream Backpressure Ignored

The PC's Node.js server receives file data as raw binary WebSocket frames. Each frame triggers the `ws.on('message')` callback, which calls:

```javascript
transfer.stream.write(data);
```

The critical detail: **`stream.write()` in Node.js is not always synchronous**. It buffers data internally and flushes it to disk in the background. When the internal buffer fills up, `write()` returns `false` — a signal that says _"stop writing, wait for me to flush before sending more"_. You're supposed to listen for the `'drain'` event before writing the next chunk.

**The old code ignored this entirely.** It was fire-and-forget:

```javascript
// ❌ OLD CODE — no backpressure handling
async handleBinaryChunk(client, data) {
    const transfer = client.activeTransfer;
    transfer.stream.write(data);  // returned value ignored!
}
```

#### Why This Causes Corruption

Here's the sequence that leads to corrupt files:

1. Phone sends chunks **C1, C2, C3, C4, C5** in rapid succession.
2. PC receives C1, calls `stream.write(C1)` → buffer accepts it, starts flushing to disk.
3. PC receives C2 _while C1 is still flushing_. Calls `stream.write(C2)` → buffer accepts it, queues behind C1.
4. PC receives C3 → buffer is now **full**, `write()` returns `false`.
5. PC receives C4 → calls `write(C4)` anyway (ignoring the `false`). Now C3 and C4 are **competing for buffer space**.
6. Node.js's internal scheduler may flush C4 _before_ C3, or interleave their bytes.

The result: the file on disk has bytes from **C4 spliced into the middle of C3**, or chunks in the wrong order entirely. The file is now garbage.

This is a classic **producer-consumer race condition**: the WebSocket producer pushes data faster than the filesystem consumer can write it.

### Secondary Race: Mobile Receiving Side

A related race existed when the PC sent files _to_ the phone. The `FILE_META` JSON message triggers `_handleFileStart()`, which does async work (creating directories, opening the file). But binary data frames can arrive **before that async work finishes**, because WebSocket messages are delivered in order but the handler is `async`.

If `_handleBinary()` fires before the file is ready, the chunk gets silently dropped.

### The Fix

#### PC Side (`server.js`) — Backpressure Handling

```javascript
// ✅ FIXED CODE — respects backpressure
async handleBinaryChunk(client, data) {
    const transfer = client.activeTransfer;
    transfer.hash.update(data);
    transfer.received++;
    transfer.totalBytes += data.length;

    const canContinue = transfer.stream.write(data);
    if (!canContinue) {
        // WAIT for the stream to flush before accepting more data
        await new Promise((resolve) => transfer.stream.once("drain", resolve));
    }
}
```

And in `handleFileEnd()`, we now **await the stream closing** instead of just calling `.end()`:

```javascript
// Wait for ALL buffered data to flush to disk
await new Promise((resolve, reject) => {
  transfer.stream.end((err) => {
    if (err) reject(err);
    else resolve();
  });
});
```

#### Mobile Side (`FileTransferService.js`) — Sync Registration + Init Wait

```javascript
_handleFileStart(data) {
    // SET currentReceiveId IMMEDIATELY (sync) so binary frames aren't dropped
    this.currentReceiveId = transferId;

    // Register the transfer IMMEDIATELY so _handleBinary can find it
    this.activeReceives.set(transferId, transfer);

    // Do async file initialization in the background
    this._initTransferFile(transfer).catch(console.error);
}

async _handleBinary(binaryData) {
    const transfer = this.activeReceives.get(this.currentReceiveId);

    // Wait for the file to be initialized before writing
    let waitCount = 0;
    while (!transfer.initialized && waitCount < 50) {
        await new Promise((r) => setTimeout(r, 100));  // poll every 100ms
        waitCount++;
    }

    // Now safe to write
    await FS.writeAsStringAsync(transfer.destPath, base64, {
        encoding: FS.EncodingType.Base64,
        append: true,
    });
}
```

### Why It Worked

- **No more concurrent writes.** Each chunk waits for the previous one to flush before the next write begins.
- **No more dropped chunks.** The transfer is registered synchronously, and binary handlers wait for file initialization.
- **Clean shutdown.** `stream.end()` is awaited, so the `FILE_END` handler doesn't report success before the last bytes hit disk.

---

## Section 2 — The Simple Explanation

### Imagine a Factory Assembly Line

Think of file transfer like a **factory assembly line** where boxes (chunks of the file) are moving from one station (the phone) to another (the PC).

At the PC end, there's a **worker** whose job is to stack the boxes into a neat pile (write them to disk). The worker can only stack one box at a time and needs a moment to place each one carefully.

#### What Was Going Wrong

The phone was throwing boxes onto the conveyor belt **faster than the worker could stack them**. Boxes started piling up at the worker's feet. In the chaos:

- Box #4 got stacked **before** Box #3.
- Box #7 got **squished together** with Box #6.
- Some boxes fell on the floor and got **mixed up**.

The final pile of boxes looked nothing like the original — the file was **corrupted**.

The worker was actually trying to say _"Hey, slow down! I can't keep up!"_ (by returning `false` from `write()`), but nobody was listening.

#### What We Fixed

We added a simple rule: **after every box, check if the worker says "I'm ready for the next one."**

- If the worker says **"Yes"** → send the next box immediately.
- If the worker says **"Wait"** → pause until the worker signals **"OK, I'm ready"** (the `drain` event).

Now every box gets stacked in the correct order, and the final pile is a perfect copy of what was sent.

#### The Phone's Side Too

There was also a problem on the phone's side when _receiving_ files. Imagine you're told _"A package is coming for you, here's the address label"_ — but before you even read the label, packages start landing at your door. You don't know where to put them, so you throw them away.

The fix: **read the label immediately** (register the transfer synchronously), and if you haven't finished preparing the shelf yet, just **hold onto the packages for a moment** until the shelf is ready. No more lost packages.

---

_This issue was resolved on ~March 10, 2026 as part of the binary WebSocket file transfer refactor._
