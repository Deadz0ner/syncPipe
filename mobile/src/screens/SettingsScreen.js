/**
 * SettingsScreen - App settings and paired device management.
 */

import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Switch,
  Alert,
  ScrollView,
  StatusBar,
  TextInput,
  Platform,
} from "react-native";
import Constants from "expo-constants";
import * as FS from "expo-file-system/legacy";
import deviceStore from "../stores/DeviceStore";
import wsService from "../services/WebSocketService";

const SettingsScreen = ({ navigation }) => {
  const [deviceName, setDeviceName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [pairedServers, setPairedServers] = useState([]);
  const [settings, setSettings] = useState({
    clipboardSync: true,
    autoConnect: true,
    notifications: true,
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const name = await deviceStore.getDeviceName();
    setDeviceName(name);

    const servers = await deviceStore.getPairedServers();
    setPairedServers(servers);

    const s = await deviceStore.getSettings();
    setSettings(s);
  };

  const handleSaveName = async () => {
    if (deviceName.trim()) {
      await deviceStore.setDeviceName(deviceName.trim());
      setEditingName(false);
    }
  };

  const handleToggleSetting = async (key) => {
    const newSettings = { ...settings, [key]: !settings[key] };
    setSettings(newSettings);
    await deviceStore.saveSettings(newSettings);
  };

  const handleRemoveServer = async (serverId, serverName) => {
    Alert.alert(
      "Remove Device",
      `Are you sure you want to unpair "${serverName}"? You will need to pair again.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            await deviceStore.removePairedServer(serverId);
            await loadData();
          },
        },
      ],
    );
  };

  const handleDisconnect = () => {
    wsService.disconnect();
    Alert.alert("Disconnected", "Disconnected from the PC.");
  };

  const handleClearAll = () => {
    Alert.alert(
      "Reset Everything",
      "This will remove all paired devices and reset settings. Continue?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: async () => {
            wsService.disconnect();
            await deviceStore.clearAll();
            await loadData();
            Alert.alert("Done", "All data has been cleared.");
          },
        },
      ],
    );
  };

  const handleChangeSaveDir = async () => {
    try {
      if (Platform.OS !== "android") {
        Alert.alert("Not Supported", "iOS handles files differently.");
        return;
      }
      const permissions =
        await FS.StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (permissions.granted) {
        let folderName =
          permissions.directoryUri.split("%3A").pop() || "Selected Folder";
        if (folderName.includes("%2F"))
          folderName = folderName.replace(/%2F/g, "/");

        await deviceStore.setReceiveDir(permissions.directoryUri, folderName);
        Alert.alert("Success", `Files will now be saved to: ${folderName}`);
      }
    } catch (e) {
      console.error(e);
      Alert.alert("Error", "Could not change folder.");
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0D1117" />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={styles.backBtn}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Settings</Text>
        </View>

        {/* Device Identity */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>DEVICE</Text>
          <View style={styles.card}>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>Device Name</Text>
              {editingName ? (
                <View style={styles.nameEditRow}>
                  <TextInput
                    style={styles.nameInput}
                    value={deviceName}
                    onChangeText={setDeviceName}
                    onSubmitEditing={handleSaveName}
                    autoFocus
                  />
                  <TouchableOpacity onPress={handleSaveName}>
                    <Text style={styles.saveBtn}>Save</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity onPress={() => setEditingName(true)}>
                  <Text style={styles.settingValue}>{deviceName} ✏️</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>

        {/* Sync Settings */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>SYNC</Text>
          <View style={styles.card}>
            <View style={styles.settingRow}>
              <View style={styles.settingInfo}>
                <Text style={styles.settingLabel}>Clipboard Sync</Text>
                <Text style={styles.settingDesc}>
                  Auto-sync clipboard between devices
                </Text>
              </View>
              <Switch
                value={settings.clipboardSync}
                onValueChange={() => handleToggleSetting("clipboardSync")}
                trackColor={{ false: "#21262D", true: "#238636" }}
                thumbColor="#E6EDF3"
              />
            </View>
            <View style={styles.divider} />
            <View style={styles.settingRow}>
              <View style={styles.settingInfo}>
                <Text style={styles.settingLabel}>Auto Connect</Text>
                <Text style={styles.settingDesc}>
                  Reconnect to last PC automatically
                </Text>
              </View>
              <Switch
                value={settings.autoConnect}
                onValueChange={() => handleToggleSetting("autoConnect")}
                trackColor={{ false: "#21262D", true: "#238636" }}
                thumbColor="#E6EDF3"
              />
            </View>
            <View style={styles.divider} />
            <View style={styles.settingRow}>
              <View style={styles.settingInfo}>
                <Text style={styles.settingLabel}>Notifications</Text>
                <Text style={styles.settingDesc}>
                  Show notifications for incoming data
                </Text>
              </View>
              <Switch
                value={settings.notifications}
                onValueChange={() => handleToggleSetting("notifications")}
                trackColor={{ false: "#21262D", true: "#238636" }}
                thumbColor="#E6EDF3"
              />
            </View>
          </View>
        </View>

        {/* Paired Devices */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>PAIRED DEVICES</Text>
          {pairedServers.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.emptyText}>No paired devices</Text>
              <Text style={styles.emptySubtext}>
                Use "Pair Device" to connect to a PC
              </Text>
            </View>
          ) : (
            pairedServers.map((server) => (
              <View key={server.serverId} style={styles.deviceCard}>
                <View style={styles.deviceInfo}>
                  <Text style={styles.deviceName}>
                    🖥️ {server.serverName || "Unknown PC"}
                  </Text>
                  <Text style={styles.deviceAddr}>
                    {server.host}:{server.port}
                  </Text>
                  {server.pairedAt && (
                    <Text style={styles.deviceDate}>
                      Paired: {new Date(server.pairedAt).toLocaleDateString()}
                    </Text>
                  )}
                </View>
                <TouchableOpacity
                  style={styles.removeBtn}
                  onPress={() =>
                    handleRemoveServer(server.serverId, server.serverName)
                  }
                >
                  <Text style={styles.removeBtnText}>Remove</Text>
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>

        {/* Actions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>ACTIONS</Text>
          <View style={styles.card}>
            <TouchableOpacity
              style={styles.actionRow}
              onPress={handleChangeSaveDir}
            >
              <Text style={styles.actionText}>Change Save Location</Text>
              <Text style={styles.actionDesc}>
                Set where received files are stored
              </Text>
            </TouchableOpacity>
            <View style={styles.divider} />
            <TouchableOpacity
              style={styles.actionRow}
              onPress={handleDisconnect}
            >
              <Text style={styles.actionText}>Disconnect</Text>
              <Text style={styles.actionDesc}>
                Disconnect from the current PC
              </Text>
            </TouchableOpacity>
            <View style={styles.divider} />
            <TouchableOpacity style={styles.actionRow} onPress={handleClearAll}>
              <Text style={[styles.actionText, styles.dangerText]}>
                Reset Everything
              </Text>
              <Text style={styles.actionDesc}>
                Remove all paired devices and settings
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Version */}
        <View style={styles.versionContainer}>
          <Text style={styles.versionText}>
            mcSync v{Constants.expoConfig?.version || '1.0.0'}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0D1117",
  },
  scrollContent: {
    paddingBottom: 40,
  },
  header: {
    paddingHorizontal: 24,
    paddingTop: 16,
    marginBottom: 16,
  },
  backBtn: {
    color: "#1F6FEB",
    fontSize: 16,
    fontWeight: "500",
    marginBottom: 8,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    color: "#E6EDF3",
  },
  section: {
    paddingHorizontal: 24,
    marginBottom: 24,
  },
  sectionTitle: {
    color: "#8B949E",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1,
    marginBottom: 8,
  },
  card: {
    backgroundColor: "#161B22",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#21262D",
    overflow: "hidden",
    padding: 16,
  },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  settingInfo: {
    flex: 1,
    marginRight: 12,
  },
  settingLabel: {
    color: "#E6EDF3",
    fontSize: 15,
    fontWeight: "600",
  },
  settingDesc: {
    color: "#8B949E",
    fontSize: 12,
    marginTop: 2,
  },
  settingValue: {
    color: "#1F6FEB",
    fontSize: 14,
  },
  nameEditRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  nameInput: {
    backgroundColor: "#0D1117",
    borderColor: "#30363D",
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    color: "#E6EDF3",
    fontSize: 14,
    minWidth: 120,
  },
  saveBtn: {
    color: "#238636",
    fontSize: 14,
    fontWeight: "600",
  },
  divider: {
    height: 1,
    backgroundColor: "#21262D",
    marginVertical: 12,
  },
  deviceCard: {
    backgroundColor: "#161B22",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#21262D",
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  deviceInfo: {
    flex: 1,
  },
  deviceName: {
    color: "#E6EDF3",
    fontSize: 15,
    fontWeight: "600",
  },
  deviceAddr: {
    color: "#8B949E",
    fontSize: 13,
    marginTop: 4,
    fontFamily: "monospace",
  },
  deviceDate: {
    color: "#484F58",
    fontSize: 11,
    marginTop: 2,
  },
  removeBtn: {
    backgroundColor: "#3D1114",
    borderColor: "#6E2127",
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  removeBtnText: {
    color: "#F85149",
    fontSize: 12,
    fontWeight: "600",
  },
  emptyText: {
    color: "#8B949E",
    fontSize: 14,
    fontWeight: "600",
  },
  emptySubtext: {
    color: "#484F58",
    fontSize: 12,
    marginTop: 4,
  },
  actionRow: {
    paddingVertical: 4,
  },
  actionText: {
    color: "#E6EDF3",
    fontSize: 15,
    fontWeight: "600",
  },
  actionDesc: {
    color: "#8B949E",
    fontSize: 12,
    marginTop: 2,
  },
  dangerText: {
    color: "#F85149",
  },
  versionContainer: {
    alignItems: "center",
    paddingVertical: 20,
  },
  versionText: {
    color: "#484F58",
    fontSize: 12,
  },
});

export default SettingsScreen;
