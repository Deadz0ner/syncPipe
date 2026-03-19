const readline = require("readline");
const path = require("path");
const fs = require("fs-extra");
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

/**
 * First-time setup: ask user where to save received files.
 * Uses a temporary readline interface so the main REPL isn't active yet.
 */
async function firstRunSetup(cfg) {
  return new Promise((resolve) => {
    const setupRl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log(`
  ╔═══════════════════════════════════════════════════════╗
  ║           📂 First-Time Setup — File Storage          ║
  ╠═══════════════════════════════════════════════════════╣
  ║                                                       ║
  ║  mcSync needs a directory to save files received      ║
  ║  from your phone.                                     ║
  ║                                                       ║
  ║  Current default:                                     ║
  ║    ${cfg.receive_dir.padEnd(47)}  ║
  ║                                                       ║
  ║  Press ENTER to keep the default, or type a new       ║
  ║  absolute path (e.g. /home/user/Downloads/mcSync).    ║
  ╚═══════════════════════════════════════════════════════╝
`);

    setupRl.question("  Save received files to: ", async (answer) => {
      const input = answer.trim();
      if (input) {
        const resolvedPath = path.resolve(input);
        try {
          await fs.ensureDir(resolvedPath);
          cfg.receive_dir = resolvedPath;
          console.log(`\n  ✓ Receive directory set to: ${resolvedPath}`);
        } catch (err) {
          console.error(`\n  ✗ Could not create directory: ${err.message}`);
          console.log(`  → Keeping default: ${cfg.receive_dir}`);
        }
      } else {
        console.log(`\n  ✓ Using default: ${cfg.receive_dir}`);
      }

      cfg.first_run = false;
      await cfg.save();
      setupRl.close();
      resolve();
    });
  });
}

async function main() {
  process.stdout.write(banner);

  const cfg = await Config.load();
  if (!cfg.device_id) {
    cfg.device_id = Store.generateDeviceID();
    await cfg.save();
  }

  // ─── First-run: ask where to save received files ───────────
  if (cfg.first_run) {
    await firstRunSetup(cfg);
  }

  const store = await Store.create(cfg.data_dir);

  // Initialize REPL early to handle logging
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "mcSync-node> ",
  });

  let isClosing = false;

  const logger = {
    info: (msg) => {
      if (process.stdout.isTTY) {
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
      }
      console.log(msg);
      if (!isClosing) rl.prompt(true);
    },
    warn: (msg) => {
      if (process.stdout.isTTY) {
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
      }
      console.warn(msg);
      if (!isClosing) rl.prompt(true);
    },
    error: (msg) => {
      if (process.stdout.isTTY) {
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
      }
      console.error(msg);
      if (!isClosing) rl.prompt(true);
    },
  };

  const server = new Server(cfg, store, logger);

  // Note: DiscoveryService is currently created inside server.start in current implementation,
  // but let's check if we can pass logger through.
  // Looking at server.js: this.discovery = new DiscoveryService(this.cfg.port, this.cfg.device_name);
  // I should update server.js to pass this.logger to DiscoveryService.

  await server.start();

  const clip = new ClipboardMonitor(1500, logger);
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
      const lines = (content || "").split("\n");
      let output = `\n  ╭─── 📋 Clipboard Synced ───\n`;
      lines.forEach((line) => {
        output += `  │ ${line}\n`;
      });
      output += `  ╰────────────────────────────────────────\n`;
      logger.info(output);
    });
  }

  const localIP = DiscoveryService.getLocalIP();
  logger.info(`\n  ✓ Server running on ${localIP}:${cfg.port}`);
  logger.info(`  ✓ Device: ${cfg.device_name}`);
  logger.info(`  ✓ Receive directory: ${cfg.receive_dir}\n`);
  logger.info(`  Type 'help' for available commands.\n`);

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
          await cmdPair(server, cfg, logger);
          break;
        case "send-text":
        case "st":
        case "text": {
          if (args.length === 0) {
            logger.info("  Usage: send-text <message>");
          } else {
            const text = args.join(" ");
            await server.sendText(null, text);
            logger.info(
              `  ✓ Sent: ${text.length > 60 ? text.slice(0, 60) + "..." : text}`,
            );
          }
          break;
        }
        case "send-file":
        case "sf":
        case "file": {
          if (args.length === 0) {
            logger.info("  Usage: send-file <filepath>");
          } else {
            const filePath = path.resolve(args[0]);
            await server.sendFile(null, filePath);
            logger.info(`  ✓ File sent: ${path.basename(filePath)}`);
          }
          break;
        }
        case "clipboard":
        case "cb":
        case "clip": {
          const content = await clip.read();
          if (!content) {
            logger.info("  ✗ Clipboard is empty.");
          } else {
            await server.sendClipboard(null, content);
            logger.info(
              `  ✓ Clipboard sent: ${content.length > 60 ? content.slice(0, 60) + "..." : content}`,
            );
          }
          break;
        }
        case "devices":
        case "ls":
          cmdDevices(store, logger);
          break;
        case "status":
          cmdStatus(cfg, server, logger);
          break;
        case "connected":
          cmdConnected(server, logger);
          break;
        case "rename":
        case "rn": {
          if (args.length === 0) {
            logger.info(`  Current name: ${cfg.device_name}`);
            logger.info(`  Usage: rename <new_name>`);
          } else {
            const newName = args.join(" ");
            cfg.device_name = newName;
            await cfg.save();
            if (server.discovery) {
              server.discovery.deviceName = newName;
            }
            logger.info(`  ✓ Device name changed to: ${newName}`);
          }
          break;
        }
        case "set-dir":
        case "sd":
        case "savedir": {
          if (args.length === 0) {
            logger.info(`  Current receive directory: ${cfg.receive_dir}`);
            logger.info(`  Usage: set-dir <path>`);
          } else {
            const newDir = path.resolve(args.join(" "));
            try {
              await fs.ensureDir(newDir);
              cfg.receive_dir = newDir;
              await cfg.save();
              logger.info(`  ✓ Receive directory changed to: ${newDir}`);
            } catch (err) {
              logger.info(`  ✗ Failed: ${err.message}`);
            }
          }
          break;
        }
        case "help":
        case "h":
        case "?":
          cmdHelp(logger);
          break;
        case "clear":
        case "cls":
          console.clear();
          rl.prompt();
          break;
        case "quit":
        case "exit":
        case "q":
          rl.close();
          return;
        default:
          logger.info(
            `  Unknown command: ${command} — type 'help' for the list.`,
          );
      }
    } catch (err) {
      logger.info(`  ✗ Error: ${err.message}`);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    isClosing = true;
    process.stdout.write("\n  Shutting down...\n");
    server.stop();
    clip.stop();
    process.exit(0);
  });
}

function cmdHelp(logger) {
  logger.info(`
  ╔════════════════════════════════════════════════════════╗
  ║               mcSync Commands (Node.js)               ║
  ╠═══════════════╦════════════════════════════════════════╣
  ║ pair          ║ Generate a pairing code               ║
  ║ text <msg>    ║ Send text to phone                    ║
  ║ file <path>   ║ Send a file to phone                  ║
  ║ clip          ║ Send PC clipboard to phone            ║
  ║ devices       ║ List paired devices                   ║
  ║ connected     ║ Show currently connected devices      ║
  ║ rename <name> ║ Change PC device name                 ║
  ║ set-dir <path>║ Change where received files are saved ║
  ║ status        ║ Show server status                    ║
  ║ clear         ║ Clear the screen                      ║
  ║ quit          ║ Stop the server and exit              ║
  ╚═══════════════╩════════════════════════════════════════╝

  Aliases: pair(p) text(st) file(sf) clip(cb) devices(ls) rename(rn) set-dir(sd) quit(q,exit)\n`);
}

async function cmdPair(server, cfg, logger) {
  const code = await server.startPairing();
  const localIP = DiscoveryService.getLocalIP();

  logger.info(`
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
  ╚═══════════════════════════════════════╝\n`);
}

function cmdDevices(store, logger) {
  const devices = store.listDevices();
  if (devices.length === 0) {
    logger.info("  No paired devices. Type 'pair' to add one.");
    return;
  }

  let output = "\n  Paired Devices:\n";
  output += "  ───────────────────────────────────────\n";
  devices.forEach((d) => {
    output += `  • ${d.device_name}\n`;
    output += `    ID:        ${d.device_id.slice(0, 16)}...\n`;
    output += `    Paired:    ${new Date(d.paired_at).toLocaleString()}\n`;
    output += `    Last Seen: ${new Date(d.last_seen).toLocaleString()}\n\n`;
  });
  logger.info(output);
}

function cmdConnected(server, logger) {
  const devs = server.getConnectedDevices();
  if (devs.length === 0) {
    logger.info("  No devices currently connected.");
    return;
  }

  let output = "\n  Connected Devices:\n";
  devs.forEach((id, i) => {
    output += `  ${i + 1}. ${id}\n`;
  });
  logger.info(output);
}

function cmdStatus(cfg, server, logger) {
  const localIP = DiscoveryService.getLocalIP();
  const devs = server.getConnectedDevices();
  logger.info(`
  mcSync Status (Node.js)
  ─────────────────────────────
  Device:     ${cfg.device_name}
  Local IP:   ${localIP}
  Port:       ${cfg.port}
  Data Dir:   ${cfg.data_dir}
  Connected:  ${devs.length} device(s)\n`);
}

main().catch(console.error);
