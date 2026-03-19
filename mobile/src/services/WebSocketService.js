/**
 * WebSocketService - Manages the persistent WebSocket connection to the PC.
 * Handles connection, reconnection, authentication, and message routing.
 */

class WebSocketService {
  constructor() {
    this.ws = null;
    this.url = null;
    this.isConnected = false;
    this.isAuthenticated = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 50;
    this.reconnectDelay = 1000; // Start at 1s, exponential backoff
    this.messageHandlers = new Map();
    this.pendingMessages = [];
    this.connectionInfo = null;
    this.authInfo = null;
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._onStatusChange = null;
  }

  /**
   * Set callback for connection status changes
   */
  onStatusChange(callback) {
    this._onStatusChange = callback;
  }

  _notifyStatus(status, detail = "") {
    if (this._onStatusChange) {
      this._onStatusChange(status, detail);
    }
  }

  /**
   * Connect to the PC WebSocket server
   * @param {string} host - PC IP or hostname
   * @param {number} port - Server port
   * @param {object} authInfo - { deviceId, authToken, deviceName }
   */
  connect(host, port, authInfo = null) {
    this.url = `ws://${host}:${port}/ws`;
    this.authInfo = authInfo;
    this.reconnectAttempts = 0;
    this._doConnect();
  }

  _doConnect() {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
    }

    this._notifyStatus("connecting", this.url);
    console.log(`[WS] Connecting to ${this.url}...`);

    try {
      this.ws = new WebSocket(this.url);
      // Use blob to properly decode to base64 via native FileReader later
      this.ws.binaryType = "blob";
    } catch (error) {
      console.log(`[WS] Connection creation error: ${error.message}`);
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log("[WS] Connected");
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
      this._notifyStatus("connected");
      this._emit("connected", null); // Added connected event

      // Authenticate if we have auth info
      if (this.authInfo) {
        this._authenticate();
      }

      // Start ping interval
      this._startPing();

      // Send any pending messages
      this._flushPending();
    };

    this.ws.onmessage = (event) => {
      try {
        if (typeof event.data !== "string") {
          // Binary message
          const size =
            event.data instanceof ArrayBuffer
              ? event.data.byteLength
              : event.data && event.data.size
                ? event.data.size
                : "??";
          console.log(
            `[WS] ◀ BINARY frame received (${size} bytes, type: ${typeof event.data}, constructor: ${event.data?.constructor?.name})`,
          );
          this._emit("binary", event.data);
          return;
        }

        // If it's a string, it's usually JSON...
        let msg;
        try {
          if (!event.data.startsWith("{")) throw new Error("Not a JSON object");
          msg = JSON.parse(event.data);
        } catch (parseError) {
          // React Native sometimes delivers binary payloads natively as base64 strings if binaryType fails!
          // If JSON parse fails, and it's a large string, it's almost certainly a base64 file chunk.
          console.log(
            `[WS] ◀ JSON Parse failed, assuming Base64 BINARY frame (${event.data.length} characters)`,
          );
          this._emit("binary", event.data);
          return;
        }

        if (msg.type !== "PING" && msg.type !== "PONG") {
          console.log(
            `[WS] ◀ JSON message: ${msg.type}`,
            msg.type === "FILE_META" ||
              msg.type === "FILE_START" ||
              msg.type === "FILE_END"
              ? JSON.stringify(msg.data)
              : "",
          );
        }
        this._handleMessage(msg);
      } catch (error) {
        console.log(`[WS] Message handling error: ${error.message}`);
      }
    };

    this.ws.onerror = (error) => {
      console.log(`[WS] Connection error: ${error.message || "Unknown error"}`);
      if (!this.isConnected) {
        this._notifyStatus("error", error.message);
      }
      this._emit("error", { message: error.message || "Connection failed" }); // Emit error event
    };

    this.ws.onclose = (event) => {
      console.log(`[WS] Disconnected (code: ${event.code})`);
      const wasConnected = this.isConnected;
      this.isConnected = false;
      this.isAuthenticated = false;
      this._stopPing();
      this._notifyStatus("disconnected");

      // Only schedule reconnect if we didn't explicitly disconnect
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this._scheduleReconnect();
      }
    };
  }

  /**
   * Authenticate with stored credentials
   */
  _authenticate() {
    if (!this.authInfo) return;

    const msg = this._createMessage("AUTH", {
      device_id: this.authInfo.deviceId,
      auth_token: this.authInfo.authToken,
      device_name: this.authInfo.deviceName,
    });
    this._send(msg);
  }

  /**
   * Handle incoming message routing
   */
  _handleMessage(msg) {
    // console.log(`[WS] Received: ${msg.type}`);

    switch (msg.type) {
      case "AUTH_RESP":
        this._handleAuthResponse(msg);
        break;
      case "PAIR_RESP":
        this._handlePairResponse(msg);
        break;
      case "TEXT":
        this._emit("text", msg.data);
        break;
      case "CLIPBOARD":
        this._emit("clipboard", msg.data);
        break;
      case "FILE_START":
        this._emit("fileStart", msg.data);
        break;
      case "FILE_META":
        this._emit("fileMeta", msg.data);
        break;
      case "FILE_CHUNK":
        this._emit("fileChunk", msg.data);
        break;
      case "FILE_END":
        this._emit("fileEnd", msg.data);
        break;
      case "PING":
        this._send(this._createMessage("PONG", null));
        break;
      case "PONG":
        // Silently consume server pong replies
        break;
      case "ACK":
        this._emit("ack", msg.data);
        break;
      case "ERROR":
        this._emit("error", msg.data);
        break;
      default:
        console.log(`[WS] Unknown message type: ${msg.type}`);
    }
  }

  _handleAuthResponse(msg) {
    const data = msg.data;
    if (data.success) {
      this.isAuthenticated = true;
      console.log(`[WS] Authenticated with ${data.device_name}`);
      this._notifyStatus("authenticated", data.device_name);
      this._emit("authenticated", data);
    } else {
      console.log(`[WS] Auth failed: ${data.message}`);
      this._notifyStatus("auth_failed", data.message);
      this._emit("authFailed", data);
    }
  }

  _handlePairResponse(msg) {
    this._emit("pairResponse", msg.data);
  }

  /**
   * Send a pairing request via WebSocket
   */
  sendPairRequest(pairingCode, deviceId, deviceName) {
    const msg = this._createMessage("PAIR_REQ", {
      pairing_code: pairingCode,
      device_id: deviceId,
      device_name: deviceName,
    });
    this._send(msg);
  }

  /**
   * Scan the local subnet for mcSync PCs
   */
  async scanForServers(onResult) {
    try {
      const Network = require("expo-network");
      const ip = await Network.getIpAddressAsync();
      if (!ip || ip === "127.0.0.1") return;

      const prefix = ip.substring(0, ip.lastIndexOf(".") + 1);
      console.log(`[WS] Scanning subnet ${prefix}0/24...`);

      const batchSize = 25;
      for (let i = 1; i <= 255; i += batchSize) {
        const promises = [];
        for (let j = i; j < i + batchSize && j <= 255; j++) {
          const testIp = `${prefix}${j}`;
          // Don't scan self
          if (testIp === ip) continue;

          promises.push(
            this._checkServer(testIp, 9090).then((info) => {
              if (info) onResult({ ...info, host: testIp, port: 9090 });
            }),
          );
        }
        await Promise.allSettled(promises);
      }
    } catch (e) {
      console.log(`[WS] Scan error: ${e.message}`);
    }
  }

  async _checkServer(host, port) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000); // Fast timeout for scan

    try {
      const resp = await fetch(`http://${host}:${port}/info`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (resp.ok) {
        const data = await resp.json();
        return {
          device_name: data.device_name || data.name || "Unknown PC",
          device_id: data.device_id || data.id || "unknown",
          ...data,
        };
      }
    } catch (e) {
      clearTimeout(timeoutId);
    }
    return null;
  }

  /**
   * Send a pairing request via standard HTTP (for better compatibility)
   */
  async pairViaHttp(host, port, pairingCode, deviceId, deviceName) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    try {
      const response = await fetch(`http://${host}:${port}/pair-http`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairing_code: pairingCode,
          device_id: deviceId,
          device_name: deviceName,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = await response.json();
      if (data && data.success) return data;
      throw new Error(data.message || "Pairing failed");
    } catch (e) {
      clearTimeout(timeoutId);
      console.log(`[WS] HTTP Pair error: ${e.message}`);
      if (e.name === "AbortError") {
        throw new Error(
          "Connection timed out. Ensure IP is correct and PC is running mcSync.",
        );
      }
      throw e;
    }
  }

  /**
   * Send text to the PC
   */
  sendText(text) {
    const msg = this._createMessage("TEXT", { content: text });
    this._send(msg);
  }

  /**
   * Send clipboard content to PC
   */
  sendClipboard(content) {
    const msg = this._createMessage("CLIPBOARD", {
      content: content,
      source: "phone",
    });
    this._send(msg);
  }

  /**
   * Send chunk acknowledgment
   */
  sendAck(transferId, chunkIndex) {
    const msg = this._createMessage("ACK", {
      transfer_id: transferId,
      chunk: chunkIndex,
    });
    this._send(msg);
  }

  /**
   * Send file start message (legacy)
   */
  sendFileStart(filename, fileSize, transferId, chunkSize = 61440) {
    const msg = this._createMessage("FILE_START", {
      filename,
      file_size: fileSize,
      chunk_size: chunkSize,
      transfer_id: transferId,
    });
    this._send(msg);
  }

  /**
   * Send file metadata (modern binary protocol)
   */
  sendFileMeta(name, size, transferId = null) {
    const msg = this._createMessage("FILE_META", {
      type: "FILE_META",
      name,
      size,
      transfer_id: transferId, // optional but helpful for tracking
    });
    this._send(msg);
    return msg.id;
  }

  /**
   * Send file chunk
   */
  sendFileChunk(transferId, index, data, size) {
    const msg = this._createMessage("FILE_CHUNK", {
      transfer_id: transferId,
      index,
      data, // base64
      size,
    });
    this._send(msg);
  }

  /**
   * Send file end message
   */
  sendFileEnd(transferId, checksum, totalChunks) {
    const msg = this._createMessage("FILE_END", {
      transfer_id: transferId,
      checksum,
      total_chunks: totalChunks,
    });
    this._send(msg);
  }

  /**
   * Register a message handler
   */
  on(event, handler) {
    if (!this.messageHandlers.has(event)) {
      this.messageHandlers.set(event, []);
    }
    this.messageHandlers.get(event).push(handler);
    return () => {
      const handlers = this.messageHandlers.get(event);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      }
    };
  }

  _emit(event, data) {
    const handlers = this.messageHandlers.get(event);
    if (handlers) {
      handlers.forEach((h) => {
        try {
          h(data);
        } catch (e) {
          console.log(`[WS] Handler error: ${e.message}`);
        }
      });
    }
  }

  /**
   * Disconnect and cleanup
   */
  disconnect() {
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent auto-reconnect
    this._stopPing();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.isAuthenticated = false;
    this._notifyStatus("disconnected");
  }

  // --- Internals ---

  _createMessage(type, data) {
    return {
      type,
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      data,
    };
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      console.log(`[WS] Queuing message (not connected): ${msg.type}`);
      this.pendingMessages.push(msg);
    }
  }

  /**
   * Send raw binary data over WebSocket
   * @param {ArrayBuffer|Uint8Array|Blob} data
   */
  sendBinary(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      console.warn(`[WS] Dropping binary frame (not connected)`);
    }
  }

  _flushPending() {
    while (this.pendingMessages.length > 0 && this.isConnected) {
      const msg = this.pendingMessages.shift();
      this._send(msg);
    }
  }

  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log("[WS] Max reconnect attempts reached");
      this._notifyStatus("failed", "Max reconnect attempts reached");
      return;
    }

    const delay = Math.min(
      this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts),
      30000,
    );
    this.reconnectAttempts++;
    console.log(
      `[WS] Reconnecting in ${Math.round(delay)}ms (attempt ${
        this.reconnectAttempts
      })`,
    );
    this._notifyStatus("reconnecting", `Attempt ${this.reconnectAttempts}`);

    this._reconnectTimer = setTimeout(() => {
      this._doConnect();
    }, delay);
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this.isConnected) {
        this._send(this._createMessage("PING", null));
      }
    }, 15000);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }
}

// Singleton instance
const wsService = new WebSocketService();
export default wsService;
