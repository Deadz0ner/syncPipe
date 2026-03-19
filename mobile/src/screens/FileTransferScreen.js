/**
 * FileTransferScreen - Send and receive files.
 * Shows transfer progress and allows picking files to send.
 */

import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Alert,
  StatusBar,
  PermissionsAndroid,
  Platform,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import fileTransferService from "../services/FileTransferService";
import wsService from "../services/WebSocketService";
import deviceStore from "../stores/DeviceStore";

const FileTransferScreen = ({ navigation }) => {
  const [transfers, setTransfers] = useState([]);
  const [isConnected, setIsConnected] = useState(wsService.isAuthenticated);
  const [receiveDirectory, setReceiveDirectory] = useState("Loading...");

  useEffect(() => {
    // Listen for progress updates
    fileTransferService.setOnProgress((progress) => {
      setTransfers((prev) => {
        const existing = prev.find((t) => t.transferId === progress.transferId);
        if (existing) {
          return prev.map((t) =>
            t.transferId === progress.transferId ? { ...t, ...progress } : t,
          );
        }
        return [progress, ...prev];
      });
    });

    // Listen for received files (just for UI update if needed, but not alert)
    fileTransferService.setOnFileReceived((info) => {
      console.log("[FileTransfer] Received completed event in screen");
    });

    // Track connection status
    wsService.onStatusChange((status) => {
      setIsConnected(status === "authenticated");
    });

    // Check where files are saved
    const loadReceiveDir = async () => {
      const { name } = await deviceStore.getReceiveDir();
      if (name) {
        setReceiveDirectory(name);
      } else {
        setReceiveDirectory(
          Platform.OS === "android"
            ? "Downloads/mcSync/"
            : "App Storage/mcSync/",
        );
      }
    };
    loadReceiveDir();

    return () => {
      fileTransferService.setOnProgress(null);
      fileTransferService.setOnFileReceived(null);
    };
  }, []);

  const requestPermission = async () => {
    if (Platform.OS === "android") {
      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE,
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      } catch (err) {
        return false;
      }
    }
    return true;
  };

  const handlePickFile = async () => {
    if (!isConnected) {
      Alert.alert("Not Connected", "Please connect to a PC first.");
      return;
    }

    try {
      console.log("[FilePick] Launching ImagePicker...");
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images", "videos"],
        allowsMultipleSelection: false,
      });

      if (result.canceled || !result.assets?.[0]) {
        console.log("[FilePick] ImagePicker canceled");
        return;
      }

      const asset = result.assets[0];
      const finalName =
        asset.fileName || asset.uri.split("/").pop() || "photo.jpg";
      const finalSize = asset.size || asset.fileSize;
      console.log(
        `[FilePick] Image selected: ${finalName} (${finalSize} bytes)`,
      );

      // Pass the URI string — FileTransferService handles file:// URIs natively
      await fileTransferService.sendFile(asset.uri, finalName, finalSize);
    } catch (error) {
      console.error("[FilePick] ImagePicker error:", error);
      Alert.alert("Error", `Failed to send file: ${error.message}`);
    }
  };

  const handleSendFromStorage = async () => {
    // console.log("[STORAGE_DEBUG] Button touched");

    if (!isConnected) {
      Alert.alert("Error", "Not connected to PC.");
      return;
    }

    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        copyToCacheDirectory: true,
      });

      console.log("[STORAGE_DEBUG] Result:", JSON.stringify(result));

      if (!result.canceled && result.assets?.[0]) {
        const asset = result.assets[0];
        // Pass the whole asset object — new File(asset) works directly per Expo docs
        const finalName =
          asset.name || asset.fileName || asset.uri.split("/").pop() || "file";
        const finalSize = asset.size || asset.fileSize;

        console.log(
          `[STORAGE_DEBUG] Selected: ${finalName} (${finalSize} bytes)`,
        );

        // asset.uri is a file:// cache path (copyToCacheDirectory: true above)
        await fileTransferService.sendFile(asset.uri, finalName, finalSize);
      }
    } catch (error) {
      console.error("[STORAGE_DEBUG] Error:", error.message);
      Alert.alert("Picker Error", error.message);
    }
  };

  const renderTransfer = ({ item }) => {
    const progress = Math.round((item.progress || 0) * 100);
    const isSend = item.direction === "send";
    const isComplete = item.complete || progress === 100;

    return (
      <View style={styles.transferCard}>
        <View style={styles.transferHeader}>
          <Text style={styles.transferIcon}>
            {isComplete ? "✅" : isSend ? "⬆️" : "⬇️"}
          </Text>
          <View style={styles.transferInfo}>
            <Text style={styles.transferName} numberOfLines={1}>
              {item.fileName}
            </Text>
            <Text style={styles.transferDetail}>
              {isSend ? "Sending" : "Receiving"} • {item.chunkIndex}/
              {item.totalChunks} chunks
            </Text>
          </View>
          <Text style={styles.transferPercent}>{progress}%</Text>
        </View>
        <View style={styles.progressBarBg}>
          <View
            style={[
              styles.progressBarFill,
              { width: `${progress}%` },
              isComplete && styles.progressComplete,
            ]}
          />
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0D1117" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backBtn}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>File Transfer</Text>
        <Text style={styles.subtitle}>Send and receive files</Text>
      </View>

      {/* Connection Warning */}
      {!isConnected && (
        <View style={styles.warningBanner}>
          <Text style={styles.warningText}>
            ⚠️ Not connected to any PC. Pair a device first.
          </Text>
        </View>
      )}

      {/* Send Actions */}
      <View style={styles.sendActions}>
        <TouchableOpacity style={styles.sendBtn} onPress={handlePickFile}>
          <Text style={styles.sendIcon}>🖼️</Text>
          <Text style={styles.sendLabel}>From Gallery</Text>
          <Text style={styles.sendDesc}>Send photos & videos</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.sendBtn}
          onPress={handleSendFromStorage}
        >
          <Text style={styles.sendIcon}>📂</Text>
          <Text style={styles.sendLabel}>From Storage</Text>
          <Text style={styles.sendDesc}>Send any file</Text>
        </TouchableOpacity>
      </View>

      {/* Transfer List */}
      <View style={styles.transfersList}>
        <Text style={styles.sectionTitle}>Transfers</Text>
        {transfers.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>📁</Text>
            <Text style={styles.emptyText}>No active transfers</Text>
            <Text style={styles.emptySubtext}>
              Send a file or receive one from your PC
            </Text>
          </View>
        ) : (
          <FlatList
            data={transfers}
            renderItem={renderTransfer}
            keyExtractor={(item) => item.transferId}
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>

      {/* Received Files Info */}
      <View style={styles.receivedInfo}>
        <Text style={styles.receivedText}>
          📥 Received files are saved to: {receiveDirectory}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0D1117",
  },
  header: {
    paddingHorizontal: 24,
    paddingTop: 16,
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
  subtitle: {
    fontSize: 14,
    color: "#8B949E",
    marginTop: 2,
  },
  warningBanner: {
    marginHorizontal: 24,
    marginTop: 16,
    backgroundColor: "#3D2B00",
    borderColor: "#6E4B00",
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  warningText: {
    color: "#FFC107",
    fontSize: 13,
    textAlign: "center",
  },
  sendActions: {
    flexDirection: "row",
    paddingHorizontal: 24,
    marginTop: 20,
    gap: 12,
  },
  sendBtn: {
    flex: 1,
    backgroundColor: "#161B22",
    borderColor: "#21262D",
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
  },
  sendIcon: {
    fontSize: 32,
    marginBottom: 8,
  },
  sendLabel: {
    color: "#E6EDF3",
    fontSize: 14,
    fontWeight: "700",
  },
  sendDesc: {
    color: "#8B949E",
    fontSize: 11,
    marginTop: 2,
  },
  transfersList: {
    flex: 1,
    marginTop: 24,
    paddingHorizontal: 24,
  },
  sectionTitle: {
    color: "#8B949E",
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 12,
  },
  emptyState: {
    alignItems: "center",
    paddingVertical: 40,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyText: {
    color: "#8B949E",
    fontSize: 16,
    fontWeight: "600",
  },
  emptySubtext: {
    color: "#484F58",
    fontSize: 13,
    marginTop: 4,
  },
  transferCard: {
    backgroundColor: "#161B22",
    borderColor: "#21262D",
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  transferHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
  },
  transferIcon: {
    fontSize: 20,
    marginRight: 10,
  },
  transferInfo: {
    flex: 1,
  },
  transferName: {
    color: "#E6EDF3",
    fontSize: 14,
    fontWeight: "600",
  },
  transferDetail: {
    color: "#8B949E",
    fontSize: 11,
    marginTop: 2,
  },
  transferPercent: {
    color: "#1F6FEB",
    fontSize: 16,
    fontWeight: "700",
  },
  progressBarBg: {
    height: 4,
    backgroundColor: "#21262D",
    borderRadius: 2,
    overflow: "hidden",
  },
  progressBarFill: {
    height: "100%",
    backgroundColor: "#1F6FEB",
    borderRadius: 2,
  },
  progressComplete: {
    backgroundColor: "#238636",
  },
  receivedInfo: {
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: "#21262D",
  },
  receivedText: {
    color: "#484F58",
    fontSize: 12,
    textAlign: "center",
  },
});

export default FileTransferScreen;
