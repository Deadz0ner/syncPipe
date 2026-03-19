/**
 * PairScreen - Device pairing flow.
 * Discovers mcSync PCs on the network and handles the pairing handshake.
 */

import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  ScrollView,
  StatusBar,
  Animated,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import wsService from "../services/WebSocketService";
import deviceStore from "../stores/DeviceStore";

const PairScreen = ({ navigation }) => {
  const [step, _setStep] = useState("input"); // 'input' | 'connecting' | 'success'
  const stepRef = useRef("input");

  const setStep = (newStep) => {
    stepRef.current = newStep;
    _setStep(newStep);
  };

  const [serverHost, setServerHost] = useState("");
  const [serverPort, setServerPort] = useState("9090");
  const [pairingCode, setPairingCode] = useState("");
  const [foundServers, setFoundServers] = useState([]);
  const [isScanning, setIsScanning] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [pairedServerName, setPairedServerName] = useState("");
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.9)).current;
  const pairTimer = useRef(null);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }),
      Animated.spring(scaleAnim, {
        toValue: 1,
        friction: 8,
        useNativeDriver: true,
      }),
    ]).start();

    // Start auto-discovery
    startDiscovery();
  }, []);

  const startDiscovery = async () => {
    setIsScanning(true);
    setFoundServers([]);
    wsService.scanForServers((server) => {
      setFoundServers((prev) => {
        if (prev.find((s) => s.host === server.host)) return prev;
        return [...prev, server];
      });
    });
    // Stop scanning after some time or just let it run in background
    setTimeout(() => setIsScanning(false), 15000);
  };

  useEffect(() => {
    // Listen for pair response (WebSocket fallback, though HTTP is now primary)
    const unsubPair = wsService.on("pairResponse", async (data) => {
      await handlePairSuccess(data);
    });

    return () => {
      unsubPair();
      if (pairTimer.current) clearTimeout(pairTimer.current);
    };
  }, [serverHost, serverPort, pairingCode]);

  const handlePairSuccess = async (data) => {
    if (data.success) {
      setStep("success");
      setPairedServerName(data.device_name);
      setStatusMessage("Paired successfully!");

      // Save pairing info
      await deviceStore.savePairedServer({
        serverId: data.server_id,
        serverName: data.device_name,
        host: serverHost.trim(),
        port: parseInt(serverPort, 10),
        authToken: data.auth_token,
      });

      // Update WS auth info for auto-reconnect
      const deviceId = await deviceStore.getOrCreateDeviceId();
      const deviceName = await deviceStore.getDeviceName();
      wsService.authInfo = {
        deviceId,
        authToken: data.auth_token,
        deviceName,
      };

      // Now that we are paired, try to establish the WebSocket
      wsService.connect(
        serverHost.trim(),
        parseInt(serverPort, 10),
        wsService.authInfo,
      );
    } else {
      setStep("input");
      Alert.alert("Pairing Failed", data.message || "Invalid pairing code");
      setStatusMessage("");
    }
  };

  const handlePair = async () => {
    if (!serverHost.trim()) {
      Alert.alert("Error", "Please select a PC or enter the IP address");
      return;
    }
    if (!pairingCode.trim() || pairingCode.length !== 6) {
      Alert.alert("Error", "Please enter a valid 6-digit pairing code");
      return;
    }

    setStep("connecting");
    setStatusMessage("Pairing with PC...");

    try {
      const deviceId = await deviceStore.getOrCreateDeviceId();
      const deviceName = await deviceStore.getDeviceName();

      console.log(
        `[Pair] Attempting to pair with ${serverHost.trim()}:${serverPort}...`,
      );

      // Use HTTP pairing instead of WebSocket (Bypass hotspot blocks)
      const result = await wsService.pairViaHttp(
        serverHost.trim(),
        parseInt(serverPort, 10),
        pairingCode.trim(),
        deviceId,
        deviceName,
      );

      await handlePairSuccess(result);
    } catch (e) {
      setStep("input");
      setStatusMessage("");
      Alert.alert(
        "Pairing Error",
        e.message ||
          "Could not reach the PC. Make sure the IP is correct and the PC is on the same hotspot.",
      );
    }
  };

  const selectServer = (server) => {
    setServerHost(server.host);
    setServerPort(server.port.toString());
  };

  const handleDone = () => {
    navigation.goBack();
  };

  if (step === "success") {
    return (
      <View style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor="#0D1117" />
        <View style={styles.successContainer}>
          <Text style={styles.successIcon}>✅</Text>
          <Text style={styles.successTitle}>Paired!</Text>
          <Text style={styles.successSubtitle}>
            Connected to {pairedServerName}
          </Text>
          <Text style={styles.successDetail}>
            Your devices will now auto-connect when on the same network.
          </Text>
          <TouchableOpacity style={styles.doneBtn} onPress={handleDone}>
            <Text style={styles.doneBtnText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <StatusBar barStyle="light-content" backgroundColor="#0D1117" />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <Animated.View
          style={[
            styles.content,
            { opacity: fadeAnim, transform: [{ scale: scaleAnim }] },
          ]}
        >
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity onPress={() => navigation.goBack()}>
              <Text style={styles.backBtn}>← Back</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.title}>Pair New Device</Text>
          <Text style={styles.subtitle}>
            Connect your phone to a PC running mcSync
          </Text>

          {/* Discovery Section */}
          <View style={styles.discoverySection}>
            <View style={styles.discoveryHeader}>
              <Text style={styles.discoveryTitle}>Servers on Network</Text>
              {isScanning ? (
                <ActivityIndicator size="small" color="#1F6FEB" />
              ) : (
                <TouchableOpacity onPress={startDiscovery}>
                  <Text style={styles.refreshText}>↻ Refresh</Text>
                </TouchableOpacity>
              )}
            </View>

            {foundServers.length > 0 ? (
              <View style={styles.serverList}>
                {foundServers.map((server) => (
                  <TouchableOpacity
                    key={server.host}
                    style={[
                      styles.serverItem,
                      serverHost === server.host && styles.selectedServerItem,
                    ]}
                    onPress={() => selectServer(server)}
                  >
                    <View style={styles.serverInfo}>
                      <Text style={styles.serverIcon}>💻</Text>
                      <View>
                        <Text style={styles.serverName}>
                          {server.device_name}
                        </Text>
                        <Text style={styles.serverHost}>{server.host}</Text>
                      </View>
                    </View>
                    {serverHost === server.host && (
                      <Text style={styles.selectedCheck}>✓</Text>
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            ) : (
              <View style={styles.noDiscovery}>
                <Text style={styles.noDiscoveryText}>
                  {isScanning
                    ? "Searching for PCs..."
                    : "No servers found automatically."}
                </Text>
              </View>
            )}
          </View>

          {/* Instructions */}
          <View style={styles.instructionCard}>
            <Text style={styles.instructionTitle}>On your PC, run:</Text>
            <View style={styles.codeBlock}>
              <Text style={styles.codeText}>mc pair</Text>
            </View>
            <Text style={styles.instructionNote}>
              This will display a pairing code and the server IP address.
            </Text>
          </View>

          {/* Form */}
          <View style={styles.form}>
            <Text style={styles.label}>PC IP Address</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. 192.168.1.100"
              placeholderTextColor="#5C6370"
              value={serverHost}
              onChangeText={setServerHost}
              keyboardType="numeric"
              autoCapitalize="none"
              editable={step !== "connecting"}
            />

            <Text style={styles.label}>Port</Text>
            <TextInput
              style={styles.input}
              placeholder="9090"
              placeholderTextColor="#5C6370"
              value={serverPort}
              onChangeText={setServerPort}
              keyboardType="numeric"
              editable={step !== "connecting"}
            />

            <Text style={styles.label}>Pairing Code</Text>
            <TextInput
              style={[styles.input, styles.codeInput]}
              placeholder="000000"
              placeholderTextColor="#5C6370"
              value={pairingCode}
              onChangeText={setPairingCode}
              keyboardType="numeric"
              maxLength={6}
              textAlign="center"
              editable={step !== "connecting"}
            />
          </View>

          {/* Status */}
          {statusMessage ? (
            <View style={styles.statusContainer}>
              {step === "connecting" && (
                <ActivityIndicator
                  color="#1F6FEB"
                  style={{ marginRight: 10 }}
                />
              )}
              <Text style={styles.statusText}>{statusMessage}</Text>
            </View>
          ) : null}

          {/* Pair Button */}
          <TouchableOpacity
            style={[
              styles.pairBtn,
              step === "connecting" && styles.disabledBtn,
            ]}
            onPress={handlePair}
            disabled={step === "connecting"}
          >
            <Text style={styles.pairBtnText}>
              {step === "connecting" ? "Pairing..." : "Pair Device"}
            </Text>
          </TouchableOpacity>
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0D1117",
  },
  scrollContent: {
    flexGrow: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
  },
  header: {
    paddingTop: 16,
    paddingBottom: 8,
  },
  backBtn: {
    color: "#1F6FEB",
    fontSize: 16,
    fontWeight: "500",
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    color: "#E6EDF3",
    marginTop: 8,
  },
  subtitle: {
    fontSize: 14,
    color: "#8B949E",
    marginTop: 4,
    marginBottom: 24,
  },
  instructionCard: {
    backgroundColor: "#161B22",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#21262D",
    marginBottom: 24,
  },
  instructionTitle: {
    color: "#E6EDF3",
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 10,
  },
  codeBlock: {
    backgroundColor: "#0D1117",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#30363D",
  },
  codeText: {
    color: "#7EE787",
    fontSize: 16,
    fontFamily: "monospace",
    fontWeight: "600",
  },
  instructionNote: {
    color: "#8B949E",
    fontSize: 12,
  },
  form: {
    marginBottom: 20,
  },
  label: {
    color: "#E6EDF3",
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    backgroundColor: "#161B22",
    borderColor: "#21262D",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: "#E6EDF3",
    fontSize: 16,
  },
  codeInput: {
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: 12,
    fontFamily: "monospace",
  },
  statusContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  statusText: {
    color: "#8B949E",
    fontSize: 14,
  },
  pairBtn: {
    backgroundColor: "#238636",
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    marginBottom: 30,
  },
  disabledBtn: {
    opacity: 0.6,
  },
  pairBtnText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
  },
  // Success state
  successContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
  },
  successIcon: {
    fontSize: 64,
    marginBottom: 20,
  },
  successTitle: {
    color: "#E6EDF3",
    fontSize: 32,
    fontWeight: "800",
  },
  successSubtitle: {
    color: "#7EE787",
    fontSize: 16,
    fontWeight: "600",
    marginTop: 8,
  },
  successDetail: {
    color: "#8B949E",
    fontSize: 14,
    textAlign: "center",
    marginTop: 12,
    lineHeight: 20,
  },
  doneBtn: {
    backgroundColor: "#1F6FEB",
    paddingHorizontal: 40,
    paddingVertical: 14,
    borderRadius: 10,
    marginTop: 30,
  },
  doneBtnText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
  },
  // Discovery
  discoverySection: {
    marginBottom: 24,
  },
  discoveryHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  discoveryTitle: {
    color: "#8B949E",
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  refreshText: {
    color: "#1F6FEB",
    fontSize: 12,
    fontWeight: "600",
  },
  serverList: {
    gap: 8,
  },
  serverItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#161B22",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "#21262D",
  },
  selectedServerItem: {
    borderColor: "#1F6FEB",
    backgroundColor: "#0D2347",
  },
  serverInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  serverIcon: {
    fontSize: 24,
  },
  serverName: {
    color: "#E6EDF3",
    fontSize: 15,
    fontWeight: "700",
  },
  serverHost: {
    color: "#8B949E",
    fontSize: 12,
    marginTop: 2,
  },
  selectedCheck: {
    color: "#1F6FEB",
    fontSize: 18,
    fontWeight: "800",
  },
  noDiscovery: {
    backgroundColor: "#161B2266",
    borderRadius: 10,
    paddingVertical: 20,
    alignItems: "center",
    borderStyle: "dashed",
    borderWidth: 1,
    borderColor: "#21262D",
  },
  noDiscoveryText: {
    color: "#484F58",
    fontSize: 13,
  },
});

export default PairScreen;
