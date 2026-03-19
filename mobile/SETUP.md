# mcSync Mobile App - Setup & Deployment Guide

## Overview

**mcSync** is a React Native mobile application built with Expo that enables seamless synchronization of files, text, and clipboard content between your phone and PC.

**Branding**: Dark theme app with a modern icon featuring a connection symbol.

---

## Assets & Branding

### Logo
- **Primary Icon**: `assets/icon.png` (512×512, dark theme)
- **iOS Touch Icon**: `assets/apple-touch-icon.png` (180×180)
- **Favicon**: `assets/favicon.png` (192×192)
- **Android Adaptive Icons**:
  - Foreground: `android-icon-foreground.png` (512×512)
  - Background: `android-icon-background.png` (512×512, #0D1117)
  - Monochrome: `android-icon-monochrome.png` (432×432)

### Color Scheme
- **Primary Background**: `#0D1117` (Dark navy)
- **Primary Text**: `#E6EDF3` (Light gray)
- **Accent Blue**: `#1F6FEB`
- **Accent Green**: `#238636`

---

## Development Setup

### Prerequisites
```bash
Node.js 18+
npm or yarn
Expo CLI: npm install -g expo-cli
```

### Install Dependencies
```bash
cd mobile
npm install
```

### Run on Simulator/Emulator
```bash
# iOS (macOS only)
npm run ios

# Android
npm run android

# Web
npm run web
```

### Run Development Server
```bash
npm run start
```

---

## Code Quality

### Linting & Formatting
```bash
# Check code quality
npm run lint

# Auto-format code
npm run format

# TypeScript type checking
npm run type-check
```

### Pre-commit Hook (Recommended)
Create `.husky/pre-commit`:
```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"
npm run lint --fix
```

---

## Building for App Stores

### iOS Build

#### Prerequisites
- Apple Developer Account ($99/year)
- Xcode 15+
- Valid iOS provisioning profile

#### Build Command
```bash
eas build --platform ios --profile production
```

#### App Store Submission
1. Upload signed build to App Store Connect
2. Fill in app details, screenshots, description
3. Submit for review (typically 24-48 hours)

### Android Build

#### Prerequisites
- Google Play Developer Account ($25 one-time)
- Valid keystore file

#### Build Command
```bash
eas build --platform android --profile production
```

#### Play Store Submission
1. Upload signed AAB to Google Play Console
2. Fill in app details and content rating
3. Submit for review (typically 2-4 hours)

---

## Configuration Files

### `app.json`
Main Expo configuration file containing:
- App metadata (name, version, description)
- Icons and splash screen
- iOS/Android specific settings
- Permissions
- Web manifest reference
- EAS project ID

**Key Settings:**
- `name`: "mcSync"
- `slug`: "mcsync" (used in URLs)
- `scheme`: "mcsync" (for deep linking)
- `userInterfaceStyle`: "dark"

### `package.json`
Dependencies and scripts:
- React Native 0.81.5
- Expo SDK 54
- Navigation library
- File/clipboard/network APIs
- ESLint + Prettier

### `tsconfig.json`
TypeScript configuration with strict mode enabled.

### `.eslintrc.js`
ESLint rules for code quality.

### `.prettierrc`
Prettier formatting configuration.

---

## Deployments & CI/CD

### Using EAS (Expo Application Services)

#### Configure EAS
```bash
# Login to Expo
eas login

# Set up project
eas init
```

#### Build Profiles
Defined in `eas.json`:
- **development**: For testing with dev client
- **preview**: Internal testing build (APK)
- **production**: App store submission (AAB for Android)

#### Deploy to App Store
```bash
# Build and deploy to both platforms
eas build --platform all --profile production

# Deploy specific platform
eas build --platform ios --profile production
```

---

## Testing

### Manual Testing Checklist

**Connection:**
- [ ] App connects to PC via WiFi pairing
- [ ] Reconnects after network drop
- [ ] Handles invalid IP/port gracefully
- [ ] Shows proper connection status

**File Transfer:**
- [ ] Upload files from phone to PC
- [ ] Download files from PC to phone
- [ ] Handle large files (>100MB)
- [ ] Show progress during transfer
- [ ] Handle interrupted transfers

**Text/Clipboard:**
- [ ] Send text messages to PC
- [ ] Receive text from PC
- [ ] Sync clipboard content
- [ ] Handle special characters

**UI/UX:**
- [ ] Dark theme renders correctly
- [ ] Icons display properly
- [ ] Navigation works smoothly
- [ ] Error messages are clear
- [ ] App recovers from crashes (ErrorBoundary)

**Platform Specific:**
- [ ] **iOS**: Permissions, app icon, notch safety
- [ ] **Android**: Adaptive icons, storage access, Android 13+ compliance

---

## Web Version

### PWA Features
- Service Worker for offline support
- Manifest for installability
- Web app shortcuts
- Splash screen

### Deployment
```bash
# Build for web
npm run web

# Or use Expo Export
expo export --platform web --output-dir dist
```

Serve via Firebase Hosting, Vercel, or Netlify:
```bash
firebase deploy
# or
vercel deploy dist
# or
netlify deploy --prod --dir dist
```

---

## Environment Variables

Create `.env` file (not committed):
```env
EXPO_DEBUG=true
API_BASE_URL=https://api.mcsync.app
```

Reference in code:
```javascript
import Constants from 'expo-constants';
const apiUrl = Constants.expoConfig?.extra?.apiBaseUrl;
```

---

## Troubleshooting

### Build Issues

**"CocoaPods dependency"** error on iOS:
```bash
rm -rf ios/Pods ios/Podfile.lock
eas build --platform ios --profile production
```

**"Gradle sync"** error on Android:
```bash
cd android
./gradlew clean
cd ..
eas build --platform android --profile production
```

### Runtime Issues

**"Invalid auth token"** error:
- Check saved credentials in app settings
- Delete app data and re-pair with PC
- Verify PC is running and accessible

**"File permission denied"** on Android:
- Grant storage permissions in app settings
- For Android 11+, use Files app to grant access
- Check SAF (Storage Access Framework) setup

**"Connection refused"** when pairing:
- Ensure phone and PC are on same WiFi
- Check PC is running sync server
- Verify firewall allows port 9090

---

## Security

### Best Practices
1. ✅ Use HTTPS for all network requests
2. ✅ Don't store sensitive data in AsyncStorage
3. ✅ Validate all server responses
4. ✅ Clear auth tokens on logout
5. ✅ Use ErrorBoundary to prevent crashes

### Privacy
- No analytics tracking
- No user data collection
- Credentials only stored locally
- All data synced over encrypted connections

---

## Maintenance

### Regular Updates
- Update Expo SDK quarterly
- Update React Native with major releases
- Update dependencies using `npm update`
- Review and apply security patches

### Performance Optimization
- Message list capped at 100 items (prevents memory leaks)
- Lazy-load screens using React Navigation
- Optimize file chunks (61KB default)
- Use ErrorBoundary for crash recovery

### Monitoring
- Set up Sentry for crash reporting
- Monitor network requests
- Track app performance metrics
- Gather user feedback

---

## Resources

- [Expo Documentation](https://docs.expo.dev/)
- [React Native Docs](https://reactnative.dev/)
- [EAS Build Guide](https://docs.expo.dev/build/introduction/)
- [Apple App Store Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Google Play Store Guidelines](https://play.google.com/console/about/guides/playpolicies/)

---

## Support & Contribution

- 🐛 **Bug Reports**: [GitHub Issues](https://github.com/svnsh/mcsync/issues)
- 💡 **Feature Requests**: [GitHub Discussions](https://github.com/svnsh/mcsync/discussions)
- 🔧 **Contributing**: See CONTRIBUTING.md

---

**Last Updated**: March 19, 2026
**App Version**: 1.0.0
**Maintained By**: mcSync Team
