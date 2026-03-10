package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"mcsync/internal/clipboard"
	"mcsync/internal/config"
	"mcsync/internal/discovery"
	"mcsync/internal/protocol"
	"mcsync/internal/store"
)

// Server manages WebSocket connections and device communication
type Server struct {
	cfg         *config.Config
	store       *store.Store
	mdns        *discovery.Service
	clipMonitor *clipboard.Monitor

	mu            sync.RWMutex
	clients       map[string]*Client // deviceID -> client
	pairingCode   string
	pairingActive bool

	upgrader   websocket.Upgrader
	httpServer *http.Server
	ctx        context.Context
	cancel     context.CancelFunc

	// Active file transfers
	transfers   map[string]*FileTransfer
	transfersMu sync.Mutex
}

// Client represents a connected phone
type Client struct {
	DeviceID   string
	DeviceName string
	Conn       *websocket.Conn
	Authed     bool
	mu         sync.Mutex
}

// FileTransfer tracks an ongoing file transfer
type FileTransfer struct {
	TransferID  string
	Filename    string
	FileSize    int64
	ChunkSize   int
	Received    int
	TotalChunks int
	File        *os.File
	Hash        []byte
	StartTime   time.Time
}

// New creates a new mcSync server
func New(cfg *config.Config, deviceStore *store.Store) *Server {
	ctx, cancel := context.WithCancel(context.Background())

	s := &Server{
		cfg:       cfg,
		store:     deviceStore,
		clients:   make(map[string]*Client),
		transfers: make(map[string]*FileTransfer),
		ctx:       ctx,
		cancel:    cancel,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  config.MaxMessageSize,
			WriteBufferSize: config.MaxMessageSize,
			CheckOrigin:     func(r *http.Request) bool { return true },
		},
	}

	// Setup clipboard monitoring
	s.clipMonitor = clipboard.NewMonitor(func(content string) {
		if cfg.ClipboardSync {
			s.broadcastClipboard(content)
		}
	})

	return s
}

// Start launches the server
func (s *Server) Start() error {
	log.Printf("[Server] Starting mcSync server on port %d...", s.cfg.Port)

	// Ensure directories
	if err := s.cfg.EnsureDirs(); err != nil {
		return fmt.Errorf("ensure dirs: %w", err)
	}

	// Start mDNS discovery
	s.mdns = discovery.NewService(s.cfg.Port, s.cfg.DeviceName)
	if err := s.mdns.Start(); err != nil {
		log.Printf("[Server] Warning: mDNS failed to start: %v", err)
		// Non-fatal, continue without mDNS
	}

	// Automatic clipboard monitor has been explicitly disabled. Must sync manually via triggers.
	// We no longer automatically call s.clipMonitor.Start() here.

	// HTTP routes
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWebSocket)
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/info", s.handleInfo)
	mux.HandleFunc("/pair-http", s.handlePairHTTP) // NEW: HTTP pairing endpoint

	s.httpServer = &http.Server{
		Addr:    fmt.Sprintf(":%d", s.cfg.Port),
		Handler: mux,
	}

	// Start serving
	go func() {
		localIP := discovery.GetLocalIP()

		// Attempt to create a listener first to catch "address already in use" errors synchronously
		// Use 0.0.0.0 to force IPv4 for better compatibility with phone hotspots
		addr := fmt.Sprintf("0.0.0.0:%d", s.cfg.Port)
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			log.Fatalf("\n  ✗ FATAL: Failed to start server: %v\n  Something else is already using port %d. Use 'lsof -i :%d' to find it.\n", err, s.cfg.Port, s.cfg.Port)
		}

		log.Printf("[Server] Listening on 0.0.0.0:%d (Accessible at %s:%d)", s.cfg.Port, localIP, s.cfg.Port)
		log.Printf("[Server] WebSocket endpoint: ws://%s:%d/ws", localIP, s.cfg.Port)

		if err := s.httpServer.Serve(ln); err != http.ErrServerClosed {
			log.Fatalf("[Server] HTTP server error: %v", err)
		}
	}()

	// Start keepalive pinger
	go s.pingLoop()

	return nil
}

// Stop gracefully shuts down the server
func (s *Server) Stop() {
	log.Println("[Server] Shutting down...")
	s.cancel()

	if s.mdns != nil {
		s.mdns.Stop()
	}
	s.clipMonitor.Stop()

	// Close all client connections
	s.mu.Lock()
	for _, c := range s.clients {
		c.Conn.Close()
	}
	s.mu.Unlock()

	if s.httpServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		s.httpServer.Shutdown(ctx)
	}

	log.Println("[Server] Shutdown complete")
}

// StartPairing begins the pairing process
func (s *Server) StartPairing() (string, error) {
	code, err := store.GeneratePairingCode()
	if err != nil {
		return "", fmt.Errorf("generate pairing code: %w", err)
	}
	s.mu.Lock()
	s.pairingCode = code
	s.pairingActive = true
	s.mu.Unlock()

	// Auto-expire pairing after 5 minutes
	go func() {
		time.Sleep(5 * time.Minute)
		s.mu.Lock()
		if s.pairingCode == code {
			s.pairingActive = false
			s.pairingCode = ""
			log.Println("[Server] Pairing code expired")
		}
		s.mu.Unlock()
	}()

	return code, nil
}

// handleWebSocket handles new WebSocket connections
func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[Server] WebSocket upgrade error: %v", err)
		return
	}

	remoteAddr := r.RemoteAddr
	log.Printf("[Server] New connection from %s", remoteAddr)

	// Create an unauthenticated client
	client := &Client{
		Conn:   conn,
		Authed: false,
	}

	// Handle the connection
	go s.handleClient(client, remoteAddr)
}

// handleClient manages the lifecycle of a single client connection
func (s *Server) handleClient(client *Client, remoteAddr string) {
	defer func() {
		client.Conn.Close()
		if client.DeviceID != "" {
			s.mu.Lock()
			delete(s.clients, client.DeviceID)
			s.mu.Unlock()
			log.Printf("[Server] Device %s (%s) disconnected", client.DeviceName, client.DeviceID[:8])
		}
	}()

	// Set read limits
	client.Conn.SetReadLimit(int64(config.MaxMessageSize))

	for {
		_, rawMsg, err := client.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("[Server] Read error from %s: %v", remoteAddr, err)
			}
			return
		}

		msg, err := protocol.DecodeMessage(rawMsg)
		if err != nil {
			log.Printf("[Server] Decode error: %v", err)
			continue
		}

		// Route message
		switch msg.Type {
		case protocol.TypeAuth:
			s.handleAuth(client, msg, remoteAddr)
		case protocol.TypePairReq:
			s.handlePairRequest(client, msg, remoteAddr)
		case protocol.TypeText:
			s.handleText(client, msg)
		case protocol.TypeClipboard:
			s.handleClipboard(client, msg)
		case protocol.TypeFileStart:
			s.handleFileStart(client, msg)
		case protocol.TypeFileChunk:
			s.handleFileChunk(client, msg)
		case protocol.TypeFileEnd:
			s.handleFileEnd(client, msg)
		case protocol.TypePing:
			resp, _ := protocol.NewMessage(protocol.TypePong, nil)
			s.sendMessage(client, resp)
		case protocol.TypePong:
			// keepalive response, no action needed
		default:
			log.Printf("[Server] Unknown message type: %s", msg.Type)
		}
	}
}

// handleAuth processes authentication from a paired device
func (s *Server) handleAuth(client *Client, msg *protocol.Message, remoteAddr string) {
	var payload protocol.AuthPayload
	if err := msg.ParseData(&payload); err != nil {
		s.sendError(client, "Invalid auth payload")
		return
	}

	if !s.store.ValidateAuth(payload.DeviceID, payload.AuthToken) {
		resp, _ := protocol.NewMessage(protocol.TypeAuthResp, protocol.AuthRespPayload{
			Success: false,
			Message: "Authentication failed",
		})
		s.sendMessage(client, resp)
		return
	}

	// Authentication successful
	client.DeviceID = payload.DeviceID
	client.DeviceName = payload.DeviceName
	client.Authed = true

	s.mu.Lock()
	s.clients[payload.DeviceID] = client
	s.mu.Unlock()

	// Update last seen
	s.store.UpdateLastSeen(payload.DeviceID, remoteAddr, s.cfg.Port)

	resp, _ := protocol.NewMessage(protocol.TypeAuthResp, protocol.AuthRespPayload{
		Success:    true,
		Message:    "Authenticated",
		DeviceName: s.cfg.DeviceName,
	})
	s.sendMessage(client, resp)

	log.Printf("[Server] Device authenticated: %s (%s)", payload.DeviceName, payload.DeviceID[:8])
}

// handlePairRequest processes a new device pairing request
func (s *Server) handlePairRequest(client *Client, msg *protocol.Message, remoteAddr string) {
	var payload protocol.PairReqPayload
	if err := msg.ParseData(&payload); err != nil {
		s.sendError(client, "Invalid pairing payload")
		return
	}

	s.mu.RLock()
	active := s.pairingActive
	code := s.pairingCode
	s.mu.RUnlock()

	if !active || payload.PairingCode != code {
		resp, _ := protocol.NewMessage(protocol.TypePairResp, protocol.PairRespPayload{
			Success: false,
			Message: "Invalid or expired pairing code",
		})
		s.sendMessage(client, resp)
		return
	}

	// Generate auth token
	authToken, err := store.GenerateAuthToken()
	if err != nil {
		s.sendError(client, "Internal error generating auth token")
		return
	}

	// Store the paired device
	device := &store.PairedDevice{
		DeviceID:   payload.DeviceID,
		DeviceName: payload.DeviceName,
		AuthToken:  authToken,
		PairedAt:   time.Now(),
		LastSeen:   time.Now(),
		LastIP:     remoteAddr,
	}

	if err := s.store.AddDevice(device); err != nil {
		s.sendError(client, "Failed to store device")
		return
	}

	// Disable pairing mode
	s.mu.Lock()
	s.pairingActive = false
	s.pairingCode = ""
	s.mu.Unlock()

	// Mark client as authenticated
	client.DeviceID = payload.DeviceID
	client.DeviceName = payload.DeviceName
	client.Authed = true

	s.mu.Lock()
	s.clients[payload.DeviceID] = client
	s.mu.Unlock()

	resp, _ := protocol.NewMessage(protocol.TypePairResp, protocol.PairRespPayload{
		Success:    true,
		Message:    "Paired successfully",
		AuthToken:  authToken,
		DeviceName: s.cfg.DeviceName,
		ServerID:   s.cfg.DeviceID,
	})
	s.sendMessage(client, resp)

	log.Printf("[Server] Device paired: %s (%s)", payload.DeviceName, payload.DeviceID[:8])
}

// handlePairHTTP allows pairing via a standard POST request (bypass hotspot WS blocks)
func (s *Server) handlePairHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var payload protocol.PairReqPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "Invalid payload", http.StatusBadRequest)
		return
	}

	s.mu.RLock()
	active := s.pairingActive
	code := s.pairingCode
	s.mu.RUnlock()

	if !active || payload.PairingCode != code {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(protocol.PairRespPayload{
			Success: false,
			Message: "Invalid or expired pairing code",
		})
		return
	}

	authToken, _ := store.GenerateAuthToken()
	device := &store.PairedDevice{
		DeviceID:   payload.DeviceID,
		DeviceName: payload.DeviceName,
		AuthToken:  authToken,
		PairedAt:   time.Now(),
		LastSeen:   time.Now(),
		LastIP:     r.RemoteAddr,
	}

	s.store.AddDevice(device)

	s.mu.Lock()
	s.pairingActive = false
	s.pairingCode = ""
	s.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(protocol.PairRespPayload{
		Success:    true,
		Message:    "Paired successfully",
		AuthToken:  authToken,
		DeviceName: s.cfg.DeviceName,
		ServerID:   s.cfg.DeviceID,
	})

	log.Printf("[Server] Device paired via HTTP: %s (%s)", payload.DeviceName, payload.DeviceID[:8])
}

// handleText processes incoming text from a phone
func (s *Server) handleText(client *Client, msg *protocol.Message) {
	if !client.Authed {
		s.sendError(client, "Not authenticated")
		return
	}

	var payload protocol.TextPayload
	if err := msg.ParseData(&payload); err != nil {
		s.sendError(client, "Invalid text payload")
		return
	}

	log.Printf("[Text] From %s: %s", client.DeviceName, payload.Content)

	// Send ack
	ack, _ := protocol.NewMessage(protocol.TypeAck, protocol.AckPayload{
		MessageID: msg.ID,
		Status:    "ok",
	})
	s.sendMessage(client, ack)
}

// handleClipboard processes clipboard sync from phone
func (s *Server) handleClipboard(client *Client, msg *protocol.Message) {
	if !client.Authed {
		s.sendError(client, "Not authenticated")
		return
	}

	var payload protocol.ClipboardPayload
	if err := msg.ParseData(&payload); err != nil {
		s.sendError(client, "Invalid clipboard payload")
		return
	}

	// Set clipboard locally
	s.clipMonitor.SetContent(payload.Content)
	if err := clipboard.Write(payload.Content); err != nil {
		log.Printf("[Clipboard] Failed to write: %v", err)
		return
	}

	log.Printf("[Clipboard] Synced from %s: %s", client.DeviceName, truncate(payload.Content, 50))
}

// handleFileStart begins receiving a file from a phone
func (s *Server) handleFileStart(client *Client, msg *protocol.Message) {
	if !client.Authed {
		s.sendError(client, "Not authenticated")
		return
	}

	var payload protocol.FileStartPayload
	if err := msg.ParseData(&payload); err != nil {
		s.sendError(client, "Invalid file start payload")
		return
	}

	// Create receive file
	destPath := filepath.Join(s.cfg.ReceiveDir, payload.Filename)

	// Ensure unique filename
	destPath = ensureUniquePath(destPath)

	f, err := os.Create(destPath)
	if err != nil {
		s.sendError(client, fmt.Sprintf("Failed to create file: %v", err))
		return
	}

	s.transfersMu.Lock()
	s.transfers[payload.TransferID] = &FileTransfer{
		TransferID: payload.TransferID,
		Filename:   filepath.Base(destPath),
		FileSize:   payload.FileSize,
		ChunkSize:  payload.ChunkSize,
		File:       f,
		StartTime:  time.Now(),
	}
	s.transfersMu.Unlock()

	log.Printf("[File] Starting receive: %s (%d bytes)", payload.Filename, payload.FileSize)

	ack, _ := protocol.NewMessage(protocol.TypeAck, protocol.AckPayload{
		MessageID: msg.ID,
		Status:    "ok",
	})
	s.sendMessage(client, ack)
}

// handleFileChunk processes a chunk of incoming file data
func (s *Server) handleFileChunk(client *Client, msg *protocol.Message) {
	if !client.Authed {
		return
	}

	var payload protocol.FileChunkPayload
	if err := msg.ParseData(&payload); err != nil {
		return
	}

	s.transfersMu.Lock()
	transfer, ok := s.transfers[payload.TransferID]
	s.transfersMu.Unlock()

	if !ok {
		return
	}

	data, err := base64.StdEncoding.DecodeString(payload.Data)
	if err != nil {
		log.Printf("[File] Chunk decode error: %v", err)
		return
	}

	if _, err := transfer.File.Write(data); err != nil {
		log.Printf("[File] Write error: %v", err)
		return
	}

	transfer.Received++
}

// handleFileEnd completes a file transfer
func (s *Server) handleFileEnd(client *Client, msg *protocol.Message) {
	if !client.Authed {
		return
	}

	var payload protocol.FileEndPayload
	if err := msg.ParseData(&payload); err != nil {
		return
	}

	s.transfersMu.Lock()
	transfer, ok := s.transfers[payload.TransferID]
	if ok {
		delete(s.transfers, payload.TransferID)
	}
	s.transfersMu.Unlock()

	if !ok {
		return
	}

	transfer.File.Close()

	elapsed := time.Since(transfer.StartTime)
	log.Printf("[File] Received: %s (%d chunks in %v)", transfer.Filename, transfer.Received, elapsed.Round(time.Millisecond))

	// Verify checksum if provided
	if payload.Checksum != "" {
		destPath := filepath.Join(s.cfg.ReceiveDir, transfer.Filename)
		if ok := verifyChecksum(destPath, payload.Checksum); !ok {
			log.Printf("[File] WARNING: Checksum mismatch for %s", transfer.Filename)
		}
	}

	ack, _ := protocol.NewMessage(protocol.TypeAck, protocol.AckPayload{
		MessageID: msg.ID,
		Status:    "ok",
	})
	s.sendMessage(client, ack)
}

// SendText sends a text message to a connected device
func (s *Server) SendText(deviceID, text string) error {
	client, err := s.getClient(deviceID)
	if err != nil {
		return err
	}

	msg, _ := protocol.NewMessage(protocol.TypeText, protocol.TextPayload{
		Content: text,
	})
	return s.sendMessage(client, msg)
}

// SendClipboard sends clipboard content to a connected device
func (s *Server) SendClipboard(deviceID, content string) error {
	client, err := s.getClient(deviceID)
	if err != nil {
		return err
	}

	msg, _ := protocol.NewMessage(protocol.TypeClipboard, protocol.ClipboardPayload{
		Content: content,
		Source:  "pc",
	})
	return s.sendMessage(client, msg)
}

// SendFile sends a file to a connected device
func (s *Server) SendFile(deviceID, filePath string) error {
	client, err := s.getClient(deviceID)
	if err != nil {
		return err
	}

	// Open file
	f, err := os.Open(filePath)
	if err != nil {
		return fmt.Errorf("open file: %w", err)
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		return fmt.Errorf("stat file: %w", err)
	}

	transferID, _ := store.GenerateDeviceID()

	// Send FILE_START
	startMsg, _ := protocol.NewMessage(protocol.TypeFileStart, protocol.FileStartPayload{
		Filename:   stat.Name(),
		FileSize:   stat.Size(),
		ChunkSize:  config.ChunkSize,
		TransferID: transferID,
	})
	if err := s.sendMessage(client, startMsg); err != nil {
		return fmt.Errorf("send file start: %w", err)
	}

	// Stream chunks
	buf := make([]byte, config.ChunkSize)
	chunkIndex := 0
	hasher := sha256.New()

	for {
		n, err := f.Read(buf)
		if n > 0 {
			data := buf[:n]
			hasher.Write(data)

			chunkMsg, _ := protocol.NewMessage(protocol.TypeFileChunk, protocol.FileChunkPayload{
				TransferID: transferID,
				Index:      chunkIndex,
				Data:       base64.StdEncoding.EncodeToString(data),
				Size:       n,
			})
			if err := s.sendMessage(client, chunkMsg); err != nil {
				return fmt.Errorf("send chunk %d: %w", chunkIndex, err)
			}
			chunkIndex++

			// Small delay to prevent overwhelming the connection
			time.Sleep(5 * time.Millisecond)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("read file: %w", err)
		}
	}

	// Send FILE_END
	checksum := fmt.Sprintf("%x", hasher.Sum(nil))
	endMsg, _ := protocol.NewMessage(protocol.TypeFileEnd, protocol.FileEndPayload{
		TransferID:  transferID,
		Checksum:    checksum,
		TotalChunks: chunkIndex,
	})
	if err := s.sendMessage(client, endMsg); err != nil {
		return fmt.Errorf("send file end: %w", err)
	}

	log.Printf("[File] Sent: %s (%d chunks, %d bytes)", stat.Name(), chunkIndex, stat.Size())
	return nil
}

// broadcastClipboard sends clipboard content to all connected devices
func (s *Server) broadcastClipboard(content string) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	msg, _ := protocol.NewMessage(protocol.TypeClipboard, protocol.ClipboardPayload{
		Content: content,
		Source:  "pc",
	})

	for _, client := range s.clients {
		if client.Authed {
			s.sendMessage(client, msg)
		}
	}
}

// GetConnectedDevices returns the list of connected device IDs
func (s *Server) GetConnectedDevices() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := make([]string, 0, len(s.clients))
	for id, c := range s.clients {
		if c.Authed {
			ids = append(ids, id)
		}
	}
	return ids
}

// pingLoop sends periodic pings to all connected clients
func (s *Server) pingLoop() {
	ticker := time.NewTicker(time.Duration(config.PingInterval) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			s.mu.RLock()
			for _, client := range s.clients {
				if client.Authed {
					msg, _ := protocol.NewMessage(protocol.TypePing, nil)
					s.sendMessage(client, msg)
				}
			}
			s.mu.RUnlock()
		}
	}
}

// sendMessage sends a message to a client (thread-safe)
func (s *Server) sendMessage(client *Client, msg *protocol.Message) error {
	data, err := msg.Encode()
	if err != nil {
		return err
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.Conn.WriteMessage(websocket.TextMessage, data)
}

// sendError sends an error message to a client
func (s *Server) sendError(client *Client, errMsg string) {
	msg, _ := protocol.NewMessage(protocol.TypeError, protocol.ErrorPayload{
		Code:    400,
		Message: errMsg,
	})
	s.sendMessage(client, msg)
}

// getClient returns a connected, authenticated client
func (s *Server) getClient(deviceID string) (*Client, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// If deviceID is empty, return the first connected device
	if deviceID == "" {
		for _, c := range s.clients {
			if c.Authed {
				return c, nil
			}
		}
		return nil, fmt.Errorf("no connected devices")
	}

	client, ok := s.clients[deviceID]
	if !ok {
		return nil, fmt.Errorf("device not connected: %s", deviceID)
	}
	if !client.Authed {
		return nil, fmt.Errorf("device not authenticated: %s", deviceID)
	}
	return client, nil
}

// handleHealth returns server health status
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"ok"}`))
}

// handleInfo returns server information
func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	connectedCount := len(s.clients)
	s.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"name":"%s","id":"%s","port":%d,"connected":%d}`,
		s.cfg.DeviceName, s.cfg.DeviceID, s.cfg.Port, connectedCount)
}

// --- Utilities ---

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

func ensureUniquePath(path string) string {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return path
	}

	dir := filepath.Dir(path)
	ext := filepath.Ext(path)
	name := path[:len(path)-len(ext)]
	name = filepath.Base(name)

	for i := 1; ; i++ {
		newPath := filepath.Join(dir, fmt.Sprintf("%s_%d%s", name, i, ext))
		if _, err := os.Stat(newPath); os.IsNotExist(err) {
			return newPath
		}
	}
}

func verifyChecksum(filePath, expected string) bool {
	f, err := os.Open(filePath)
	if err != nil {
		return false
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return false
	}

	actual := fmt.Sprintf("%x", h.Sum(nil))
	return actual == expected
}
