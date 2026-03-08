const clipboardy = require("clipboardy");
const EventEmitter = require("events");

class ClipboardMonitor extends EventEmitter {
  constructor(interval = 1500) {
    super();
    this.interval = interval;
    this.lastContent = "";
    this.timer = null;
  }

  async start() {
    try {
      this.lastContent = await clipboardy.read();
    } catch (err) {
      // Ignore initial read errors
    }

    this.timer = setInterval(async () => {
      try {
        const content = await clipboardy.read();
        if (content && content !== this.lastContent) {
          this.lastContent = content;
          this.emit("change", content);
        }
      } catch (err) {}
    }, this.interval);

    console.log(
      `[Clipboard] Monitor started (polling interval: ${this.interval}ms)`,
    );
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log(`[Clipboard] Monitor stopped`);
    }
  }

  setContent(content) {
    this.lastContent = content;
  }

  async write(content) {
    try {
      this.setContent(content);
      await clipboardy.write(content);
    } catch (err) {
      console.error(`[Clipboard] Failed to write: ${err.message}`);
    }
  }

  async read() {
    try {
      return await clipboardy.read();
    } catch (err) {
      return "";
    }
  }
}

module.exports = ClipboardMonitor;
