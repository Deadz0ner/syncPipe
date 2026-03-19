/**
 * FileTransferService - Handles sending and receiving files over WebSocket.
 *
 * IMPORTANT: We import from "expo-file-system/legacy" — NOT "expo-file-system".
 */

import { Platform, PermissionsAndroid } from "react-native";
import * as FS from "expo-file-system/legacy";
import wsService from "./WebSocketService";
import deviceStore from "../stores/DeviceStore";

// Recommended 60 KB chunks (61440 bytes) to explicitly align with Base64 multiples of 3
const CHUNK_SIZE = 61440;

// Helper function to convert base64 to Uint8Array safely, bypassing buggy RN atob()
const base64ToUint8Array = (base64) => {
  const lookup = new Uint8Array(256);
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;

  let bufferLength = base64.length * 0.75;
  if (base64[base64.length - 1] === "=") bufferLength--;
  if (base64[base64.length - 2] === "=") bufferLength--;

  const bytes = new Uint8Array(bufferLength);
  let p = 0;

  for (let i = 0; i < base64.length; i += 4) {
    const encoded1 = lookup[base64.charCodeAt(i)];
    const encoded2 = lookup[base64.charCodeAt(i + 1)];
    const encoded3 = lookup[base64.charCodeAt(i + 2)];
    const encoded4 = lookup[base64.charCodeAt(i + 3)];

    bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
    if (base64[i + 2] !== "=") {
      bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
    }
    if (base64[i + 3] !== "=") {
      bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
    }
  }

  return bytes;
};

class FileTransferService {
  constructor() {
    this.activeReceives = new Map();
    this.onFileReceived = null;
    this.onProgress = null;
    this.currentReceiveId = null;
    this._storagePermissionGranted = null; // null = not checked yet
    this._receiveDir = null;
    this._displayPath = null;

    wsService.on("fileStart", (data) => this._handleFileStart(data));
    wsService.on("fileMeta", (data) => this._handleFileStart(data));
    wsService.on("fileChunk", (data) => this._handleFileChunk(data));
    wsService.on("fileEnd", (data) => this._handleFileEnd(data));
    wsService.on("binary", (data) => this._handleBinary(data));

    // Request storage permission once at startup (Android only)
    if (Platform.OS === "android") {
      this._initStoragePermission();
    }
  }

  /**
   * One-time storage permission check at startup.
   * Resolves the receive directory so file transfers don't block on permission dialogs.
   */
  async _initStoragePermission() {
    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
        {
          title: "Storage Permission",
          message:
            "mcSync needs storage access to save received files to your Downloads folder.",
          buttonNeutral: "Ask Me Later",
          buttonNegative: "Cancel",
          buttonPositive: "OK",
        },
      );
      this._storagePermissionGranted =
        granted === PermissionsAndroid.RESULTS.GRANTED;
      console.log(`[FileTransfer] Storage permission: ${granted}`);
    } catch (err) {
      console.warn("[FileTransfer] Permission request error:", err.message);
      this._storagePermissionGranted = false;
    }

    // Pre-resolve the receive directory
    if (this._storagePermissionGranted) {
      try {
        const rootDir = "file:///storage/emulated/0/Download/mcSync/";
        const info = await FS.getInfoAsync(rootDir);
        if (!info.exists) {
          await FS.makeDirectoryAsync(rootDir, { intermediates: true });
        }
        this._receiveDir = rootDir;
        this._displayPath = "Downloads/mcSync/";
        console.log(
          "[FileTransfer] Using Downloads/mcSync/ for received files",
        );
      } catch (err) {
        console.warn(
          "[FileTransfer] Downloads dir failed, using app storage:",
          err.message,
        );
        this._storagePermissionGranted = false;
      }
    }

    if (!this._storagePermissionGranted) {
      const appDir = `${FS.documentDirectory}mcSync/`;
      await FS.makeDirectoryAsync(appDir, { intermediates: true }).catch(
        () => {},
      );
      this._receiveDir = appDir;
      this._displayPath = "App Storage/mcSync/";
      console.log(
        "[FileTransfer] Using App Storage/mcSync/ for received files",
      );
    }
  }

  setOnFileReceived(callback) {
    this.onFileReceived = callback;
  }

  setOnProgress(callback) {
    this.onProgress = callback;
  }

  /**
   * Resolve any URI type to a local file:// path readable by FS.readAsStringAsync.
   */
  async _resolveLocalUri(source) {
    const rawUri =
      typeof source === "object" && source !== null ? source.uri : source;

    if (!rawUri) {
      throw new Error("Could not extract URI from file source");
    }

    if (rawUri.startsWith("file://")) {
      return rawUri;
    }

    const dest = `${FS.cacheDirectory}mcsync_${Date.now()}.tmp`;
    await FS.copyAsync({ from: rawUri, to: dest });
    return dest;
  }

  // ─── Sending (Phone → PC) ─────────────────────────────────────────────────

  async sendFile(source, fileName, externalSize = null) {
    console.log(`[FileTransfer] sendFile: "${fileName}"`);
    try {
      const localUri = await this._resolveLocalUri(source);

      let fileSize =
        externalSize && !isNaN(Number(externalSize))
          ? Number(externalSize)
          : null;
      if (!fileSize) {
        const info = await FS.getInfoAsync(localUri, { size: true });
        if (!info.exists) throw new Error(`File not found: ${localUri}`);
        fileSize = info.size;
      }

      const transferId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

      console.log(
        `[FileTransfer] Sending "${fileName}" (${fileSize} bytes) in ${totalChunks} binary chunks...`,
      );

      // 1. Send FILE_META (JSON)
      const metaMsgId = wsService.sendFileMeta(fileName, fileSize, transferId);

      // Setup ACK listener
      let activeAckCallback = null;
      let activeMetaAckCallback = null;
      const ackListener = wsService.on("ack", (data) => {
        if (data && data.message_id === metaMsgId && activeMetaAckCallback) {
          activeMetaAckCallback();
        }
        if (data && data.transfer_id === transferId && activeAckCallback) {
          activeAckCallback(data.chunk);
        }
      });

      // Wait for FILE_META ACK to ensure receiver is ready
      await new Promise((resolve, reject) => {
        let resolved = false;
        let timer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            console.warn(`[FileTransfer] ⚠️ FILE_META ACK timeout`);
            reject(new Error("FILE_META ACK timeout"));
          }
        }, 8000);

        activeMetaAckCallback = () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve();
          }
        };
      });

      // 2 & 3. Read in chunks and send binary frames
      let bytesSent = 0;
      for (let i = 0; i < totalChunks; i++) {
        const length = Math.min(CHUNK_SIZE, fileSize - bytesSent);

        const chunkBase64 = await FS.readAsStringAsync(localUri, {
          encoding: FS.EncodingType.Base64,
          length,
          position: bytesSent,
        });

        const chunkBinary = base64ToUint8Array(chunkBase64);
        wsService.sendBinary(chunkBinary);

        // Wait for ACK
        await new Promise((resolve, reject) => {
          let resolved = false;
          let timer = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              console.warn(`[FileTransfer] ⚠️ ACK timeout for chunk ${i + 1}`);
              reject(new Error(`ACK timeout for chunk ${i + 1}`));
            }
          }, 8000);

          activeAckCallback = (ackIndex) => {
            if (!resolved && ackIndex === i + 1) {
              resolved = true;
              clearTimeout(timer);
              resolve();
            }
          };
        });

        bytesSent += length;

        if (this.onProgress) {
          this.onProgress({
            transferId,
            fileName,
            direction: "send",
            progress: bytesSent / fileSize,
            chunkIndex: i + 1,
            totalChunks,
          });
        }
      }

      // Cleanup listener
      if (ackListener) ackListener();

      // 5. Send FILE_END (JSON)
      wsService.sendFileEnd(transferId, "", totalChunks);
      console.log(`[FileTransfer] "${fileName}" sent successfully ✓`);

      if (this.onProgress) {
        this.onProgress({
          transferId,
          fileName,
          direction: "send",
          progress: 1,
          chunkIndex: totalChunks,
          totalChunks,
          complete: true,
        });
      }

      // Emit event for history
      wsService._emit("fileTransferCompleted", {
        filename: fileName,
        size: fileSize,
        direction: "send",
      });

      return true;
    } catch (error) {
      console.error(`[FileTransfer] Send error: ${error.message}`);
      throw error;
    }
  }

  // ─── Receiving (PC → Phone) ───────────────────────────────────────────────

  _handleFileStart(data) {
    console.log(
      `[FileTransfer] >>> _handleFileStart CALLED with data:`,
      JSON.stringify(data),
    );
    const transferId = data.transfer_id || "binary_receive";
    const filename = data.filename || data.name;
    const fileSize = data.file_size || data.size;

    console.log(
      `[FileTransfer] Parsed: transferId=${transferId}, filename=${filename}, fileSize=${fileSize}`,
    );

    // SET currentReceiveId EARLY so binary frames aren't dropped
    this.currentReceiveId = transferId;

    // Use pre-resolved directory as fallback, but we will async resolve the exact path
    const fallbackDir = this._receiveDir || `${FS.documentDirectory}mcSync/`;
    const fallbackPath = `${fallbackDir}${filename}`;

    const transfer = {
      transferId,
      filename,
      fileSize,
      received: 0,
      totalBytes: 0,
      destPath: fallbackPath,
      displayPath: this._displayPath || "App Storage/mcSync/",
      initialized: false,
      chunks: [],
    };

    // Register the transfer IMMEDIATELY so _handleBinary can find it
    this.activeReceives.set(transferId, transfer);

    // Do async file initialization in the background
    this._initTransferFile(transfer).catch((e) => {
      console.error("[FileTransfer] File init failed:", e.message);
    });

    if (this.onProgress) {
      this.onProgress({
        transferId,
        fileName: filename,
        direction: "receive",
        progress: 0,
        chunkIndex: 0,
        totalChunks: Math.ceil(fileSize / CHUNK_SIZE),
      });
    }
  }

  async _initTransferFile(transfer) {
    const localDir = `${FS.documentDirectory}mcSync/`;
    transfer.localPath = `${localDir}${transfer.filename}`;

    try {
      const { uri, name } = await deviceStore.getReceiveDir();
      if (uri) {
        transfer.safUri = uri;
        transfer.displayPath = name || "Selected Folder";
      }
    } catch (e) {
      console.warn("[FileTransfer] SAF resolution failed:", e.message);
    }

    // Ensure local directory exists
    await FS.makeDirectoryAsync(localDir, { intermediates: true }).catch(
      () => {},
    );

    try {
      await FS.writeAsStringAsync(transfer.localPath, "", {
        encoding: FS.EncodingType.UTF8,
      });
      transfer.initialized = true;
      console.log(
        `[FileTransfer] Local file initialized at: ${transfer.localPath}`,
      );
    } catch (e) {
      console.error(
        "[FileTransfer] Failed to initialize local file:",
        e.message,
      );
    }

    console.log(
      `[FileTransfer] ✅ Ready to receive "${transfer.filename}" (${transfer.fileSize} bytes) -> ${transfer.displayPath}`,
    );

    // Send readiness ACK back to PC so it can begin streaming chunks safely
    wsService.sendAck(transfer.transferId, 0);
  }

  async _handleBinary(binaryData) {
    if (!this.currentReceiveId) {
      console.warn(
        `[FileTransfer] ⚠️ BINARY frame DROPPED — no currentReceiveId set!`,
      );
      return;
    }
    const transfer = this.activeReceives.get(this.currentReceiveId);
    if (!transfer) {
      console.warn(
        `[FileTransfer] ⚠️ BINARY frame DROPPED — no transfer found for id: ${this.currentReceiveId}`,
      );
      return;
    }

    // Wait for the start signal handler to finish initializing the file path
    let waitCount = 0;
    while (!transfer.initialized && waitCount < 50) {
      await new Promise((r) => setTimeout(r, 100));
      waitCount++;
    }
    if (!transfer.initialized) {
      console.error(
        `[FileTransfer] ❌ Transfer never initialized after 5s wait! Dropping chunk.`,
      );
      return;
    }

    transfer.received++;

    let base64;
    let chunkLen = 0;

    if (binaryData instanceof ArrayBuffer) {
      base64 = this._arrayBufferToBase64(binaryData);
      chunkLen = binaryData.byteLength;
    } else if (binaryData instanceof Uint8Array) {
      base64 = this._arrayBufferToBase64(binaryData.buffer);
      chunkLen = binaryData.byteLength;
    } else if (
      binaryData instanceof Blob ||
      (binaryData && typeof binaryData.size === "number")
    ) {
      chunkLen = binaryData.size;
      try {
        base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const res = reader.result;
            resolve(res.includes(",") ? res.split(",")[1] : res);
          };
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(binaryData);
        });
      } catch (e) {
        console.error("[FileTransfer] ❌ Blob decode error:", e);
        return;
      }
    } else if (typeof binaryData === "string") {
      base64 = binaryData;
      let padding = 0;
      if (base64.endsWith("==")) padding = 2;
      else if (base64.endsWith("=")) padding = 1;
      chunkLen = base64.length * 0.75 - padding;
    } else {
      console.warn(
        `[FileTransfer] ⚠️ BINARY frame DROPPED — unknown data type: ${typeof binaryData}`,
      );
      return;
    }

    // Restore original spaced-out logging to avoid React Native bridge lag in production
    if (transfer.received <= 3 || transfer.received % 50 === 0) {
      console.log(
        `[FileTransfer] 📦 Chunk #${transfer.received} received (${chunkLen} bytes, total so far: ${transfer.totalBytes + chunkLen})`,
      );
    }

    // Update totalBytes BEFORE the async write to avoid race with _handleFileEnd
    transfer.totalBytes += chunkLen;

    try {
      transfer.chunks.push(base64);

      // EXPLICIT JS EVENT-LOOP YIELD:
      // Because Expo FileSystem doesn't support streaming native 'append' (it only overwrites),
      // we are forced to build an array in memory. To prevent the WebSocket native buffers from
      // flooding or the Garbage Collector from failing during large file streams, we yield the
      // JS thread for 1 millisecond every 50 chunks (~3MB). This acts as perfect flow-control.
      if (transfer.received % 50 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      wsService.sendAck(this.currentReceiveId, transfer.received);
    } catch (e) {
      transfer.totalBytes -= chunkLen; // rollback on failure
      console.error("[FileTransfer] ❌ Processing fail:", e.message);
    }

    if (this.onProgress) {
      this.onProgress({
        transferId: this.currentReceiveId,
        fileName: transfer.filename,
        direction: "receive",
        progress: Math.min(1, transfer.totalBytes / transfer.fileSize),
        chunkIndex: transfer.received,
        totalChunks: Math.ceil(transfer.fileSize / CHUNK_SIZE),
      });
    }
  }

  _handleFileChunk(data) {
    const transfer = this.activeReceives.get(data.transfer_id);
    if (!transfer) return;

    FS.writeAsStringAsync(transfer.destPath, data.data, {
      encoding: FS.EncodingType.Base64,
      append: true,
    }).catch(console.error);

    transfer.received++;
  }

  async _handleFileEnd(data) {
    console.log(
      `[FileTransfer] >>> _handleFileEnd CALLED with data:`,
      JSON.stringify(data),
    );
    const transferId = data.transfer_id || this.currentReceiveId;
    const transfer = this.activeReceives.get(transferId);
    if (!transfer) {
      console.warn(
        `[FileTransfer] ⚠️ FILE_END but no active transfer for id: ${transferId}`,
      );
      return;
    }

    // Flush the accumulated base64 chunks atomically!
    try {
      const fullBase64 = transfer.chunks.join("");
      console.log(
        `[FileTransfer] 🛠️ Merged chunks into base64 string of length ${fullBase64.length}`,
      );

      await FS.writeAsStringAsync(transfer.localPath, fullBase64, {
        encoding: FS.EncodingType.Base64,
      });

      const fileInfo = await FS.getInfoAsync(transfer.localPath, {
        size: true,
      });
      console.log(
        `[FileTransfer] 🛠️ File written to disk at ${transfer.localPath}. Total size on disk: ${fileInfo.size} bytes. Expected size: ${transfer.fileSize} bytes.`,
      );

      transfer.chunks = []; // Free up memory
    } catch (writeErr) {
      console.error(
        "[FileTransfer] ❌ Failed atomic file flush!",
        writeErr.message,
      );
    }

    if (transfer.safUri) {
      try {
        const newSafUri = await FS.StorageAccessFramework.createFileAsync(
          transfer.safUri,
          transfer.filename,
          "*/*",
        );
        const base64Data = await FS.readAsStringAsync(transfer.localPath, {
          encoding: "base64",
        });
        await FS.writeAsStringAsync(newSafUri, base64Data, {
          encoding: "base64",
        });
        transfer.destPath = newSafUri;
        console.log(`[FileTransfer] File copied to SAF: ${newSafUri}`);
      } catch (err) {
        console.error(`[FileTransfer] Failed to copy to SAF: ${err.message}`);
        transfer.destPath = transfer.localPath; // Fallback to local
      }
    } else {
      transfer.destPath = transfer.localPath;
    }

    console.log(
      `[FileTransfer] ✅ File complete: "${transfer.filename}" (${transfer.totalBytes} bytes in ${transfer.received} chunks)`,
    );

    console.log(
      `[FileTransfer] Saved "${transfer.filename}" → ${transfer.displayPath} ✓`,
    );

    if (this.onFileReceived) {
      this.onFileReceived({
        filename: transfer.filename,
        path: transfer.localPath,
        displayPath: transfer.displayPath,
        size: transfer.fileSize,
      });
    }

    // Emit a global event via wsService for HomeScreen history/notifications
    wsService._emit("fileTransferCompleted", {
      filename: transfer.filename,
      path: transfer.localPath,
      displayPath: transfer.displayPath,
      size: transfer.fileSize,
      direction: "receive",
    });

    if (this.onProgress) {
      this.onProgress({
        transferId,
        fileName: transfer.filename,
        direction: "receive",
        progress: 1,
        chunkIndex: transfer.received,
        totalChunks: transfer.received,
        complete: true,
      });
    }

    this.activeReceives.delete(transferId);
    if (this.currentReceiveId === transferId) {
      this.currentReceiveId = null;
    }
  }

  _arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const lookup =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    // Process 3 bytes at a time
    for (let i = 0; i < bytes.length; i += 3) {
      const b1 = bytes[i];
      const b2 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const b3 = i + 2 < bytes.length ? bytes[i + 2] : 0;

      const chunk = (b1 << 16) | (b2 << 8) | b3;

      binary += lookup[(chunk >> 18) & 63];
      binary += lookup[(chunk >> 12) & 63];
      binary += i + 1 < bytes.length ? lookup[(chunk >> 6) & 63] : "=";
      binary += i + 2 < bytes.length ? lookup[chunk & 63] : "=";
    }

    console.log(
      `[FileTransfer] Encoded chunk natively: ${bytes.length} bytes -> ${binary.length} base64 chars`,
    );
    return binary;
  }
}

const fileTransferService = new FileTransferService();
export default fileTransferService;
