# Issue: File Transfer Chunk Size Mismatch

## Description

When transferring large files (e.g., 50MB+ like video files or APKs) over local Wi-Fi between the mobile app and the PC, the transfer would often complete with a **"Size mismatch"** warning on the receiving end.

For instance, a file requiring 1058 binary chunks to be fully transmitted would only log 1040 chunks received. This resulted in corrupted files and mismatched expected file sizes.

## Root Cause

The root cause was a lack of flow control (backpressure) at the application level over the WebSocket connections.

The Mobile React Native app (and similarly the PC clients) were indiscriminately blasting binary frames in a tight loop. While we historically added marginal `setTimeout` (10-15ms on mobile) or `time.Sleep` (2ms in Go) delays to prevent immediate CPU blocking, the generation of WebSocket frames outpaced the underlying OS networking sockets' ability to transmit them over local Wi-Fi.

This caused the React Native bridge and native networking memory queues to eventually overflow. When the TCP/Websocket queue limit was exceeded, intermediate packets were silently dropped by the OS, leading to missing chunks without throwing a Javascript-level error.

## Solution

We implemented a strict, "Ping-Pong" Acknowledgement (ACK) protocol for every binary chunk sent. This creates active flow control, forcing the sender to wait until the receiver has successfully processed and written the chunk to disk before sending over the next frame.

### 1. Unified the Protocol (Mobile, Node.js, Go)

We extended the underlying protocol's `ACK` message to specify which `transfer_id` and specific `chunk` index is being acknowledged.

### 2. Receiver Side Checks

Whenever the receiver successfully pulls a binary frame from the socket, appends the base64/binary to the local storage, and updates the hash:

- **PC (Node & Go)**: Sends back a `MessageTypes.ACK` frame with the transfer details.
- **Mobile**: `_handleBinary` calls the newly added `wsService.sendAck(transferId, chunkIndex)`.

### 3. Sender Side Flow Control

The loops responsible for generating file chunks were completely rewritten to block execution until the receiver's ACK is returned:

- **Mobile (React Native)**: Wrapped the WebSocket binary sender in an `await new Promise` that resolves perfectly on receiving the `wsService.on("ack")` event. It includes an 8-second fallback timeout to prevent total hangups.
- **Node.js**: The stream reader blocks on a Promise resolving the explicit ACK from an `ackCallbacks` map.
- **Go**: We removed the `time.Sleep(2ms)` approach. The `SendFile` routine now creates a `chan int`, registers it dynamically in the global `ackCallbacks` routing table, and uses a blocking `select` statement waiting on `<-ackChan`.

### 4. Strict Index Matching & Timeout Aborts

Initially, there were edge cases where old, delayed ACKs could prematurely trigger the sender, or where a timeout would simply log a warning and continue sending the next chunk, resulting in silent packet drops and file corruption.

To fix this:

- **Strict Matching**: Every `ackCallback` now verifies `ackIndex === expectedIndex` before resolving. If an ACK arrives for chunk 5 while the sender is waiting for chunk 6, it is ignored safely.
- **Hard Aborts**: On an 8-second timeout, the sender fully `reject()`s the promise (or returns an error in Go), preventing any subsequent chunks from being sent and completely halting the corrupted transfer.

#### Does ACKing and Index Checking Add Overhead?

In theory, verifying integers (`ackIndex === i + 1`) and creating heavily buffered channels (in the Go code) are practically `O(1)` operations that execute in nanoseconds. Yes, a strict Stop-and-Wait ACK protocol reduces maximum potential throughput compared to a raw flooding approach, _but_:

1. The bottleneck in local transfers over WebSockets is generally I/O (disk read/write speeds or Wifi layer limits), not CPU integer comparisons.
2. By strictly matching ACKs, we prevent the JS bridge on mobile from freezing due to memory overflows, making the transfer feel more stable visually.
3. Hard aborts save time. If a stream is corrupt, failing fast is vastly superior to waiting for a 1GB file to complete only to discover the final hash mismatched.

## Result

By enforcing exact application-level flow control, the networking queue depths never exceed 1 chunk. The memory overhead is significantly reduced, the React Native JS Bridge is no longer flooded, and multi-gigabyte files can now be sent without silently dropping any binary frames!
