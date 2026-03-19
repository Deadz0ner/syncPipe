/**
 * DeviceStore - Manages persistent storage of paired devices and connection info.
 * Uses AsyncStorage for secure local persistence.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

const KEYS = {
  DEVICE_ID: "@mcsync_device_id",
  DEVICE_NAME: "@mcsync_device_name",
  PAIRED_SERVERS: "@mcsync_paired_servers",
  LAST_SERVER: "@mcsync_last_server",
  SETTINGS: "@mcsync_settings",
  RECEIVE_DIR: "@mcsync_receive_dir",
  DIR_DISPLAY_NAME: "@mcsync_dir_display_name",
};

class DeviceStore {
  constructor() {
    this._cache = {};
  }

  /**
   * Generate a unique device ID if not already set
   */
  async getOrCreateDeviceId() {
    let id = await AsyncStorage.getItem(KEYS.DEVICE_ID);
    if (!id) {
      id = this._generateId();
      await AsyncStorage.setItem(KEYS.DEVICE_ID, id);
    }
    return id;
  }

  /**
   * Get or set the device name
   */
  async getDeviceName() {
    let name = await AsyncStorage.getItem(KEYS.DEVICE_NAME);
    if (!name) {
      name = `Android-${Math.random().toString(36).substr(2, 4)}`;
      await AsyncStorage.setItem(KEYS.DEVICE_NAME, name);
    }
    return name;
  }

  async setDeviceName(name) {
    await AsyncStorage.setItem(KEYS.DEVICE_NAME, name);
  }

  /**
   * Save a paired server
   */
  async savePairedServer(serverInfo) {
    const servers = await this.getPairedServers();
    // Update or add
    const idx = servers.findIndex((s) => s.serverId === serverInfo.serverId);
    if (idx >= 0) {
      servers[idx] = { ...servers[idx], ...serverInfo, updatedAt: Date.now() };
    } else {
      servers.push({
        ...serverInfo,
        pairedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    await AsyncStorage.setItem(KEYS.PAIRED_SERVERS, JSON.stringify(servers));
    await AsyncStorage.setItem(KEYS.LAST_SERVER, JSON.stringify(serverInfo));
    return servers;
  }

  /**
   * Get all paired servers
   */
  async getPairedServers() {
    const data = await AsyncStorage.getItem(KEYS.PAIRED_SERVERS);
    return data ? JSON.parse(data) : [];
  }

  /**
   * Get the last connected server
   */
  async getLastServer() {
    const data = await AsyncStorage.getItem(KEYS.LAST_SERVER);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Remove a paired server
   */
  async removePairedServer(serverId) {
    const servers = await this.getPairedServers();
    const filtered = servers.filter((s) => s.serverId !== serverId);
    await AsyncStorage.setItem(KEYS.PAIRED_SERVERS, JSON.stringify(filtered));
  }

  /**
   * Get app settings
   */
  async getSettings() {
    const data = await AsyncStorage.getItem(KEYS.SETTINGS);
    return data
      ? JSON.parse(data)
      : {
          clipboardSync: true,
          autoConnect: true,
          notifications: true,
        };
  }

  /**
   * Save app settings
   */
  async saveSettings(settings) {
    await AsyncStorage.setItem(KEYS.SETTINGS, JSON.stringify(settings));
  }

  /**
   * Receive Directory Settings
   */
  async getReceiveDir() {
    const uri = await AsyncStorage.getItem(KEYS.RECEIVE_DIR);
    const name = await AsyncStorage.getItem(KEYS.DIR_DISPLAY_NAME);
    return { uri, name };
  }

  async setReceiveDir(uri, displayName) {
    if (uri) {
      await AsyncStorage.setItem(KEYS.RECEIVE_DIR, uri);
    } else {
      await AsyncStorage.removeItem(KEYS.RECEIVE_DIR);
    }

    if (displayName) {
      await AsyncStorage.setItem(KEYS.DIR_DISPLAY_NAME, displayName);
    } else {
      await AsyncStorage.removeItem(KEYS.DIR_DISPLAY_NAME);
    }
  }

  /**
   * Clear all data (for debugging/reset)
   */
  async clearAll() {
    const keys = Object.values(KEYS);
    await AsyncStorage.multiRemove(keys);
  }

  _generateId() {
    const chars = "abcdef0123456789";
    let id = "";
    for (let i = 0; i < 32; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
  }
}

const deviceStore = new DeviceStore();
export default deviceStore;
