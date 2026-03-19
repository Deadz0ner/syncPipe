# Architectural Comparison: mcSync vs. KDE Connect vs. Syncthing

This document explores how our `mcSync` application compares to established local network syncing and file transfer utilities like **KDE Connect** and **Syncthing**.

---

## How does KDE Connect handle sending files over a LAN?

Interestingly, the underlying architecture of `mcSync` operates very similarly to KDE Connect! Both applications aim to provide seamless, ad-hoc connectivity between devices on the same local network. Here is a breakdown of their approach compared to ours:

### 1. Discovery (UDP Broadcasts)

Just like `mcSync`, KDE Connect starts the pairing process by blasting out simple, cleartext **UDP datagrams** across the Local Area Network (specifically, the broadcast domain) on dynamic ports.

- **KDE Connect:** Broadcasts a JSON identifying string saying: _"Hey, I am Device XYZ, and I am listening for TCP connections on Port 1716!"_
- **mcSync:** Utilizes the `mDNS` protocol to achieve the exact same zero-configuration network discovery.

### 2. Connection (TCP) and Encryption

Once two devices notice each other's UDP broadcasts, they establish a direct, node-to-node **TCP connection**. This ensures there are no external cloud servers routing your data.

- **The Difference:** KDE Connect secures its TCP connection using **Transport Layer Security (TLS)** encryption.
- **mcSync:** Currently sends JSON and binary data directly over WebSockets in the open. While our connections are still safe against remote attacks (as they don't leave the local Wi-Fi), adding TLS would protect against local packet sniffing. _(See `updates._can_do.md`)_

### 3. Small Payloads and Control Messages (JSON)

For lightweight data—such as controlling media playback, syncing clipboards, and sending notification texts—KDE Connect uses a strict **JSON-based protocol** passed back and forth on the established TCP socket. `mcSync` uses the exact same approach for our `TEXT` and `CLIPBOARD` messages.

### 4. Binary Files (SFTP vs. Direct HTTP-like Transfer)

When it comes time to transfer large binary files, KDE Connect behaves differently depending on the user's intent:

- **If browsing remotely:** It uses **SFTP (SSH File Transfer Protocol)**. This mounts the phone's internal memory file-system directly to the PC's desktop (using the KDE file browser, or similar), allowing transparent, remote copying.
- **If sharing directly (AirDrop style):** For direct file drops—which is exactly what `mcSync` does—KDE Connect spins up a temporary **HTTP-like server** on the device holding the file. It then sends the receiver the exact IP/Port over the JSON control channel, telling the receiver to "download" that binary blob directly.

**Why does this matter?** KDE Connect purposely avoids encoding large files as base64 or passing them as raw JSON strings. They use dedicated binary transfer mechanisms (SFTP or HTTP streams) to prevent the exact memory overflow and JavaScript bridge issues we experienced in earlier builds of `mcSync`!

---

## What about Syncthing? (And why we aren't using that approach)

While `mcSync` and KDE Connect focus on _ad-hoc_, immediate "Send File to Phone" interactions, **Syncthing** solves a fundamentally different problem.

Syncthing is an entirely decentralized application that operates continuously in the background to keep entire directory structures synchronized across multiple machines.

### How Syncthing Works:

1. **Block-Level Hashing:** Instead of sending a file continuously as a distinct stream, Syncthing cuts every monitored file into tiny blocks.
2. **Database Generation:** It builds and maintains a local database containing the cryptographic hashes of all blocks across thousands of files.
3. **Delta Merging:** When a small change happens to a 1GB file on the PC, Syncthing compares hashes with the phone and transmits _only_ the specific blocks that were modified, rather than re-transmitting the entire file.

**Conclusion:** Syncthing's block-level synchronization is insanely powerful for automatically keeping huge folders identical on 5 computers at once. However, it acts more like a complex **background file-system daemon** rather than the immediate, lightweight, user-triggered file sending application that `mcSync` provides.
