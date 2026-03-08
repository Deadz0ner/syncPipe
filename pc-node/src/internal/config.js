const os = require("os");
const path = require("path");
const fs = require("fs-extra");

const AppName = "mcsync";
const DefaultPort = 9090;
const ServiceType = "_mcsync._tcp";
const ChunkSize = 64 * 1024; // 64KB
const PingInterval = 15; // seconds
const MaxMessageSize = 1024 * 1024; // 1MB

class Config {
  constructor() {
    const homeDir = os.homedir();
    const hostname = os.hostname();
    this.port = DefaultPort;
    this.device_name = hostname;
    this.device_id = "";
    this.data_dir = path.join(homeDir, ".mcsync");
    this.receive_dir = path.join(this.data_dir, "received");
    this.clipboard_sync = true;
  }

  static async load() {
    const cfg = new Config();
    const configPath = Config.getPath();

    if (await fs.pathExists(configPath)) {
      try {
        const data = await fs.readJson(configPath);
        Object.assign(cfg, data);
      } catch (err) {
        console.error(`[Config] Failed to parse config: ${err.message}`);
      }
    } else {
      await cfg.save();
    }

    return cfg;
  }

  async save() {
    const configPath = Config.getPath();
    await fs.ensureDir(path.dirname(configPath));
    await fs.ensureDir(this.receive_dir);
    await fs.writeJson(configPath, this, { spaces: 2 });
  }

  async ensureDirs() {
    await fs.ensureDir(this.data_dir);
    await fs.ensureDir(this.receive_dir);
  }

  static getPath() {
    return path.join(os.homedir(), ".mcsync", "config.json");
  }
}

module.exports = {
  Config,
  Constants: {
    AppName,
    DefaultPort,
    ServiceType,
    ChunkSize,
    PingInterval,
    MaxMessageSize,
  },
};
