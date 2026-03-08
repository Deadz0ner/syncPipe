# mcSync Node.js Backend

A Node.js port of the mcSync PC backend. This provides full compatibility with the mcSync mobile app, allowing for text, file, and clipboard synchronization.

## Features

- **Device Pairing**: 6-digit code pairing over local network.
- **WebSocket Communication**: Fast, persistent connection for real-time sync.
- **File Transfer**: Send and receive files with chunking and progress tracking.
- **Clipboard Sync**: Synchronize clipboard across PC and Phone.
- **Interactive REPL**: Manage the server and send commands via a terminal interface.
- **Encrypted Store**: Securely stores paired device information using AES-256-GCM.
- **mDNS Discovery**: Automatic server discovery on the local network.

## Prerequisites

- Node.js (v18 or later recommended)
- `xclip`, `xsel`, or `wl-copy`/`wl-paste` for clipboard support on Linux.

## Installation

```bash
cd pc-node
npm install
```

## Usage

Start the server:

```bash
npm start
```

### Commands

- `pair`: Generate a pairing code for your phone.
- `text <message>`: Send text message to the connected phone.
- `file <path>`: Send a file to the connected phone.
- `clip`: Send PC clipboard to phone.
- `devices`: List all paired devices.
- `connected`: List currently connected devices.
- `status`: Show server and network status.
- `clear`: Clear the terminal screen.
- `quit`: Stop the server and exit.

## Configuration

Settings and paired device data are stored in `~/.mcsync/`.

- `config.json`: Server settings (port, device name, etc.)
- `devices.enc`: Encrypted list of paired devices.
- `store.key`: Encryption key for the store.
- `received/`: Default directory for files received from the phone.
