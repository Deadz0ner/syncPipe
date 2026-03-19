/**
 * ClipboardService - Monitors clipboard changes and syncs with the PC.
 */

import * as Clipboard from "expo-clipboard";
import wsService from "./WebSocketService";

class ClipboardService {
  constructor() {
    this.lastContent = "";
    this.monitoring = false;
    this._interval = null;
    this._ignoreNext = false;
  }

  /**
   * Start listening for clipboard syncs from PC
   */
  start() {
    if (this.monitoring) return;
    this.monitoring = true;

    // We no longer automatically poll/sync out every second.
    // Listen for clipboard from PC
    wsService.on("clipboard", async (data) => {
      if (data && data.content) {
        this._ignoreNext = true; // Prevent echo
        this.lastContent = data.content;
        await Clipboard.setStringAsync(data.content);
        console.log(
          `[Clipboard] Received from PC: ${data.content.substring(0, 50)}...`,
        );
      }
    });

    console.log("[Clipboard] Sync handler listening");
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this.monitoring = false;
    console.log("[Clipboard] Monitoring stopped");
  }

  /**
   * Manually send current clipboard to PC
   */
  async sendCurrent() {
    try {
      const content = await Clipboard.getStringAsync();
      if (content && wsService.isAuthenticated) {
        wsService.sendClipboard(content);
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }
}

const clipboardService = new ClipboardService();
export default clipboardService;
