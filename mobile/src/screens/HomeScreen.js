/**
 * HomeScreen - Main dashboard showing connection status and quick actions.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Alert,
  TextInput,
  StatusBar,
  Animated,
  Platform,
} from "react-native";
import * as Sharing from "expo-sharing";
import * as Clipboard from "expo-clipboard";
import * as FS from "expo-file-system/legacy";
import wsService from "../services/WebSocketService";
import deviceStore from "../stores/DeviceStore";

const HomeScreen = ({ navigation }) => {
  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const [serverName, setServerName] = useState("");
  const [textInput, setTextInput] = useState("");
  const [receivedMessages, setReceivedMessages] = useState([]);
  const [pulseAnim] = useState(new Animated.Value(1));

  useEffect(() => {
    // Listen for connection status changes
    wsService.onStatusChange((status, detail) => {
      setConnectionStatus(status);
      if (detail && status === "authenticated") {
        setServerName(detail);
      }
    });

    // Listen for incoming text
    const unsubText = wsService.on("text", (data) => {
      const msg = {
        id: Date.now().toString(),
        type: "text",
        content: data.content,
        time: new Date().toLocaleTimeString(),
        direction: "received",
      };
      setReceivedMessages((prev) => [msg, ...prev]);
    });

    // Listen for clipboard sync
    const unsubClip = wsService.on("clipboard", (data) => {
      const msg = {
        id: Date.now().toString(),
        type: "clipboard",
        content: data.content,
        time: new Date().toLocaleTimeString(),
        direction: "received",
      };
      setReceivedMessages((prev) => [msg, ...prev]);
    });

    // Listen for file transfers (sent or received)
    const unsubFile = wsService.on("fileTransferCompleted", (data) => {
      if (data.direction === "receive" && data.path) {
        Alert.alert("File Received", `${data.filename} has been received.`, [
          { text: "Dismiss", style: "cancel" },
          {
            text: "Save / Open",
            onPress: async () => {
              try {
                if (await Sharing.isAvailableAsync()) {
                  await Sharing.shareAsync(data.path);
                }
              } catch (e) {}
            },
          },
        ]);
      }
      const msg = {
        id: Date.now().toString() + Math.random(),
        type: "file",
        content: `File ${data.direction === "send" ? "sent" : "received"}: ${data.filename}`,
        time: new Date().toLocaleTimeString(),
        direction: data.direction === "send" ? "sent" : "received",
        path: data.path,
      };
      setReceivedMessages((prev) => [msg, ...prev]);
    });

    // Handle first-time setup for saving files (Android)
    checkFirstRunSetup();

    // Auto-connect to last server
    autoConnect();

    return () => {
      unsubText();
      unsubClip();
      unsubFile();
    };
  }, []);

  // Pulse animation for connection dot
  useEffect(() => {
    if (connectionStatus === "authenticated") {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.3,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1000,
            useNativeDriver: true,
          }),
        ]),
      );
      pulse.start();
      return () => pulse.stop();
    }
  }, [connectionStatus, pulseAnim]);

  const autoConnect = async () => {
    try {
      const lastServer = await deviceStore.getLastServer();
      if (lastServer) {
        const deviceId = await deviceStore.getOrCreateDeviceId();
        const deviceName = await deviceStore.getDeviceName();
        wsService.connect(lastServer.host, lastServer.port, {
          deviceId,
          authToken: lastServer.authToken,
          deviceName,
        });
      }
    } catch (e) {
      console.log("Auto-connect failed:", e.message);
    }
  };

  const handleReconnect = () => {
    if (connectionStatus !== "disconnected") {
      wsService.disconnect();
      setTimeout(() => {
        autoConnect();
      }, 500);
    } else {
      autoConnect();
    }
  };

  const checkFirstRunSetup = async () => {
    if (Platform.OS !== "android") return; // iOS handles downloads differently via sharing

    try {
      const { uri } = await deviceStore.getReceiveDir();
      if (!uri) {
        Alert.alert(
          "Storage Setup",
          "Please select a folder where mcSync will save incoming files (e.g., your Downloads folder).",
          [
            {
              text: "Select Folder",
              onPress: async () => {
                try {
                  const permissions =
                    await FS.StorageAccessFramework.requestDirectoryPermissionsAsync();
                  if (permissions.granted) {
                    // Extract a readable name from the URI (e.g., primary:Download -> Download)
                    let folderName =
                      permissions.directoryUri.split("%3A").pop() ||
                      "Selected Folder";
                    if (folderName.includes("%2F"))
                      folderName = folderName.replace(/%2F/g, "/");

                    await deviceStore.setReceiveDir(
                      permissions.directoryUri,
                      folderName,
                    );
                    Alert.alert(
                      "Success",
                      `Files will be saved to: ${folderName}`,
                    );
                  } else {
                    Alert.alert(
                      "Warning",
                      "Storage permission was not granted. Files will be kept in app memory and might not be easily accessible.",
                    );
                  }
                } catch (e) {
                  console.error("Storage permission error:", e);
                }
              },
            },
          ],
          { cancelable: false },
        );
      }
    } catch (e) {
      console.log("Error checking setup:", e.message);
    }
  };

  const handleSendText = () => {
    if (!textInput.trim()) return;
    if (!wsService.isAuthenticated) {
      Alert.alert("Not Connected", "Please connect to a PC first.");
      return;
    }

    wsService.sendText(textInput.trim());
    const msg = {
      id: Date.now().toString(),
      type: "text",
      content: textInput.trim(),
      time: new Date().toLocaleTimeString(),
      direction: "sent",
    };
    setReceivedMessages((prev) => [msg, ...prev]);
    setTextInput("");
  };

  const handleMessagePress = async (item) => {
    if (item.type === "file" && item.path) {
      try {
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(item.path);
        }
      } catch (e) {
        console.error(e);
      }
    } else if (item.type === "clipboard" || item.type === "text") {
      try {
        await Clipboard.setStringAsync(item.content);
        Alert.alert("Copied", "Text copied to clipboard!");
      } catch (e) {
        console.error(e);
      }
    }
  };

  const getStatusColor = () => {
    switch (connectionStatus) {
      case "authenticated":
        return "#00E676";
      case "connected":
        return "#FFC107";
      case "connecting":
      case "reconnecting":
        return "#FF9800";
      case "error":
      case "failed":
      case "auth_failed":
        return "#F44336";
      default:
        return "#78909C";
    }
  };

  const getStatusText = () => {
    switch (connectionStatus) {
      case "authenticated":
        return `Connected to ${serverName}`;
      case "connected":
        return "Authenticating...";
      case "connecting":
        return "Connecting...";
      case "reconnecting":
        return "Reconnecting...";
      case "error":
        return "Connection Error";
      case "failed":
        return "Connection Failed";
      case "auth_failed":
        return "Authentication Failed";
      default:
        return "Disconnected";
    }
  };

  const renderMessage = ({ item }) => {
    const isSent = item.direction === "sent";
    return (
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => handleMessagePress(item)}
        style={[
          styles.messageCard,
          isSent ? styles.sentCard : styles.receivedCard,
        ]}
      >
        <View style={styles.messageHeader}>
          <Text style={styles.messageType}>
            {item.type === "clipboard"
              ? "📋 Clipboard"
              : item.type === "file"
                ? "📁 File"
                : "💬 Text"}
          </Text>
          <Text style={styles.messageTime}>{item.time}</Text>
        </View>
        <Text style={styles.messageContent} numberOfLines={3}>
          {item.content}
        </Text>
        <Text
          style={[
            styles.messageDirection,
            isSent ? styles.sentLabel : styles.receivedLabel,
          ]}
        >
          {isSent ? "↑ Sent" : "↓ Received"}
          {item.type === "file" ? " (Tap to Open)" : " (Tap to Copy)"}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0D1117" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>mcSync</Text>
        <Text style={styles.subtitle}>
          {connectionStatus === "authenticated" && serverName
            ? `Connected to: ${serverName}`
            : "Terminal ↔ Phone Sync"}
        </Text>
      </View>

      {/* Connection Status */}
      <View style={styles.statusBar}>
        <TouchableOpacity
          style={styles.statusRow}
          onPress={handleReconnect}
          activeOpacity={0.7}
        >
          <Animated.View
            style={[
              styles.statusDot,
              { backgroundColor: getStatusColor() },
              { transform: [{ scale: pulseAnim }] },
            ]}
          />
          <Text style={styles.statusText}>{getStatusText()}</Text>
        </TouchableOpacity>
        {connectionStatus === "disconnected" && (
          <TouchableOpacity
            style={styles.connectBtn}
            onPress={() => navigation.navigate("Pair")}
          >
            <Text style={styles.connectBtnText}>Connect</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Quick Actions */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.actionBtn, styles.pairBtn]}
          onPress={() => navigation.navigate("Pair")}
        >
          <Text style={styles.actionIcon}>🔗</Text>
          <Text style={styles.actionLabel}>Pair</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, styles.fileBtn]}
          onPress={() => navigation.navigate("FileTransfer")}
        >
          <Text style={styles.actionIcon}>📁</Text>
          <Text style={styles.actionLabel}>Files</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.actionBtn,
            { backgroundColor: "#211A2A", borderColor: "#352D55" },
          ]}
          onPress={async () => {
            if (!wsService.isAuthenticated) {
              Alert.alert("Not Connected", "Connect to a PC first.");
              return;
            }
            import("../services/ClipboardService").then((mod) => {
              mod.default.sendCurrent().then((success) => {
                if (success) {
                  Alert.alert("Synced", "Clipboard sent to PC.");
                } else {
                  Alert.alert("Failed", "Could not read clipboard.");
                }
              });
            });
          }}
        >
          <Text style={styles.actionIcon}>📋</Text>
          <Text style={styles.actionLabel}>Sync Clip</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, styles.settingsBtn]}
          onPress={() => navigation.navigate("Settings")}
        >
          <Text style={styles.actionIcon}>⚙️</Text>
          <Text style={styles.actionLabel}>Settings</Text>
        </TouchableOpacity>
      </View>

      {/* Text Input */}
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.textInput}
          placeholder="Type a message to send..."
          placeholderTextColor="#5C6370"
          value={textInput}
          onChangeText={setTextInput}
          onSubmitEditing={handleSendText}
          returnKeyType="send"
        />
        <TouchableOpacity style={styles.sendBtn} onPress={handleSendText}>
          <Text style={styles.sendBtnText}>Send</Text>
        </TouchableOpacity>
      </View>

      {/* Messages */}
      <View style={styles.messagesContainer}>
        <Text style={styles.sectionTitle}>Recent Activity</Text>
        {receivedMessages.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>📡</Text>
            <Text style={styles.emptyText}>No messages yet</Text>
            <Text style={styles.emptySubtext}>
              Send text from your PC or phone
            </Text>
          </View>
        ) : (
          <FlatList
            data={receivedMessages}
            renderItem={renderMessage}
            keyExtractor={(item) => item.id}
            showsVerticalScrollIndicator={false}
          />
        )}
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
    paddingBottom: 8,
  },
  title: {
    fontSize: 32,
    fontWeight: "800",
    color: "#E6EDF3",
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 14,
    color: "#8B949E",
    marginTop: 2,
  },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: 24,
    marginTop: 16,
    backgroundColor: "#161B22",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "#21262D",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 10,
  },
  statusText: {
    color: "#E6EDF3",
    fontSize: 14,
    fontWeight: "500",
  },
  connectBtn: {
    backgroundColor: "#238636",
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 6,
  },
  connectBtnText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "600",
  },
  actions: {
    flexDirection: "row",
    paddingHorizontal: 24,
    marginTop: 16,
    gap: 10,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: "center",
    borderWidth: 1,
  },
  pairBtn: {
    backgroundColor: "#1A1F35",
    borderColor: "#2D3555",
  },
  fileBtn: {
    backgroundColor: "#1A2A1F",
    borderColor: "#2D5535",
  },
  settingsBtn: {
    backgroundColor: "#2A1F1A",
    borderColor: "#55352D",
  },
  actionIcon: {
    fontSize: 24,
    marginBottom: 4,
  },
  actionLabel: {
    color: "#8B949E",
    fontSize: 11,
    fontWeight: "600",
  },
  inputContainer: {
    flexDirection: "row",
    marginHorizontal: 24,
    marginTop: 16,
    gap: 8,
  },
  textInput: {
    flex: 1,
    backgroundColor: "#161B22",
    borderColor: "#21262D",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: "#E6EDF3",
    fontSize: 14,
  },
  sendBtn: {
    backgroundColor: "#1F6FEB",
    paddingHorizontal: 20,
    justifyContent: "center",
    borderRadius: 10,
  },
  sendBtnText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "600",
  },
  messagesContainer: {
    flex: 1,
    marginTop: 20,
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
  messageCard: {
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
  },
  sentCard: {
    backgroundColor: "#0D2347",
    borderColor: "#1F6FEB33",
  },
  receivedCard: {
    backgroundColor: "#1A2A1F",
    borderColor: "#2D553533",
  },
  messageHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  messageType: {
    color: "#8B949E",
    fontSize: 11,
    fontWeight: "600",
  },
  messageTime: {
    color: "#484F58",
    fontSize: 11,
  },
  messageContent: {
    color: "#E6EDF3",
    fontSize: 14,
    lineHeight: 20,
  },
  messageDirection: {
    fontSize: 10,
    fontWeight: "600",
    marginTop: 6,
  },
  sentLabel: {
    color: "#1F6FEB",
  },
  receivedLabel: {
    color: "#238636",
  },
});

export default HomeScreen;
