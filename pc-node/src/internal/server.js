const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const { Message, MessageTypes } = require("./protocol");
const DiscoveryService = require("./discovery");
const Store = require("./store");

class Server {
  constructor(cfg, store, logger = null) {
    this.cfg = cfg;
    this.store = store;
    this.clients = new Map();
    this.pairingCode = null;
    this.pairingActive = false;
    this.transfers = new Map();
    this.ackCallbacks = new Map();

    this.logger = logger || {
      info: (...args) => console.log(...args),
      warn: (...args) => console.warn(...args),
      error: (...args) => console.error(...args),
    };

    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocket.Server({ server: this.server, path: "/ws" });

    this.setupRoutes();
    this.setupWebSocket();
    this.pingInterval = null;
  }

  async start() {
    await this.cfg.ensureDirs();

    this.discovery = new DiscoveryService(
      this.cfg.port,
      this.cfg.device_name,
      this.logger,
    );
    this.discovery.start();

    return new Promise((resolve) => {
      this.server.listen(this.cfg.port, "0.0.0.0", () => {
        const localIP = DiscoveryService.getLocalIP();
        this.logger.info(
          `[Server] Listening on 0.0.0.0:${this.cfg.port} (Accessible at ${localIP}:${this.cfg.port})`,
        );
        this.startPingLoop();
        resolve();
      });
    });
  }

  stop() {
    if (this.discovery) this.discovery.stop();
    if (this.pingInterval) clearInterval(this.pingInterval);

    this.clients.forEach((client) => client.ws.close());
    this.server.close();
    this.logger.info(`[Server] Shutdown complete`);
  }

  setupRoutes() {
    this.app.use(express.json());

    this.app.get("/health", (req, res) => res.json({ status: "ok" }));

    this.app.get("/info", (req, res) => {
      res.json({
        device_name: this.cfg.device_name,
        device_id: this.cfg.device_id,
        version: "1.0.0",
        port: this.cfg.port,
        connected: this.clients.size,
      });
    });

    this.app.post("/pair-http", async (req, res) => {
      const payload = req.body;
      if (!this.pairingActive || payload.pairing_code !== this.pairingCode) {
        return res.json({
          success: false,
          message: "Invalid or expired pairing code",
        });
      }

      const authToken = Store.generateAuthToken();
      const device = {
        device_id: payload.device_id,
        device_name: payload.device_name,
        auth_token: authToken,
        paired_at: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        last_ip: req.ip,
      };

      await this.store.addDevice(device);
      this.pairingActive = false;
      this.pairingCode = null;

      res.json({
        success: true,
        message: "Paired successfully",
        auth_token: authToken,
        device_name: this.cfg.device_name,
        server_id: this.cfg.device_id,
      });

      this.logger.info(
        `[Server] Device paired via HTTP: ${device.device_name} (${device.device_id.slice(0, 8)})`,
      );
    });
  }

  setupWebSocket() {
    this.wss.on("connection", (ws, req) => {
      const remoteAddr = req.socket.remoteAddress;
      this.logger.info(`[Server] New connection from ${remoteAddr}`);

      const client = { ws, authed: false, deviceID: "", deviceName: "" };

      ws.on("message", async (data, isBinary) => {
        try {
          if (isBinary) {
            await this.handleBinaryChunk(client, data);
            return;
          }
          const msg = Message.decode(data.toString());
          await this.handleMessage(client, msg, remoteAddr);
        } catch (err) {
          this.logger.error(`[Server] Message error: ${err.message}`);
        }
      });

      ws.on("close", () => {
        if (client.deviceID) {
          if (this.clients.get(client.deviceID) === client) {
            this.clients.delete(client.deviceID);
            this.logger.info(
              `[Server] Device ${client.deviceName} (${client.deviceID.slice(0, 8)}) disconnected`,
            );
          }
        }
      });
    });
  }

  async handleMessage(client, msg, remoteAddr) {
    switch (msg.type) {
      case MessageTypes.AUTH:
        await this.handleAuth(client, msg, remoteAddr);
        break;
      case MessageTypes.PAIR_REQ:
        await this.handlePairRequest(client, msg, remoteAddr);
        break;
      case MessageTypes.TEXT:
        this.handleText(client, msg);
        break;
      case MessageTypes.CLIPBOARD:
        this.emit("clipboard", msg.data.content);
        break;
      case MessageTypes.FILE_START:
      case MessageTypes.FILE_META:
        await this.handleFileMeta(client, msg);
        break;
      case MessageTypes.FILE_CHUNK:
        // Deprecated Base64 chunk handler — still here for legacy fallback but should be removed
        await this.handleFileChunk(client, msg);
        break;
      case MessageTypes.FILE_END:
        await this.handleFileEnd(client, msg);
        break;
      case MessageTypes.PING:
        this.sendMessage(client, new Message(MessageTypes.PONG));
        break;
      case MessageTypes.PONG:
        break;
      case MessageTypes.ACK:
        if (msg.data && msg.data.transfer_id) {
          const cb = this.ackCallbacks.get(msg.data.transfer_id);
          if (cb) cb(msg.data.chunk);
        }
        break;
      default:
        this.logger.info(`[Server] Unknown message type: ${msg.type}`);
    }
  }

  async handleAuth(client, msg, remoteAddr) {
    const { device_id, auth_token, device_name } = msg.data;
    if (!this.store.validateAuth(device_id, auth_token)) {
      return this.sendMessage(
        client,
        new Message(MessageTypes.AUTH_RESP, {
          success: false,
          message: "Authentication failed",
        }),
      );
    }

    client.deviceID = device_id;
    client.deviceName = device_name;
    client.authed = true;
    const existingClient = this.clients.get(device_id);
    if (existingClient && existingClient !== client) {
      existingClient.ws.close();
    }
    this.clients.set(device_id, client);

    await this.store.updateLastSeen(device_id, remoteAddr, this.cfg.port);

    this.sendMessage(
      client,
      new Message(MessageTypes.AUTH_RESP, {
        success: true,
        message: "Authenticated",
        device_name: this.cfg.device_name,
      }),
    );

    this.logger.info(
      `[Server] Device authenticated: ${device_name} (${device_id.slice(0, 8)})`,
    );
  }

  async handlePairRequest(client, msg, remoteAddr) {
    const { pairing_code, device_name, device_id } = msg.data;
    if (!this.pairingActive || pairing_code !== this.pairingCode) {
      return this.sendMessage(
        client,
        new Message(MessageTypes.PAIR_RESP, {
          success: false,
          message: "Invalid or expired pairing code",
        }),
      );
    }

    const authToken = Store.generateAuthToken();
    const device = {
      device_id,
      device_name,
      auth_token: authToken,
      paired_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      last_ip: remoteAddr,
    };

    await this.store.addDevice(device);
    this.pairingActive = false;
    this.pairingCode = null;

    client.deviceID = device_id;
    client.deviceName = device_name;
    client.authed = true;
    const existingClient = this.clients.get(device_id);
    if (existingClient && existingClient !== client) {
      existingClient.ws.close();
    }
    this.clients.set(device_id, client);

    this.sendMessage(
      client,
      new Message(MessageTypes.PAIR_RESP, {
        success: true,
        message: "Paired successfully",
        auth_token: authToken,
        device_name: this.cfg.device_name,
        server_id: this.cfg.device_id,
      }),
    );

    this.logger.info(
      `[Server] Device paired: ${device_name} (${device_id.slice(0, 8)})`,
    );
  }

  handleText(client, msg) {
    if (!client.authed) return;
    const content = msg.data.content || "";
    const lines = content.split("\n");
    let output = `\n  ╭─── 💬 Text from ${client.deviceName} ───\n`;
    lines.forEach((line) => {
      output += `  │ ${line}\n`;
    });
    output += `  ╰────────────────────────────────────────\n`;
    this.logger.info(output);

    this.emit("text", content);
    this.sendMessage(
      client,
      new Message(MessageTypes.ACK, { message_id: msg.id, status: "ok" }),
    );
  }

  async handleFileMeta(client, msg) {
    if (!client.authed) return;
    const { filename, file_size, transfer_id, name, size } = msg.data;
    // Handle both protocol variants: start (legacy) and meta (new spec)
    const fileName = filename || name;
    const fileSize = file_size || size;
    const transferId = transfer_id || "binary_transfer"; // spec doesn't strictly define transfer_id for meta

    const destPath = path.join(this.cfg.receive_dir, fileName);

    let finalPath = destPath;
    let counter = 1;
    while (await fs.pathExists(finalPath)) {
      const ext = path.extname(destPath);
      const base = path.basename(destPath, ext);
      finalPath = path.join(this.cfg.receive_dir, `${base}_${counter}${ext}`);
      counter++;
    }

    const stream = fs.createWriteStream(finalPath);
    const transfer = {
      transferId,
      filename: path.basename(finalPath),
      stream,
      hash: crypto.createHash("sha256"),
      received: 0,
      totalBytes: 0,
      expectedSize: fileSize,
      start_time: Date.now(),
    };

    // Store in global map for lookups by ID and on client for raw binary frames
    this.transfers.set(transferId, transfer);
    client.activeTransfer = transfer;

    this.logger.info(
      `[File] Starting binary receive: ${path.basename(finalPath)} (${fileSize} bytes)`,
    );
    this.logger.info(`[File] 📂 Saving to: ${path.dirname(finalPath)}/`);
    this.sendMessage(
      client,
      new Message(MessageTypes.ACK, { message_id: msg.id, status: "ok" }),
    );
  }

  async handleBinaryChunk(client, data) {
    if (!client.authed || !client.activeTransfer) {
      this.logger.warn(`[File] Received binary frame but no active transfer`);
      return;
    }

    const transfer = client.activeTransfer;
    transfer.hash.update(data);
    transfer.received++;
    transfer.totalBytes += data.length;

    // Await backpressure
    const canContinue = transfer.stream.write(data);
    if (!canContinue) {
      await new Promise((resolve) => transfer.stream.once("drain", resolve));
    }

    // Send ACK back to mobile
    this.sendMessage(
      client,
      new Message(MessageTypes.ACK, {
        transfer_id: transfer.transferId,
        chunk: transfer.received,
      }),
    );
  }

  async handleFileStart(client, msg) {
    return this.handleFileMeta(client, msg);
  }

  async handleFileChunk(client, msg) {
    if (!client.authed) return;
    const { transfer_id, data } = msg.data;
    const transfer = this.transfers.get(transfer_id);
    if (!transfer) return;

    const buffer = Buffer.from(data, "base64");
    transfer.hash.update(buffer);
    transfer.received++;

    // Await backpressure: if write() returns false, wait for 'drain' before continuing.
    // This prevents out-of-order writes and buffer overflow on large files.
    const canContinue = transfer.stream.write(buffer);
    if (!canContinue) {
      await new Promise((resolve) => transfer.stream.once("drain", resolve));
    }
  }

  async handleFileEnd(client, msg) {
    if (!client.authed) return;
    const { transfer_id, checksum } = msg.data;
    const transfer = this.transfers.get(transfer_id) || client.activeTransfer;

    if (transfer) {
      // Wait for the write stream to fully flush
      await new Promise((resolve, reject) => {
        transfer.stream.end((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      const actualChecksum = transfer.hash.digest("hex");

      if (checksum && checksum !== actualChecksum) {
        this.logger.warn(
          `[File] WARNING: Checksum mismatch for ${transfer.filename}. Expected ${checksum}, got ${actualChecksum}`,
        );
      }

      const elapsed = Date.now() - transfer.start_time;
      this.logger.info(
        `[File] Received: ${transfer.filename} (${transfer.totalBytes || 0} bytes in ${transfer.received} chunks, ${elapsed}ms)`,
      );
      this.logger.info(
        `[File] 📂 Saved to: ${this.cfg.receive_dir}/${transfer.filename}`,
      );

      // Verify file size if we have an expected size
      if (
        transfer.expectedSize &&
        transfer.totalBytes !== transfer.expectedSize
      ) {
        this.logger.warn(
          `[File] Size mismatch: ${transfer.totalBytes} received vs ${transfer.expectedSize} expected`,
        );
      }

      this.transfers.delete(transfer.transferId);
      client.activeTransfer = null;

      this.sendMessage(
        client,
        new Message(MessageTypes.ACK, { message_id: msg.id, status: "ok" }),
      );
    }
  }

  async startPairing() {
    this.pairingCode = Store.generatePairingCode();
    this.pairingActive = true;
    setTimeout(
      () => {
        if (this.pairingActive) {
          this.pairingActive = false;
          this.pairingCode = null;
          this.logger.info(`[Server] Pairing code expired`);
        }
      },
      5 * 60 * 1000,
    );
    return this.pairingCode;
  }

  sendMessage(client, msg) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(msg.encode());
    }
  }

  sendBinary(client, data) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }

  async sendText(deviceID, text) {
    const client = deviceID
      ? this.clients.get(deviceID)
      : Array.from(this.clients.values())[0];
    if (!client) throw new Error("No devices connected");
    this.sendMessage(client, new Message(MessageTypes.TEXT, { content: text }));
  }

  async sendClipboard(deviceID, content) {
    const client = deviceID
      ? this.clients.get(deviceID)
      : Array.from(this.clients.values())[0];
    if (!client) throw new Error("No devices connected");
    this.sendMessage(
      client,
      new Message(MessageTypes.CLIPBOARD, { content, source: "pc" }),
    );
  }

  async sendFile(deviceID, filePath) {
    const client = deviceID
      ? this.clients.get(deviceID)
      : Array.from(this.clients.values())[0];
    if (!client) throw new Error("No devices connected");

    const stats = await fs.stat(filePath);
    const transferID = Store.generateDeviceID();
    const chunkSize = 61440; // 60KB (multiple of 3 to avoid cross-chunk base64 padding)

    // Step 1: Send FILE_META (JSON)
    this.logger.info(
      `[File] >>> Sending FILE_META: name=${path.basename(filePath)}, size=${stats.size}, transfer_id=${transferID}`,
    );
    this.sendMessage(
      client,
      new Message(MessageTypes.FILE_META, {
        name: path.basename(filePath),
        size: stats.size,
        transfer_id: transferID,
      }),
    );

    // Setup ACK callback
    let activeAckCallback = null;
    this.ackCallbacks.set(transferID, (chunkIndex) => {
      if (activeAckCallback) activeAckCallback(chunkIndex);
    });

    // Wait for the mobile to process FILE_META and set up the receive
    await new Promise((resolve, reject) => {
      let resolved = false;
      let timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.logger.warn(`[File] ⚠️ Readiness ACK timeout`);
          reject(new Error("Readiness ACK timeout"));
        }
      }, 10000);

      activeAckCallback = (chunkIndex) => {
        if (!resolved && chunkIndex === 0) {
          resolved = true;
          clearTimeout(timer);
          resolve();
        } else if (!resolved) {
          // It's possible we get index > 0 if there's a protocol mismatch, but we expect 0 here
        }
      };
    });

    const buffer = Buffer.alloc(chunkSize);
    const fd = await fs.open(filePath, "r");
    let bytesRead;
    let index = 0;
    const hash = crypto.createHash("sha256");
    const totalChunks = Math.ceil(stats.size / chunkSize);

    this.logger.info(
      `[File] Sending binary: ${path.basename(filePath)} (${stats.size} bytes)`,
    );

    while (
      (bytesRead = (await fs.read(fd, buffer, 0, chunkSize, null)).bytesRead) >
      0
    ) {
      const data = buffer.slice(0, bytesRead);
      hash.update(data);

      // Step 2 & 3: Send binary frames
      this.sendBinary(client, data);
      index++;

      if (index <= 3 || index % 50 === 0 || index === totalChunks) {
        this.logger.info(
          `[File] Sent chunk #${index} (${bytesRead} bytes)${index === totalChunks ? " (Last chunk)" : ""}`,
        );
      }

      // Wait for ACK
      try {
        await new Promise((resolve, reject) => {
          let resolved = false;
          let timer = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              this.logger.warn(`[File] ⚠️ ACK timeout for chunk #${index}`);
              reject(new Error(`ACK timeout for chunk #${index}`));
            }
          }, 8000);

          activeAckCallback = (ackIndex) => {
            if (!resolved && ackIndex === index) {
              resolved = true;
              clearTimeout(timer);
              resolve();
            }
          };
        });
      } catch (err) {
        this.logger.error(`[File] Transfer aborted: ${err.message}`);
        await fs.close(fd);
        this.ackCallbacks.delete(transferID);
        throw err;
      }
    }
    await fs.close(fd);
    this.ackCallbacks.delete(transferID);

    // Step 5: Send FILE_END (JSON)
    this.logger.info(
      `[File] >>> Sending FILE_END: transfer_id=${transferID}, total_chunks=${index}`,
    );
    this.sendMessage(
      client,
      new Message(MessageTypes.FILE_END, {
        transfer_id: transferID,
        checksum: hash.digest("hex"),
        total_chunks: index,
      }),
    );

    this.logger.info(
      `[File] Sent: ${path.basename(filePath)} (${index} chunks, ${stats.size} bytes) ✓`,
    );
  }

  startPingLoop() {
    this.pingInterval = setInterval(() => {
      const msg = new Message(MessageTypes.PING);
      this.clients.forEach((client) => {
        if (client.authed) this.sendMessage(client, msg);
      });
    }, 15000);
  }

  getConnectedDevices() {
    return Array.from(this.clients.keys());
  }

  on(event, callback) {
    if (event === "clipboard") this._onClipboard = callback;
    if (event === "text") this._onText = callback;
    if (event === "ack") this._onAck = callback;
  }

  emit(event, ...args) {
    if (event === "clipboard" && this._onClipboard) this._onClipboard(...args);
    if (event === "text" && this._onText) this._onText(...args);
    if (event === "ack" && this._onAck) this._onAck(...args);
  }
}

module.exports = Server;
