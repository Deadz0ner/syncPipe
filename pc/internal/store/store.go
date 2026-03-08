package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// PairedDevice represents a phone that has been paired with this PC
type PairedDevice struct {
	DeviceID   string    `json:"device_id"`
	DeviceName string    `json:"device_name"`
	AuthToken  string    `json:"auth_token"`
	PairedAt   time.Time `json:"paired_at"`
	LastSeen   time.Time `json:"last_seen"`
	LastIP     string    `json:"last_ip,omitempty"`
	LastPort   int       `json:"last_port,omitempty"`
}

// Store manages encrypted persistent storage of paired devices
type Store struct {
	mu      sync.RWMutex
	path    string
	key     []byte
	devices map[string]*PairedDevice
}

// storeData is the serializable form of the store
type storeData struct {
	Devices map[string]*PairedDevice `json:"devices"`
}

// NewStore creates or opens an encrypted store at the given directory
func NewStore(dataDir string) (*Store, error) {
	storePath := filepath.Join(dataDir, "devices.enc")
	keyPath := filepath.Join(dataDir, "store.key")

	// Ensure directory exists
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	// Load or generate encryption key
	key, err := loadOrGenerateKey(keyPath)
	if err != nil {
		return nil, fmt.Errorf("key setup: %w", err)
	}

	s := &Store{
		path:    storePath,
		key:     key,
		devices: make(map[string]*PairedDevice),
	}

	// Try loading existing data
	if _, err := os.Stat(storePath); err == nil {
		if err := s.load(); err != nil {
			return nil, fmt.Errorf("load store: %w", err)
		}
	}

	return s, nil
}

// loadOrGenerateKey loads an existing key or generates a new 256-bit key
func loadOrGenerateKey(keyPath string) ([]byte, error) {
	data, err := os.ReadFile(keyPath)
	if err == nil {
		key, err := hex.DecodeString(string(data))
		if err != nil {
			return nil, fmt.Errorf("decode key: %w", err)
		}
		return key, nil
	}

	if !os.IsNotExist(err) {
		return nil, fmt.Errorf("read key file: %w", err)
	}

	// Generate new key
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("generate key: %w", err)
	}

	// Save key
	if err := os.WriteFile(keyPath, []byte(hex.EncodeToString(key)), 0600); err != nil {
		return nil, fmt.Errorf("write key: %w", err)
	}

	return key, nil
}

// encrypt encrypts plaintext using AES-256-GCM
func (s *Store) encrypt(plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}

	return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

// decrypt decrypts ciphertext using AES-256-GCM
func (s *Store) decrypt(ciphertext []byte) ([]byte, error) {
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonceSize := gcm.NonceSize()
	if len(ciphertext) < nonceSize {
		return nil, fmt.Errorf("ciphertext too short")
	}

	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
	return gcm.Open(nil, nonce, ciphertext, nil)
}

// load reads and decrypts the store from disk
func (s *Store) load() error {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return fmt.Errorf("read store file: %w", err)
	}

	plaintext, err := s.decrypt(data)
	if err != nil {
		return fmt.Errorf("decrypt store: %w", err)
	}

	var sd storeData
	if err := json.Unmarshal(plaintext, &sd); err != nil {
		return fmt.Errorf("unmarshal store: %w", err)
	}

	if sd.Devices != nil {
		s.devices = sd.Devices
	}

	return nil
}

// save encrypts and writes the store to disk
func (s *Store) save() error {
	sd := storeData{Devices: s.devices}

	plaintext, err := json.MarshalIndent(sd, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal store: %w", err)
	}

	ciphertext, err := s.encrypt(plaintext)
	if err != nil {
		return fmt.Errorf("encrypt store: %w", err)
	}

	return os.WriteFile(s.path, ciphertext, 0600)
}

// AddDevice adds or updates a paired device
func (s *Store) AddDevice(device *PairedDevice) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.devices[device.DeviceID] = device
	return s.save()
}

// GetDevice returns a paired device by ID
func (s *Store) GetDevice(deviceID string) (*PairedDevice, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.devices[deviceID]
	return d, ok
}

// GetDeviceByToken returns a device by its auth token
func (s *Store) GetDeviceByToken(token string) (*PairedDevice, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, d := range s.devices {
		if d.AuthToken == token {
			return d, true
		}
	}
	return nil, false
}

// ListDevices returns all paired devices
func (s *Store) ListDevices() []*PairedDevice {
	s.mu.RLock()
	defer s.mu.RUnlock()
	list := make([]*PairedDevice, 0, len(s.devices))
	for _, d := range s.devices {
		list = append(list, d)
	}
	return list
}

// RemoveDevice removes a paired device
func (s *Store) RemoveDevice(deviceID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.devices, deviceID)
	return s.save()
}

// UpdateLastSeen updates the last seen time and IP of a device
func (s *Store) UpdateLastSeen(deviceID, ip string, port int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.devices[deviceID]
	if !ok {
		return fmt.Errorf("device not found: %s", deviceID)
	}
	d.LastSeen = time.Now()
	d.LastIP = ip
	d.LastPort = port
	return s.save()
}

// ValidateAuth validates a device's authentication
func (s *Store) ValidateAuth(deviceID, authToken string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.devices[deviceID]
	if !ok {
		return false
	}
	// Compare using SHA-256 to prevent timing attacks
	expected := sha256.Sum256([]byte(d.AuthToken))
	provided := sha256.Sum256([]byte(authToken))
	return expected == provided
}

// GenerateAuthToken generates a random auth token
func GenerateAuthToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// GeneratePairingCode generates a 6-digit pairing code
func GeneratePairingCode() (string, error) {
	b := make([]byte, 3)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	code := int(b[0])<<16 | int(b[1])<<8 | int(b[2])
	return fmt.Sprintf("%06d", code%1000000), nil
}

// GenerateDeviceID generates a unique device identifier
func GenerateDeviceID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
