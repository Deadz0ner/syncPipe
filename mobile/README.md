# mcSync Mobile App

The mobile application for mcSync is built in React Native. It connects to the PC daemon via a local persistent WebSocket.

## Setup

The app is now built with **Expo**, which means you do not need Java, Android Studio, Gradle, or ADB installed on your PC to test it.

```bash
cd mobile
npm install
npm run start
```

## How to Test on Your Phone

1. Install the **"Expo Go"** app from the Google Play Store or Apple App Store on your smartphone.
2. Make sure your PC and phone are on the **same Wi-Fi network**.
3. Run the PC daemon (`cd ../pc && ./mc daemon`).
4. Run `npm run start` inside the `mobile` folder on your PC.
5. Scan the gigantic QR code that prints in your terminal using your phone's camera (or directly within the Expo Go app). The app will instantly bundle and launch on your phone!

## Sending Data

- **Send Text:** Write a quick note in the dashboard.
- **Send File:** Send an image, video, or arbitrary file from internal storage. Files chunk into Base64 pieces over WebSocket and stream directly onto the PC's drive.
- **Sync Clipboard:** Tap **"Sync Clip"** to manually grab your phone's clipboard and overwrite your PC's clipboard.

## File Hierarchy

- `/src/services/WebSocketService.js` (Singleton handling connect/disconnect/ping/auth/routing messages)
- `/src/services/FileTransferService.js` (Breaks files up sequentially with delays and pushes them via WebSocket)
- `/src/services/ClipboardService.js` (Handles one-off reads/writes to NativeClipboard component)
- `/src/stores/DeviceStore.js` (Handles encrypted persistence of servers + settings)
- `/src/screens/...` (Dumb view components that call into singletons)

## Libraries

- `@react-navigation/core`: Stack and routing
- `react-native-fs`: Accessing storage block paths and sizes
- `@react-native-clipboard/clipboard`: Basic text scraping and writing
- `@react-native-async-storage`: Lightweight local configs
- `react-native-image-picker`: Simple image/video attachments
