const readline = require("readline");
const path = require("path");
const { Config } = require("./internal/config");
const Store = require("./internal/store");
const Server = require("./internal/server");
const ClipboardMonitor = require("./internal/clipboard");
const DiscoveryService = require("./internal/discovery");

const version = "1.0.0";
const banner = `
                _____                  
  _ __ ___   __|_____|_   _ _ __   ___ 
 | '_ ' _ \\ / __/ __| | | | '_ \\ / __|
 | | | | | | (__\\__ \ |_| | | | | (__ 
 |_| |_| |_|\\___|___/\\__, |_| |_|\\___|
                       |___/            
  Terminal-Driven Phone ↔ PC Sync (Node.js)
  v1.0.0
`;

async function main() {
  process.stdout.write(banner);

  const cfg = await Config.load();
  if (!cfg.device_id) {
    cfg.device_id = Store.generateDeviceID();
    await cfg.save();
  }

  const store = await Store.create(cfg.data_dir);
  const server = new Server(cfg, store);
  await server.start();

  const clip = new ClipboardMonitor();
  if (cfg.clipboard_sync) {
    await clip.start();
    clip.on("change", (content) => {
      const devs = server.getConnectedDevices();
      if (devs.length > 0) {
        server.sendClipboard(null, content).catch(() => {});
      }
    });
    server.on("clipboard", (content) => {
      clip.write(content);
    });
  }

  const localIP = DiscoveryService.getLocalIP();
  process.stdout.write(`\n  ✓ Server running on ${localIP}:${cfg.port}\n`);
  process.stdout.write(`  ✓ Device: ${cfg.device_name}\n`);
  process.stdout.write(`  ✓ Receive directory: ${cfg.receive_dir}\n\n`);
  process.stdout.write(`  Type 'help' for available commands.\n\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "mcSync-node> ",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    const parts = input.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    try {
      switch (command) {
        case "pair":
        case "p":
          await cmdPair(server, cfg);
          break;
        case "send-text":
        case "st":
        case "text": {
          if (args.length === 0) {
            process.stdout.write("  Usage: send-text <message>\n");
          } else {
            const text = args.join(" ");
            await server.sendText(null, text);
            process.stdout.write(
              `  ✓ Sent: ${text.length > 60 ? text.slice(0, 60) + "..." : text}\n`,
            );
          }
          break;
        }
        case "send-file":
        case "sf":
        case "file": {
          if (args.length === 0) {
            process.stdout.write("  Usage: send-file <filepath>\n");
          } else {
            const filePath = path.resolve(args[0]);
            await server.sendFile(null, filePath);
            process.stdout.write(`  ✓ File sent: ${path.basename(filePath)}\n`);
          }
          break;
        }
        case "clipboard":
        case "cb":
        case "clip": {
          const content = await clip.read();
          if (!content) {
            process.stdout.write("  ✗ Clipboard is empty.\n");
          } else {
            await server.sendClipboard(null, content);
            process.stdout.write(
              `  ✓ Clipboard sent: ${content.length > 60 ? content.slice(0, 60) + "..." : content}\n`,
            );
          }
          break;
        }
        case "devices":
        case "ls":
          cmdDevices(store);
          break;
        case "status":
          cmdStatus(cfg, server);
          break;
        case "connected":
          cmdConnected(server);
          break;
        case "help":
        case "h":
        case "?":
          cmdHelp();
          break;
        case "clear":
        case "cls":
          console.clear();
          break;
        case "quit":
        case "exit":
        case "q":
          rl.close();
          return;
        default:
          process.stdout.write(
            `  Unknown command: ${command} — type 'help' for the list.\n`,
          );
      }
    } catch (err) {
      process.stdout.write(`  ✗ Error: ${err.message}\n`);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    process.stdout.write("\n  Shutting down...\n");
    server.stop();
    clip.stop();
    process.exit(0);
  });
}

function cmdHelp() {
  process.stdout.write(`
  ╔═══════════════════════════════════════════════════╗
  ║              mcSync Commands (Node.js)            ║
  ╠════════════╦══════════════════════════════════════╣
  ║ pair       ║ Generate a pairing code              ║
  ║ text <msg> ║ Send text to phone                   ║
  ║ file <path>║ Send a file to phone                 ║
  ║ clip       ║ Send PC clipboard to phone           ║
  ║ devices    ║ List paired devices                  ║
  ║ connected  ║ Show currently connected devices     ║
  ║ status     ║ Show server status                   ║
  ║ clear      ║ Clear the screen                     ║
  ║ quit       ║ Stop the server and exit             ║
  ╚════════════╩══════════════════════════════════════╝

  Aliases: pair(p) text(st) file(sf) clip(cb) devices(ls) quit(q,exit)\n\n`);
}

async function cmdPair(server, cfg) {
  const code = await server.startPairing();
  const localIP = DiscoveryService.getLocalIP();

  process.stdout.write(`
  ╔═══════════════════════════════════════╗
  ║         mcSync Device Pairing         ║
  ╠═══════════════════════════════════════╣
  ║                                       ║
  ║     Pairing Code:  ${code}              ║
  ║                                       ║
  ║     Server: ${localIP.padEnd(15)} : ${cfg.port.toString().padEnd(5)} ║
  ║                                       ║
  ║  Open the mcSync app on your phone    ║
  ║  and enter this code to pair.         ║
  ║                                       ║
  ║  Code expires in 5 minutes.           ║
  ╚═══════════════════════════════════════╝\n\n`);
}

function cmdDevices(store) {
  const devices = store.listDevices();
  if (devices.length === 0) {
    process.stdout.write("  No paired devices. Type 'pair' to add one.\n");
    return;
  }

  process.stdout.write("\n  Paired Devices:\n");
  process.stdout.write("  ───────────────────────────────────────\n");
  devices.forEach((d) => {
    process.stdout.write(`  • ${d.device_name}\n`);
    process.stdout.write(`    ID:        ${d.device_id.slice(0, 16)}...\n`);
    process.stdout.write(
      `    Paired:    ${new Date(d.paired_at).toLocaleString()}\n`,
    );
    process.stdout.write(
      `    Last Seen: ${new Date(d.last_seen).toLocaleString()}\n\n`,
    );
  });
}

function cmdConnected(server) {
  const devs = server.getConnectedDevices();
  if (devs.length === 0) {
    process.stdout.write("  No devices currently connected.\n");
    return;
  }

  process.stdout.write("\n  Connected Devices:\n");
  devs.forEach((id, i) => {
    process.stdout.write(`  ${i + 1}. ${id}\n`);
  });
  process.stdout.write("\n");
}

function cmdStatus(cfg, server) {
  const localIP = DiscoveryService.getLocalIP();
  const devs = server.getConnectedDevices();
  process.stdout.write(`
  mcSync Status (Node.js)
  ─────────────────────────────
  Device:     ${cfg.device_name}
  Local IP:   ${localIP}
  Port:       ${cfg.port}
  Data Dir:   ${cfg.data_dir}
  Connected:  ${devs.length} device(s)\n\n`);
}

main().catch(console.error);
