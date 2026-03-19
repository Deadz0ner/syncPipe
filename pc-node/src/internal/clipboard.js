const clipboardy = require("clipboardy");
const EventEmitter = require("events");

class ClipboardMonitor extends EventEmitter {
  constructor(interval = 1500, logger = null) {
    super();
    this.interval = interval;
    this.lastContent = "";
    this.timer = null;
    this.logger = logger || {
      info: (...args) => console.log(...args),
      warn: (...args) => console.warn(...args),
      error: (...args) => console.error(...args),
    };
  }

  async start() {
    // Polling disabled to prevent system lag. Clipboard sync is now on-demand.
    this.logger.info(`[Clipboard] Monitor available (On-Demand Mode)`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info(`[Clipboard] Monitor stopped`);
    }
  }

  setContent(content) {
    this.lastContent = content;
  }

  async write(content) {
    try {
      this.setContent(content);
      const writeFn = clipboardy.write || clipboardy.default?.write;
      if (typeof writeFn !== "function") {
        throw new Error("clipboardy.write is not available");
      }
      await writeFn(content);
    } catch (err) {
      this.logger.error(`[Clipboard] Failed to write: ${err.message}`);
    }
  }

  async read() {
    try {
      const readFn = clipboardy.read || clipboardy.default?.read;
      if (typeof readFn !== "function") {
        return "";
      }
      return await readFn();
    } catch (err) {
      return "";
    }
  }
}

module.exports = ClipboardMonitor;
