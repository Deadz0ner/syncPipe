package main

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"mcsync/internal/clipboard"
	"mcsync/internal/config"
	"mcsync/internal/discovery"
	"mcsync/internal/server"
	"mcsync/internal/store"
)

const version = "1.0.0"

const banner = `
                _____                  
  _ __ ___   __|_____|_   _ _ __   ___ 
 | '_ ' _ \ / __/ __| | | | '_ \ / __|
 | | | | | | (__\__ \ |_| | | | | (__ 
 |_| |_| |_|\___|___/\__, |_| |_|\___|
                       |___/            
  Terminal-Driven Phone ↔ PC Sync (Go)
  v%s
`

// Global references so REPL commands can use the running server
var (
	srv         *server.Server
	cfg         *config.Config
	deviceStore *store.Store
	consoleMu   sync.Mutex
)

// safeWriter ensures that background logs don't overwrite the REPL prompt
type safeWriter struct {
	out io.Writer
}

func (w safeWriter) Write(p []byte) (n int, err error) {
	consoleMu.Lock()
	defer consoleMu.Unlock()

	// Clear current line (where prompt might be)
	fmt.Fprint(w.out, "\r\033[K")

	// Write the log message
	n, err = w.out.Write(p)

	// Redraw prompt if it's supposed to be there
	fmt.Fprint(w.out, "mcSync> ")
	return
}

func firstRunSetup(cfg *config.Config) {
	fmt.Println(`
  ╔═══════════════════════════════════════════════════════╗
  ║           📂 First-Time Setup — File Storage          ║
  ╠═══════════════════════════════════════════════════════╣
  ║                                                       ║
  ║  mcSync needs a directory to save files received      ║
  ║  from your phone.                                     ║
  ║                                                       ║
  ║  Current default:                                     ║`)
	fmt.Printf("  ║    %-47s║\n", cfg.ReceiveDir)
	fmt.Println(`  ║                                                       ║
  ║  Press ENTER to keep the default, or type a new       ║
  ║  absolute path (e.g. /home/user/Downloads/mcSync).    ║
  ╚═══════════════════════════════════════════════════════╝`)
	fmt.Println()
	fmt.Print("  Save received files to: ")

	scanner := bufio.NewScanner(os.Stdin)
	if scanner.Scan() {
		input := strings.TrimSpace(scanner.Text())
		if input != "" {
			resolvedPath, err := filepath.Abs(input)
			if err == nil {
				if err := os.MkdirAll(resolvedPath, 0755); err == nil {
					cfg.ReceiveDir = resolvedPath
					fmt.Printf("\n  ✓ Receive directory set to: %s\n", resolvedPath)
				} else {
					fmt.Printf("\n  ✗ Could not create directory: %v\n", err)
					fmt.Printf("  → Keeping default: %s\n", cfg.ReceiveDir)
				}
			} else {
				fmt.Printf("\n  ✗ Invalid path: %v\n", err)
				fmt.Printf("  → Keeping default: %s\n", cfg.ReceiveDir)
			}
		} else {
			fmt.Printf("\n  ✓ Using default: %s\n", cfg.ReceiveDir)
		}
	}

	cfg.FirstRun = false
	if err := cfg.Save(); err != nil {
		fmt.Printf("  ✗ Failed to save config: %v\n", err)
	}
}

func main() {
	fmt.Printf(banner, version)

	// Load config
	var err error
	cfg, err = config.Load()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Generate device ID if not set
	if cfg.DeviceID == "" {
		id, err := store.GenerateDeviceID()
		if err != nil {
			log.Fatalf("Failed to generate device ID: %v", err)
		}
		cfg.DeviceID = id
		if err := cfg.Save(); err != nil {
			log.Fatalf("Failed to save config: %v", err)
		}
	}

	if cfg.FirstRun {
		firstRunSetup(cfg)
	}

	// Open encrypted device store
	deviceStore, err = store.NewStore(cfg.DataDir)
	if err != nil {
		log.Fatalf("Failed to open device store: %v", err)
	}

	// Create and start server in the background
	srv = server.New(cfg, deviceStore)
	if err := srv.Start(); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}

	localIP := discovery.GetLocalIP()
	fmt.Printf("\n  ✓ Server running on %s:%d\n", localIP, cfg.Port)
	fmt.Printf("  ✓ Device: %s\n", cfg.DeviceName)
	fmt.Printf("  ✓ Receive directory: %s\n", cfg.ReceiveDir)
	fmt.Println()
	fmt.Println("  Type 'help' for available commands.")
	fmt.Println()

	// Handle Ctrl+C gracefully
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Println("\n  Shutting down...")
		srv.Stop()
		os.Exit(0)
	}()

	// Setup safe logging for REPL
	log.SetFlags(0)
	log.SetPrefix("  [log] ")
	log.SetOutput(safeWriter{out: os.Stdout})

	// Start the interactive REPL
	repl()
}

func repl() {
	scanner := bufio.NewScanner(os.Stdin)

	for {
		// No need to Lock here as Scan() is blocking and we want the prompt to appear initially
		fmt.Print("mcSync> ")

		if !scanner.Scan() {
			break // EOF or error
		}

		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		parts := strings.Fields(line)
		cmd := strings.ToLower(parts[0])
		args := parts[1:]

		switch cmd {
		case "pair", "p":
			cmdPair()
		case "send-text", "st", "text":
			if len(args) == 0 {
				fmt.Println("  Usage: send-text <message>")
				continue
			}
			cmdSendText(strings.Join(args, " "))
		case "send-file", "sf", "file":
			if len(args) == 0 {
				fmt.Println("  Usage: send-file <filepath>")
				continue
			}
			cmdSendFile(args[0])
		case "clipboard", "cb", "clip":
			cmdClipboard()
		case "devices", "ls":
			cmdDevices()
		case "status":
			cmdStatus()
		case "connected":
			cmdConnected()
		case "rename", "rn":
			if len(args) == 0 {
				fmt.Printf("  Current name: %s\n", cfg.DeviceName)
				fmt.Println("  Usage: rename <new_name>")
				continue
			}
			newName := strings.Join(args, " ")
			cfg.DeviceName = newName
			cfg.Save()
			if srv != nil {
				srv.UpdateDeviceName(newName)
			}
			fmt.Printf("  ✓ Device name changed to: %s\n", newName)
		case "set-dir", "sd", "savedir":
			if len(args) == 0 {
				fmt.Printf("  Current receive directory: %s\n", cfg.ReceiveDir)
				fmt.Println("  Usage: set-dir <path>")
				continue
			}
			newDir, err := filepath.Abs(strings.Join(args, " "))
			if err != nil {
				fmt.Printf("  ✗ Invalid path: %v\n", err)
				continue
			}
			if err := os.MkdirAll(newDir, 0755); err != nil {
				fmt.Printf("  ✗ Failed to create directory: %v\n", err)
				continue
			}
			cfg.ReceiveDir = newDir
			cfg.Save()
			fmt.Printf("  ✓ Receive directory changed to: %s\n", newDir)
		case "help", "h", "?":
			cmdHelp()
		case "clear", "cls":
			fmt.Print("\033[H\033[2J")
		case "quit", "exit", "q":
			fmt.Println("  Shutting down...")
			srv.Stop()
			return
		default:
			fmt.Printf("  Unknown command: %s — type 'help' for the list.\n", cmd)
		}
	}
}

// ─── REPL Commands ───────────────────────────────────────

func cmdHelp() {
	fmt.Print(`
  ╔════════════════════════════════════════════════════════╗
  ║               mcSync Commands (Go)                     ║
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

  Aliases: pair(p) text(st) file(sf) clip(cb) devices(ls) rename(rn) set-dir(sd) quit(q,exit)

`)
}

func cmdPair() {
	code, err := srv.StartPairing()
	if err != nil {
		fmt.Printf("  ✗ Failed to generate pairing code: %v\n", err)
		return
	}

	localIP := discovery.GetLocalIP()
	fmt.Println()
	fmt.Println("  ╔═══════════════════════════════════════╗")
	fmt.Println("  ║         mcSync Device Pairing         ║")
	fmt.Println("  ╠═══════════════════════════════════════╣")
	fmt.Printf("  ║                                       ║\n")
	fmt.Printf("  ║     Pairing Code:  %s              ║\n", code)
	fmt.Printf("  ║                                       ║\n")
	fmt.Printf("  ║     Server: %s:%d          ║\n", padRight(localIP, 10), cfg.Port)
	fmt.Printf("  ║                                       ║\n")
	fmt.Println("  ║  Open the mcSync app on your phone    ║")
	fmt.Println("  ║  and enter this code to pair.         ║")
	fmt.Printf("  ║                                       ║\n")
	fmt.Println("  ║  Code expires in 5 minutes.           ║")
	fmt.Println("  ╚═══════════════════════════════════════╝")
	fmt.Println()
}

func cmdSendText(text string) {
	if err := srv.SendText("", text); err != nil {
		fmt.Printf("  ✗ Failed to send text: %v\n", err)
		return
	}
	fmt.Printf("  ✓ Sent: %s\n", truncate(text, 60))
}

func cmdSendFile(path string) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		fmt.Printf("  ✗ Invalid path: %v\n", err)
		return
	}

	info, err := os.Stat(absPath)
	if err != nil {
		fmt.Printf("  ✗ File not found: %v\n", err)
		return
	}
	if info.IsDir() {
		fmt.Println("  ✗ Cannot send directories. Specify a file.")
		return
	}

	fmt.Printf("  Sending %s (%s)...\n", info.Name(), formatSize(info.Size()))

	if err := srv.SendFile("", absPath); err != nil {
		fmt.Printf("  ✗ Failed to send file: %v\n", err)
		return
	}

	fmt.Printf("  ✓ File sent: %s\n", info.Name())
}

func cmdClipboard() {
	content, err := clipboard.Read()
	if err != nil {
		fmt.Printf("  ✗ Failed to read clipboard: %v\n", err)
		return
	}

	if content == "" {
		fmt.Println("  ✗ Clipboard is empty.")
		return
	}

	if err := srv.SendClipboard("", content); err != nil {
		fmt.Printf("  ✗ Failed to send clipboard: %v\n", err)
		return
	}

	fmt.Printf("  ✓ Clipboard sent: %s\n", truncate(content, 60))
}

func cmdDevices() {
	devices := deviceStore.ListDevices()
	if len(devices) == 0 {
		fmt.Println("  No paired devices. Type 'pair' to add one.")
		return
	}

	fmt.Println()
	fmt.Println("  Paired Devices:")
	fmt.Println("  ───────────────────────────────────────")
	for _, d := range devices {
		fmt.Printf("  • %s\n", d.DeviceName)
		fmt.Printf("    ID:        %s...\n", d.DeviceID[:16])
		fmt.Printf("    Paired:    %s\n", d.PairedAt.Format("2006-01-02 15:04"))
		fmt.Printf("    Last Seen: %s\n", d.LastSeen.Format("2006-01-02 15:04"))
		fmt.Println()
	}
}

func cmdConnected() {
	devs := srv.GetConnectedDevices()
	if len(devs) == 0 {
		fmt.Println("  No devices currently connected.")
		return
	}

	fmt.Println()
	fmt.Println("  Connected Devices:")
	for i, id := range devs {
		fmt.Printf("  %d. %s\n", i+1, id)
	}
	fmt.Println()
}

func cmdStatus() {
	localIP := discovery.GetLocalIP()
	devs := srv.GetConnectedDevices()
	fmt.Println()
	fmt.Println("  mcSync Status (Go)")
	fmt.Println("  ─────────────────────────────")
	fmt.Printf("  Device:     %s\n", cfg.DeviceName)
	fmt.Printf("  Local IP:   %s\n", localIP)
	fmt.Printf("  Port:       %d\n", cfg.Port)
	fmt.Printf("  Data Dir:   %s\n", cfg.DataDir)
	fmt.Printf("  Connected:  %d device(s)\n", len(devs))
	fmt.Println()
}

// ─── Helpers ─────────────────────────────────────────────

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

func formatSize(bytes int64) string {
	const (
		KB = 1024
		MB = KB * 1024
		GB = MB * 1024
	)
	switch {
	case bytes >= GB:
		return fmt.Sprintf("%.1f GB", float64(bytes)/float64(GB))
	case bytes >= MB:
		return fmt.Sprintf("%.1f MB", float64(bytes)/float64(MB))
	case bytes >= KB:
		return fmt.Sprintf("%.1f KB", float64(bytes)/float64(KB))
	default:
		return fmt.Sprintf("%d B", bytes)
	}
}

func padRight(s string, length int) string {
	if len(s) >= length {
		return s
	}
	return s + strings.Repeat(" ", length-len(s))
}
