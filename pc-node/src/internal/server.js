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
  constructor(cfg, store) {
    this.cfg = cfg;
    this.store = store;
    this.clients = new Map();
    this.pairingCode = null;
    this.pairingActive = false;
    this.transfers = new Map();

    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocket.Server({ server: this.server, path: "/ws" });

    this.setupRoutes();
    this.setupWebSocket();
    this.pingInterval = null;
  }

  async start() {
    await this.cfg.ensureDirs();

    this.discovery = new DiscoveryService(this.cfg.port, this.cfg.device_name);
    this.discovery.start();

    return new Promise((resolve) => {
      this.server.listen(this.cfg.port, "0.0.0.0", () => {
        const localIP = DiscoveryService.getLocalIP();
        console.log(
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
    console.log(`[Server] Shutdown complete`);
  }

  setupRoutes() {
    this.app.use(express.json());

    this.app.get("/health", (req, res) => res.json({ status: "ok" }));

    this.app.get("/info", (req, res) => {
      res.json({
        device_name: this.cfg.device_name,
        device_id: this.cfg.device_id,
        version: "1.0.0",
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

      console.log(
        `[Server] Device paired via HTTP: ${device.device_name} (${device.device_id.slice(0, 8)})`,
      );
    });
  }

  setupWebSocket() {
    this.wss.on("connection", (ws, req) => {
      const remoteAddr = req.socket.remoteAddress;
      console.log(`[Server] New connection from ${remoteAddr}`);

      const client = { ws, authed: false, deviceID: "", deviceName: "" };

      ws.on("message", async (data) => {
        try {
          const msg = Message.decode(data.toString());
          await this.handleMessage(client, msg, remoteAddr);
        } catch (err) {
          console.error(`[Server] Message error: ${err.message}`);
        }
      });

      ws.on("close", () => {
        if (client.deviceID) {
          this.clients.delete(client.deviceID);
          console.log(
            `[Server] Device ${client.deviceName} (${client.deviceID.slice(0, 8)}) disconnected`,
          );
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
        await this.handleFileStart(client, msg);
        break;
      case MessageTypes.FILE_CHUNK:
        await this.handleFileChunk(client, msg);
        break;
      case MessageTypes.FILE_END:
        await this.handleFileEnd(client, msg);
        break;
      case MessageTypes.PONG:
        break;
      default:
        console.log(`[Server] Unknown message type: ${msg.type}`);
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

    console.log(
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

    console.log(
      `[Server] Device paired: ${device_name} (${device_id.slice(0, 8)})`,
    );
  }

  handleText(client, msg) {
    if (!client.authed) return;
    console.log(`[Text] From ${client.deviceName}: ${msg.data.content}`);
    this.sendMessage(
      client,
      new Message(MessageTypes.ACK, { message_id: msg.id, status: "ok" }),
    );
  }

  async handleFileStart(client, msg) {
    if (!client.authed) return;
    const { filename, file_size, transfer_id } = msg.data;
    const destPath = path.join(this.cfg.receive_dir, filename);

    let finalPath = destPath;
    let counter = 1;
    while (await fs.pathExists(finalPath)) {
      const ext = path.extname(destPath);
      const base = path.basename(destPath, ext);
      finalPath = path.join(this.cfg.receive_dir, `${base}_${counter}${ext}`);
      counter++;
    }

    const stream = fs.createWriteStream(finalPath);
    this.transfers.set(transfer_id, {
      filename: path.basename(finalPath),
      stream,
      hash: crypto.createHash("sha256"),
      received: 0,
      start_time: Date.now(),
    });

    console.log(
      `[File] Starting receive: ${path.basename(finalPath)} (${file_size} bytes)`,
    );
    this.sendMessage(
      client,
      new Message(MessageTypes.ACK, { message_id: msg.id, status: "ok" }),
    );
  }

  async handleFileChunk(client, msg) {
    if (!client.authed) return;
    const { transfer_id, data } = msg.data;
    const transfer = this.transfers.get(transfer_id);
    if (transfer) {
      const buffer = Buffer.from(data, "base64");
      transfer.stream.write(buffer);
      transfer.hash.update(buffer);
      transfer.received++;
    }
  }

  async handleFileEnd(client, msg) {
    if (!client.authed) return;
    const { transfer_id, checksum } = msg.data;
    const transfer = this.transfers.get(transfer_id);
    if (transfer) {
      transfer.stream.end();
      const actualChecksum = transfer.hash.digest("hex");

      if (checksum && checksum !== actualChecksum) {
        console.warn(
          `[File] WARNING: Checksum mismatch for ${transfer.filename}`,
        );
      }

      this.transfers.delete(transfer_id);
      const elapsed = Date.now() - transfer.start_time;
      console.log(
        `[File] Received: ${transfer.filename} (${transfer.received} chunks in ${elapsed}ms)`,
      );
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
          console.log(`[Server] Pairing code expired`);
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
    const chunkSize = 64 * 1024;

    this.sendMessage(
      client,
      new Message(MessageTypes.FILE_START, {
        filename: path.basename(filePath),
        file_size: stats.size,
        chunk_size: chunkSize,
        transfer_id: transferID,
      }),
    );

    const buffer = Buffer.alloc(chunkSize);
    const fd = await fs.open(filePath, "r");
    let bytesRead;
    let index = 0;
    const hash = crypto.createHash("sha256");

    while (
      (bytesRead = (await fs.read(fd, buffer, 0, chunkSize, null)).bytesRead) >
      0
    ) {
      const data = buffer.slice(0, bytesRead);
      hash.update(data);
      this.sendMessage(
        client,
        new Message(MessageTypes.FILE_CHUNK, {
          transfer_id: transferID,
          index: index++,
          data: data.toString("base64"),
          size: bytesRead,
        }),
      );
      await new Promise((r) => setTimeout(r, 5));
    }
    await fs.close(fd);

    this.sendMessage(
      client,
      new Message(MessageTypes.FILE_END, {
        transfer_id: transferID,
        checksum: hash.digest("hex"),
        total_chunks: index,
      }),
    );

    console.log(
      `[File] Sent: ${path.basename(filePath)} (${index} chunks, ${stats.size} bytes)`,
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
  }

  emit(event, ...args) {
    if (event === "clipboard" && this._onClipboard) this._onClipboard(...args);
  }
}

module.exports = Server;
