-the connection logic-> are we using any handshake or encryption etc
-the text and file send logic.
-how files are saved in the mobile memory, what libs or methods we use and we can use

---

### How The Connection Logic Works

- **Discovery (UDP)**: The PC broadcasts its presence over the LAN via mDNS / UDP datagrams. This allows the mobile app to automatically detect the PC by scanning the local subnet without needing the user to type an IP.
- **Pairing (Handshake)**: To pair, the user generates a 6-digit pin via the PC CLI which the server holds active for 5 minutes. The mobile app sends a pairing request (`PAIR_REQ` JSON message) to the PC either via an HTTP endpoint or WebSocket. If the pins match, the server generates a secure authentication token and pairs the devices.
- **Connection (TCP via WebSockets)**: Following successful pairing, a continuous node-to-node TCP WebSocket connection is established on the LAN (typically port 9090).
- **Authentication**: When establishing the WebSocket connection, the mobile app sends an `AUTH` message containing the token it received during pairing. If valid, the connection is confirmed.

### The Text and File Send Logic

Our transmission logic relies on a hybrid Protocol over the WebSocket layer:

- **JSON for Control and Metadata:** Things like `TEXT`, `CLIPBOARD` sync, `PING/PONG`, or File Metadata (`FILE_META`) are sent as standard stringified JSON messages over the WebSocket.
- **Raw Binary for Files:** When sending actual file bytes (after the `FILE_META` handshake occurs), the sender breaks the file into chunks (e.g. 64KB). Instead of encoding them as base64 strings (which wastes bandwidth and CPU), the data is pushed onto the WebSocket connection as **raw binary frames**.
- **Application-Level Flow Control (ACKs)**: We utilize a strict "Stop-And-Wait" protocol for binary chunks. When Sender sends Chunk #1, it holds off sending Chunk #2 until the Receiver replies with a JSON `ACK` message specifically confirming `chunk=1`. This prevents memory overflow and dropped UDP/TCP packets over Wi-Fi. It is essentially self-throttling.

#### Wait, doesn't ACKing/Indexing add overhead?

Strictly enforcing ACKs and checking chunk indices (`ackIndex === expectedIndex`) takes practically zero computation (it's an O(1) integer comparison executed in nanoseconds).
While waiting for an ACK slightly limits absolute peak networking throughput compared to a blindly flooding "firehose" approach, it is absolutely crucial:

1. It prevents Mobile/React Native JS bridges from seizing up due to memory buffers flooding with gigabytes of binary data.
2. It guarantees the disk I/O on the receiving side can keep up with the network.
3. If the connection fails or hangs, it hard-aborts the transfer immediately (failing fast) rather than faking success.

### How Files are Saved in the Mobile Memory

We rely entirely on the React Native Expo ecosystem for file handling:

- **Library Used:** `expo-file-system` (specifically the legacy import `expo-file-system/legacy` for direct base64 appending capabilities).
- **Storage Location:** By default on Android, we use the `StorageAccessFramework` (SAF) to request explicit write permission to the user's `Downloads/mcSync/` folder. If SAF gets rejected, it falls back to the app's internal scoped storage (`FS.documentDirectory`).
- **Write Methodology:** When raw binary chunks hit the `_handleBinary` function in React Native, they are converted into a Base64 string locally in JS, and then appended to the file on disk piece by piece using `FS.writeAsStringAsync(path, base64Data, { encoding: FS.EncodingType.Base64, append: true })`. This avoids loading entire 1GB files into RAM.
