# mcSync PC Daemon & CLI

The PC component of mcSync is written in Go. It runs as a WebSocket server daemon and provides a zero-configuration experience for syncing text, files, and clipboard with an Android device over the same local network.

## Building

```bash
cd pc
go build -o mc ./cmd/
```

## Running the Server

Start the background daemon. You can leave this running in a tmux/screen session, or wrap it in a systemd service.

```bash
./mc daemon
```

The daemon automatically handles:

- Exposing the WebSocket server on port 9090.
- Advertising itself via mDNS (`_mcsync._tcp.local`) for automatic phone connection.
- Receiving and verifying incoming file transfers.

## Commands

All commands communicate with the local daemon or the paired phone:

| Command          | Alias   | Description                                                 |
| ---------------- | ------- | ----------------------------------------------------------- |
| `./mc daemon`    | `start` | Start the background server.                                |
| `./mc pair`      |         | Generate a temporary 6-digit code for the Android app.      |
| `./mc send-text` | `st`    | Tell the daemon to push a text message down to the phone.   |
| `./mc send-file` | `sf`    | Choose a local file and stream it down.                     |
| `./mc clipboard` | `cb`    | Grabs your current PC clipboard and pushes it to the phone. |
| `./mc devices`   |         | View paired devices and tokens.                             |
| `./mc status`    |         | Print server config and health.                             |

## Data Directory

Configuration and paired device tokens are stored locally in your home directory, in `.mcsync/`.

- `config.json`
- `devices.enc` (AES-256-GCM encrypted database of paired phones)
- `received/` (Incoming files from the phone pop up here)

## Manual Clipboard Sync

By default, the server does not continuously scrape the clipboard (to prevent X11/Wayland spam). To sync a clipboard string from the PC to the phone, run:

```bash
./mc clipboard
# Or
./mc cb
```

To sync your phone's clipboard back to the PC, simply hit the **"Sync Clip"** button in the mobile app.
