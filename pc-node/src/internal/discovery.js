const mdns = require("multicast-dns")();
const os = require("os");

class DiscoveryService {
  constructor(port, deviceName, logger = null) {
    this.port = port;
    this.deviceName = deviceName;
    this.serviceType = "_mcsync._tcp.local";
    this.logger = logger || {
      info: (...args) => console.log(...args),
      warn: (...args) => console.warn(...args),
      error: (...args) => console.error(...args),
    };
  }

  start() {
    mdns.on("query", (query) => {
      if (query.questions.some((q) => q.name === this.serviceType)) {
        this.respond();
      }
    });

    this.logger.info(
      `[mDNS] Advertising ${this.serviceType} on port ${this.port}`,
    );
  }

  respond() {
    const ips = DiscoveryService.getLocalIPs();
    const answers = [
      {
        name: this.serviceType,
        type: "PTR",
        data: `${this.deviceName}.${this.serviceType}`,
      },
      {
        name: `${this.deviceName}.${this.serviceType}`,
        type: "SRV",
        data: {
          port: this.port,
          target: `${os.hostname()}.local`,
        },
      },
      {
        name: `${this.deviceName}.${this.serviceType}`,
        type: "TXT",
        data: [`device=${this.deviceName}`, `version=1.0.0`],
      },
    ];

    ips.forEach((ip) => {
      answers.push({
        name: `${os.hostname()}.local`,
        type: "A",
        data: ip,
      });
    });

    mdns.respond({ answers });
  }

  stop() {
    mdns.destroy();
    this.logger.info(`[mDNS] Service stopped`);
  }

  static getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) {
          ips.push(iface.address);
        }
      }
    }
    return ips;
  }

  static getLocalIP() {
    const ips = DiscoveryService.getLocalIPs();
    return ips[0] || "127.0.0.1";
  }
}

module.exports = DiscoveryService;
