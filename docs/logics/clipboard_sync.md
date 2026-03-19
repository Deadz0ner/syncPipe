# Clipboard Synchronization Logic

This document details the theory and logic behind clipboard synchronization across the mcSync application.

## 1. Amount of Clipboard Transferred

**100% of the active text content.**
There is no truncation, artificial size limit, or chunking applied to clipboard synchronization. The complete text string currently residing in your system's text clipboard is wrapped into a single WebSocket JSON payload and pushed to the receiving device.
_(Note: Only plain text is transferred. The underlying OS tools strictly interact with text buffers, so images or rich files copied to your clipboard are ignored)._

## 2. Triggering Logic (On-Demand)

Initially, the application was designed with a `ClipboardMonitor` that periodically polled the system clipboard every 1-1.5 seconds looking for new changes.

However, this background observation loop has been **explicitly disabled** in both the Node.js/Go PC versions and the Mobile version to prevent system stuttering and lag. Synchronization is now completely **on-demand**.

### Setting Flow (PC -> Mobile)

1. You type the `clip` (or `clipboard`, `cb`) command into your PC app's terminal REPL.
2. The PC instance immediately attempts to read your system's clipboard.
3. The server packages the entire string into a `CLIPBOARD` type message (`{ content: "...", source: "pc" }`), and emits it over the active WebSocket connection to the connected mobile device.
4. The Mobile app receives this message via WebSocket. To prevent an infinite echo loop, it sets an internal flag (`_ignoreNext`), overwrites the mobile's clipboard text using `expo-clipboard`, and displays an alert indicating success.

### Setting Flow (Mobile -> PC)

1. You trigger the clipboard send natively from the Mobile UI (via a dedicated button invoking `clipboardService.sendCurrent()`).
2. The Mobile app extracts its own clipboard data via `expo-clipboard` and pushes it over the WebSocket wrapped as a `CLIPBOARD` message.
3. The PC WebSocket receives the `CLIPBOARD` event and blindly passes the string to a native writer function, overwriting your PC's active native clipboard with the new text.

## 3. Native Clipboard Access Strategy

The application does not interact with low-level OS APIs directly. Instead, it utilizes an abstraction layer to shell-out commands:

- **In the Node.js Version**: It uses a third-party npm package named `clipboardy`. When it needs to read or write, `clipboardy` detects your operating system and executes the relevant native command-line utility in the background (like reading the standard output of `xsel` / `xclip` on Linux, `pbpaste` on macOS, or PowerShell on Windows).
- **In the Go Version**: It implements this behavior completely manually. It attempts to auto-detect your active display server natively. It checks if `wl-paste` (for Wayland) is installed first. If not found, it falls back to looking for `xclip`, and finally `xsel` (for X11). Once it identifies an available utility, it uses Go's `os/exec` package to secretly run the tool (e.g., `wl-paste --no-newline`) and captures everything returned in `stdout` as the clipboard string. To write, it reverses the process, piping text directly into the standard input of commands like `wl-copy`.
- **In the Mobile Version**: It utilizes Expo's well-supported native module `expo-clipboard` (`getStringAsync` and `setStringAsync`), which securely interfaces with iOS/Android's native pasteboards.
