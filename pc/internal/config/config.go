package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const (
	AppName        = "mcsync"
	DefaultPort    = 9090
	ServiceType    = "_mcsync._tcp"
	ChunkSize      = 64 * 1024   // 64KB chunks for file transfer
	PingInterval   = 15          // seconds
	MaxMessageSize = 1024 * 1024 // 1MB max WebSocket frame
)

// Config holds the application configuration
type Config struct {
	Port          int    `json:"port"`
	DeviceName    string `json:"device_name"`
	DeviceID      string `json:"device_id"`
	DataDir       string `json:"data_dir"`
	ReceiveDir    string `json:"receive_dir"`
	ClipboardSync bool   `json:"clipboard_sync"`
}

// DefaultConfig returns a new config with sensible defaults
func DefaultConfig() *Config {
	homeDir, _ := os.UserHomeDir()
	hostname, _ := os.Hostname()
	dataDir := filepath.Join(homeDir, ".mcsync")
	return &Config{
		Port:          DefaultPort,
		DeviceName:    hostname,
		DeviceID:      "",
		DataDir:       dataDir,
		ReceiveDir:    filepath.Join(dataDir, "received"),
		ClipboardSync: true,
	}
}

// ConfigPath returns the path to the config file
func ConfigPath() string {
	homeDir, _ := os.UserHomeDir()
	return filepath.Join(homeDir, ".mcsync", "config.json")
}

// Load reads the config from disk, falling back to defaults
func Load() (*Config, error) {
	cfg := DefaultConfig()
	path := ConfigPath()

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			// Create default config
			if err := cfg.Save(); err != nil {
				return nil, fmt.Errorf("save default config: %w", err)
			}
			return cfg, nil
		}
		return nil, fmt.Errorf("read config: %w", err)
	}

	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	return cfg, nil
}

// Save writes the config to disk
func (c *Config) Save() error {
	path := ConfigPath()

	// Ensure directory exists
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}

	// Ensure receive dir exists
	if err := os.MkdirAll(c.ReceiveDir, 0755); err != nil {
		return fmt.Errorf("create receive dir: %w", err)
	}

	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}

	return os.WriteFile(path, data, 0600)
}

// EnsureDirs makes sure all required directories exist
func (c *Config) EnsureDirs() error {
	dirs := []string{c.DataDir, c.ReceiveDir}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0755); err != nil {
			return fmt.Errorf("create dir %s: %w", d, err)
		}
	}
	return nil
}
