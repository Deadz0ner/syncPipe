# mcSync – Terminal-Driven Phone ↔ PC Sync Tool

A lightweight system for transferring text, clipboard content, and files between a Debian Linux PC and an Android phone over a local network.

## Architecture

```
syncApp/
├── pc/                         # Go backend (server + CLI)
│   ├── cmd/
│   │   └── main.go             # CLI entry point
│   ├── internal/
│   │   ├── clipboard/          # System clipboard monitoring
│   │   │   └── clipboard.go
│   │   ├── config/             # App configuration
│   │   │   └── config.go
│   │   ├── discovery/          # mDNS/Zeroconf discovery
│   │   │   └── mdns.go
│   │   ├── protocol/           # WebSocket message protocol
│   │   │   └── messages.go
│   │   ├── server/             # WebSocket server
│   │   │   └── server.go
│   │   └── store/              # Encrypted device store
│   │       └── store.go
│   ├── go.mod
│   ├── go.sum
│   └── mc                      # Compiled binary
│
└── mobile/                     # React Native Android app
    ├── src/
    │   ├── screens/
    │   │   ├── HomeScreen.js       # Main dashboard
    │   │   ├── PairScreen.js       # Device pairing
    │   │   ├── FileTransferScreen.js
    │   │   └── SettingsScreen.js
    │   ├── services/
    │   │   ├── WebSocketService.js  # WebSocket connection manager
    │   │   ├── FileTransferService.js
    │   │   └── ClipboardService.js
    │   └── stores/
    │       └── DeviceStore.js       # AsyncStorage persistence
    ├── App.tsx
    ├── android/
    └── package.json
```

## Communication Flow

```
┌────────────────────┐       WebSocket (persistent)       ┌────────────────────┐
│                    │◄──────────────────────────────────►│                    │
│  Debian Linux PC   │    ws://pc-ip:9090/ws              │  Android Phone     │
│  (WebSocket Server │                                     │  (WebSocket Client)│
│   + CLI)           │    Protocol Messages:                │                    │
│                    │    AUTH, TEXT, FILE_*, CLIPBOARD     │                    │
└────────────────────┘                                     └────────────────────┘
```

## Quick Start

### PC Setup

```bash
# Build the CLI
cd pc
go build -o mc ./cmd/

# Start the daemon
./mc daemon

# Generate a pairing code
./mc pair

# Send text to phone
./mc send-text "Hello from PC!"

# Send a file
./mc send-file ./document.pdf

# List paired devices
./mc devices

# Check status
./mc status
```

### Mobile Setup

```bash
# Install dependencies
cd mobile
npm install

# Run on Android device/emulator
npx react-native run-android
```

### Pairing Flow

1. On the PC, run: `./mc pair`
2. Note the **pairing code** and **IP address** displayed
3. On the Android app, tap **Pair Device**
4. Enter the PC's IP address and the pairing code
5. Devices are paired! They will auto-reconnect on the same network.

## CLI Commands

| Command               | Alias          | Description                 |
| --------------------- | -------------- | --------------------------- |
| `mc daemon`           | `mc start`     | Start the background server |
| `mc pair`             |                | Generate pairing code       |
| `mc send-text <text>` | `mc st <text>` | Send text to phone          |
| `mc send-file <path>` | `mc sf <path>` | Send file to phone          |
| `mc clipboard`        | `mc cb`        | Info about clipboard sync   |
| `mc devices`          |                | List all paired devices     |
| `mc status`           |                | Show server status          |
| `mc version`          | `mc -v`        | Show version                |
| `mc help`             | `mc -h`        | Show help                   |

## Protocol

All messages are JSON over WebSocket:

```json
{
  "type": "TEXT",
  "id": "unique-message-id",
  "timestamp": 1709856000000,
  "data": {
    "content": "Hello from PC!"
  }
}
```

### Message Types

| Type            | Direction  | Description                    |
| --------------- | ---------- | ------------------------------ |
| `AUTH`          | Phone → PC | Authenticate with stored token |
| `AUTH_RESP`     | PC → Phone | Authentication result          |
| `PAIR_REQ`      | Phone → PC | Pairing request with code      |
| `PAIR_RESP`     | PC → Phone | Pairing result with auth token |
| `TEXT`          | Both       | Text message                   |
| `CLIPBOARD`     | Both       | Clipboard content              |
| `FILE_START`    | Both       | Begin file transfer            |
| `FILE_CHUNK`    | Both       | File data chunk (base64)       |
| `FILE_END`      | Both       | Complete file transfer         |
| `PING` / `PONG` | Both       | Keepalive                      |
| `ACK`           | Both       | Message acknowledgment         |
| `ERROR`         | Both       | Error notification             |

## Security

- **Encrypted Device Store**: Pairing credentials are stored using AES-256-GCM encryption
- **Auto-generated Keys**: Encryption keys are generated on first run
- **Token-based Auth**: Devices authenticate with securely generated tokens
- **Pairing Codes**: 6-digit codes expire after 5 minutes

## Networking

Works across:

- WiFi networks
- Phone hotspot connections
- USB tethering
- Local LAN

The PC acts as the WebSocket server. The phone connects as a client. After pairing, the phone stores the server's IP and port for instant reconnection.

## Configuration

Config is stored at `~/.mcsync/config.json`:

```json
{
  "port": 9090,
  "device_name": "my-pc",
  "device_id": "auto-generated",
  "data_dir": "/home/user/.mcsync",
  "receive_dir": "/home/user/.mcsync/received",
  "clipboard_sync": true
}
```

## Dependencies

### PC (Go)

- `github.com/gorilla/websocket` – WebSocket server
- `github.com/hashicorp/mdns` – mDNS discovery
- Standard library: `crypto/aes`, `crypto/cipher`, `encoding/json`, etc.

### Mobile (React Native)

- `@react-navigation/native` – Navigation
- `@react-native-async-storage/async-storage` – Persistent storage
- `@react-native-clipboard/clipboard` – Clipboard access
- `react-native-fs` – File system access
- `react-native-image-picker` – File picker

## License

MIT
