const crypto = require("crypto");
const fs = require("fs-extra");
const path = require("path");

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.storePath = path.join(dataDir, "devices.enc");
    this.keyPath = path.join(dataDir, "store.key");
    this.devices = {};
    this.key = null;
  }

  static async create(dataDir) {
    const store = new Store(dataDir);
    await fs.ensureDir(dataDir);
    await store.loadOrGenerateKey();

    if (await fs.pathExists(store.storePath)) {
      await store.load();
    }

    return store;
  }

  async loadOrGenerateKey() {
    if (await fs.pathExists(this.keyPath)) {
      const data = await fs.readFile(this.keyPath, "utf8");
      this.key = Buffer.from(data, "hex");
    } else {
      this.key = crypto.randomBytes(32);
      await fs.writeFile(this.keyPath, this.key.toString("hex"), {
        mode: 0o600,
      });
    }
  }

  async encrypt(plaintext) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, nonce);
    let encrypted = cipher.update(plaintext, "utf8");
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, encrypted, tag]);
  }

  async decrypt(ciphertext) {
    const nonce = ciphertext.slice(0, 12);
    const tag = ciphertext.slice(ciphertext.length - 16);
    const content = ciphertext.slice(12, ciphertext.length - 16);

    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(content, null, "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }

  async load() {
    try {
      const ciphertext = await fs.readFile(this.storePath);
      const plaintext = await this.decrypt(ciphertext);
      const data = JSON.parse(plaintext);
      this.devices = data.devices || {};
    } catch (err) {
      console.error(`[Store] Failed to load store: ${err.message}`);
      this.devices = {};
    }
  }

  async save() {
    const data = JSON.stringify({ devices: this.devices }, null, 2);
    const ciphertext = await this.encrypt(data);
    await fs.writeFile(this.storePath, ciphertext, { mode: 0o600 });
  }

  async addDevice(device) {
    this.devices[device.device_id] = device;
    await this.save();
  }

  getDevice(deviceId) {
    return this.devices[deviceId];
  }

  listDevices() {
    return Object.values(this.devices);
  }

  async removeDevice(deviceId) {
    delete this.devices[deviceId];
    await this.save();
  }

  async updateLastSeen(deviceId, ip, port) {
    if (this.devices[deviceId]) {
      this.devices[deviceId].last_seen = new Date().toISOString();
      this.devices[deviceId].last_ip = ip;
      this.devices[deviceId].last_port = port;
      await this.save();
    }
  }

  validateAuth(deviceId, authToken) {
    const device = this.devices[deviceId];
    if (!device) return false;

    const expected = crypto
      .createHash("sha256")
      .update(device.auth_token)
      .digest();
    const provided = crypto.createHash("sha256").update(authToken).digest();

    try {
      return crypto.timingSafeEqual(expected, provided);
    } catch (e) {
      return false;
    }
  }

  static generateAuthToken() {
    return crypto.randomBytes(32).toString("hex");
  }

  static generatePairingCode() {
    const code = crypto.randomInt(0, 1000000);
    return code.toString().padStart(6, "0");
  }

  static generateDeviceID() {
    return crypto.randomBytes(16).toString("hex");
  }
}

module.exports = Store;
