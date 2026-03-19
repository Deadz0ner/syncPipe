/**
 * mcSync Color Theme
 * Centralized color palette for consistent UI across all screens
 * Based on GitHub dark theme
 */

export const COLORS = {
  // Backgrounds
  background: {
    primary: '#0D1117',    // Main app background
    surface: '#161B22',    // Cards, inputs, elevated surfaces
    surfaceLight: '#161B2266', // 40% alpha
  },

  // Text
  text: {
    primary: '#E6EDF3',    // Primary text, titles
    secondary: '#8B949E',  // Subtitles, labels, metadata
    tertiary: '#484F58',   // Dimmed text, timestamps
    muted: '#5C6370',      // Placeholder text
  },

  // Accents
  accent: {
    blue: '#1F6FEB',       // Primary action, links, progress
    green: '#238636',      // Success, positive actions
    amber: '#FFC107',      // Connected but not authenticated
    orange: '#FF9800',     // Connecting/reconnecting
    red: '#F44336',        // Error, failed, destructive
    redDark: '#F85149',    // Alternative red (for text)
    brightGreen: '#00E676', // Authenticated status (pulse)
    lightGreen: '#7EE787',  // Pairing success, code text
  },

  // Borders & Dividers
  border: '#21262D',
  divider: '#21262D',

  // Status indicators
  status: {
    authenticated: '#00E676',  // Bright green pulse
    connected: '#FFC107',      // Amber (not auth'd)
    connecting: '#FF9800',     // Orange
    error: '#F44336',          // Red
    disconnected: '#78909C',   // Blue-grey
  },

  // Message cards
  messages: {
    sentBackground: '#0D2347',      // Dark blue tint
    sentBorder: '#1F6FEB33',        // Blue with ~20% alpha
    receivedBackground: '#1A2A1F',  // Dark green tint
    receivedBorder: '#2D553533',    // Green with ~20% alpha
  },

  // Action buttons (background colors)
  buttons: {
    pair: '#1A1F35',       // Dark blue
    files: '#1A2A1F',      // Dark green
    syncClip: '#211A2A',   // Dark purple
    settings: '#2A1F1A',   // Dark brown
  },

  // Action button borders
  buttonBorders: {
    pair: '#2D3555',       // Blue
    files: '#2D5535',      // Green
    syncClip: '#352D55',   // Purple
    settings: '#55352D',   // Brown
  },

  // Special
  warningBackground: '#3D2B00',    // Dark amber
  warningBorder: '#6E4B00',        // Amber border
  removeButtonBackground: '#3D1114', // Dark red
  removeButtonBorder: '#6E2127',   // Red border
  removeLabelColor: '#F85149',     // Red text
  noDiscoveryBackground: '#161B2266', // Surface color at 40% alpha
};

// Export individual color functions for convenience
export const bgColor = () => COLORS.background.primary;
export const textColor = () => COLORS.text.primary;
export const accentColor = () => COLORS.accent.blue;
