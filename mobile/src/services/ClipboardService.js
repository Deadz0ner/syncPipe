/**
 * ClipboardService - Monitors clipboard changes and syncs with the PC.
 */

import * as Clipboard from "expo-clipboard";
import wsService from "./WebSocketService";

class ClipboardService {
  constructor() {
    this.lastContent = "";
    this.monitoring = false;
    this._unsubscribe = null;
  }

  /**
   * Start listening for clipboard syncs from PC
   */
  start() {
    if (this.monitoring) return;
    this.monitoring = true;

    // Listen for clipboard updates from PC
    this._unsubscribe = wsService.on("clipboard", async (data) => {
      if (data && data.content) {
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
   * Stop monitoring and cleanup
   */
  stop() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
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
