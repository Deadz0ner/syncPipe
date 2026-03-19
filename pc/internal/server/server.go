package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"hash"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
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

	ackCallbacks map[string]chan int
	ackMu        sync.Mutex
}

// Client represents a connected phone
type Client struct {
	DeviceID   string
	DeviceName string
	Conn       *websocket.Conn
	Authed     bool
	mu         sync.Mutex

	// Current binary transfer for this connection
	ActiveTransfer *FileTransfer
}

// FileTransfer tracks an ongoing file transfer
type FileTransfer struct {
	TransferID  string
	Filename    string
	FileSize    int64
	ChunkSize   int
	Received    int
	TotalChunks int
	TotalBytes  int64
	File        *os.File
	Hasher      hash.Hash
	StartTime   time.Time
}

// New creates a new mcSync server
func New(cfg *config.Config, deviceStore *store.Store) *Server {
	ctx, cancel := context.WithCancel(context.Background())

	s := &Server{
		cfg:          cfg,
		store:        deviceStore,
		clients:      make(map[string]*Client),
		transfers:    make(map[string]*FileTransfer),
		ackCallbacks: make(map[string]chan int),
		ctx:          ctx,
		cancel:       cancel,
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

	// HTTP routes
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWebSocket)
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/info", s.handleInfo)
	mux.HandleFunc("/pair-http", s.handlePairHTTP)

	s.httpServer = &http.Server{
		Addr:    fmt.Sprintf(":%d", s.cfg.Port),
		Handler: mux,
	}

	// Start serving
	go func() {
		localIP := discovery.GetLocalIP()
		addr := fmt.Sprintf("0.0.0.0:%d", s.cfg.Port)
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			log.Fatalf("\n  ✗ FATAL: Failed to start server: %v\n", err)
		}

		log.Printf("[Server] Listening on 0.0.0.0:%d (Accessible at %s:%d)", s.cfg.Port, localIP, s.cfg.Port)

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

// UpdateDeviceName changes the server device name and restarts mDNS
func (s *Server) UpdateDeviceName(newName string) {
	s.cfg.DeviceName = newName
	if s.mdns != nil {
		s.mdns.Stop()
		s.mdns = discovery.NewService(s.cfg.Port, newName)
		if err := s.mdns.Start(); err != nil {
			log.Printf("[Server] Warning: mDNS restart failed: %v", err)
		}
	}
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

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[Server] WebSocket upgrade error: %v", err)
		return
	}

	remoteAddr := r.RemoteAddr
	log.Printf("[Server] New connection from %s", remoteAddr)

	client := &Client{
		Conn:   conn,
		Authed: false,
	}

	go s.handleClient(client, remoteAddr)
}

func (s *Server) handleClient(client *Client, remoteAddr string) {
	defer func() {
		client.Conn.Close()
		if client.DeviceID != "" {
			s.mu.Lock()
			if s.clients[client.DeviceID] == client {
				delete(s.clients, client.DeviceID)
				log.Printf("[Server] Device %s (%s) disconnected", client.DeviceName, client.DeviceID[:8])
			}
			s.mu.Unlock()
		}
	}()

	client.Conn.SetReadLimit(int64(config.MaxMessageSize))

	for {
		messageType, rawMsg, err := client.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("[Server] Read error from %s: %v", remoteAddr, err)
			}
			return
		}

		if messageType == websocket.BinaryMessage {
			s.handleBinaryChunk(client, rawMsg)
			continue
		}

		msg, err := protocol.DecodeMessage(rawMsg)
		if err != nil {
			log.Printf("[Server] Decode error: %v", err)
			continue
		}

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
		case protocol.TypeFileMeta:
			s.handleFileMeta(client, msg)
		case protocol.TypeFileChunk:
			s.handleFileChunk(client, msg)
		case protocol.TypeFileEnd:
			s.handleFileEnd(client, msg)
		case protocol.TypePing:
			resp, _ := protocol.NewMessage(protocol.TypePong, nil)
			s.sendMessage(client, resp)
		case protocol.TypePong:
		case protocol.TypeAck:
			s.handleAck(client, msg)
		default:
			log.Printf("[Server] Unknown message type: %s", msg.Type)
		}
	}
}

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

	client.DeviceID = payload.DeviceID
	client.DeviceName = payload.DeviceName
	client.Authed = true

	s.mu.Lock()
	if existing, ok := s.clients[payload.DeviceID]; ok && existing != client {
		existing.Conn.Close()
	}
	s.clients[payload.DeviceID] = client
	s.mu.Unlock()

	s.store.UpdateLastSeen(payload.DeviceID, remoteAddr, s.cfg.Port)

	resp, _ := protocol.NewMessage(protocol.TypeAuthResp, protocol.AuthRespPayload{
		Success:    true,
		Message:    "Authenticated",
		DeviceName: s.cfg.DeviceName,
	})
	s.sendMessage(client, resp)

	log.Printf("[Server] Device authenticated: %s (%s)", payload.DeviceName, payload.DeviceID[:8])
}

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

	authToken, err := store.GenerateAuthToken()
	if err != nil {
		s.sendError(client, "Internal error generating auth token")
		return
	}

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

	s.mu.Lock()
	s.pairingActive = false
	s.pairingCode = ""
	s.mu.Unlock()

	client.DeviceID = payload.DeviceID
	client.DeviceName = payload.DeviceName
	client.Authed = true

	s.mu.Lock()
	if existing, ok := s.clients[payload.DeviceID]; ok && existing != client {
		existing.Conn.Close()
	}
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

	lines := strings.Split(payload.Content, "\n")
	output := fmt.Sprintf("\n  ╭─── 💬 Text from %s ───\n", client.DeviceName)
	for _, line := range lines {
		output += fmt.Sprintf("  │ %s\n", line)
	}
	output += "  ╰────────────────────────────────────────"
	log.Print(output)

	ack, _ := protocol.NewMessage(protocol.TypeAck, protocol.AckPayload{
		MessageID: msg.ID,
		Status:    "ok",
	})
	s.sendMessage(client, ack)
}

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

	s.clipMonitor.SetContent(payload.Content)
	if err := clipboard.Write(payload.Content); err != nil {
		log.Printf("[Clipboard] Failed to write: %v", err)
		return
	}

	lines := strings.Split(payload.Content, "\n")
	output := "\n  ╭─── 📋 Clipboard Synced ───\n"
	for _, line := range lines {
		output += fmt.Sprintf("  │ %s\n", line)
	}
	output += "  ╰────────────────────────────────────────"
	log.Print(output)
}

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

	destPath := filepath.Join(s.cfg.ReceiveDir, payload.Filename)
	destPath = ensureUniquePath(destPath)

	f, err := os.Create(destPath)
	if err != nil {
		s.sendError(client, fmt.Sprintf("Failed to create file: %v", err))
		return
	}

	s.transfersMu.Lock()
	transfer := &FileTransfer{
		TransferID: payload.TransferID,
		Filename:   filepath.Base(destPath),
		FileSize:   payload.FileSize,
		ChunkSize:  payload.ChunkSize,
		File:       f,
		Hasher:     sha256.New(),
		StartTime:  time.Now(),
	}
	s.transfers[payload.TransferID] = transfer
	client.ActiveTransfer = transfer
	s.transfersMu.Unlock()

	log.Printf("[File] Starting receive: %s (%d bytes)", payload.Filename, payload.FileSize)

	ack, _ := protocol.NewMessage(protocol.TypeAck, protocol.AckPayload{
		MessageID: msg.ID,
		Status:    "ok",
	})
	s.sendMessage(client, ack)
}

func (s *Server) handleFileMeta(client *Client, msg *protocol.Message) {
	if !client.Authed {
		s.sendError(client, "Not authenticated")
		return
	}

	var payload protocol.FileMetaPayload
	if err := msg.ParseData(&payload); err != nil {
		s.sendError(client, "Invalid file meta payload")
		return
	}

	destPath := filepath.Join(s.cfg.ReceiveDir, payload.Name)
	destPath = ensureUniquePath(destPath)

	f, err := os.Create(destPath)
	if err != nil {
		s.sendError(client, fmt.Sprintf("Failed to create file: %v", err))
		return
	}

	s.transfersMu.Lock()
	transfer := &FileTransfer{
		TransferID: payload.TransferID,
		Filename:   filepath.Base(destPath),
		FileSize:   payload.Size,
		File:       f,
		Hasher:     sha256.New(),
		StartTime:  time.Now(),
	}
	if payload.TransferID != "" {
		s.transfers[payload.TransferID] = transfer
	}
	client.ActiveTransfer = transfer
	s.transfersMu.Unlock()

	log.Printf("[File] Starting binary receive: %s (%d bytes)", payload.Name, payload.Size)

	ack, _ := protocol.NewMessage(protocol.TypeAck, protocol.AckPayload{
		MessageID: msg.ID,
		Status:    "ok",
	})
	s.sendMessage(client, ack)
}

func (s *Server) handleBinaryChunk(client *Client, data []byte) {
	if !client.Authed || client.ActiveTransfer == nil {
		return
	}

	transfer := client.ActiveTransfer
	if _, err := transfer.File.Write(data); err != nil {
		log.Printf("[File] Write error: %v", err)
		return
	}

	transfer.Hasher.Write(data)
	transfer.Received++
	transfer.TotalBytes += int64(len(data))

	ackMsg, _ := protocol.NewMessage(protocol.TypeAck, protocol.AckPayload{
		TransferID: transfer.TransferID,
		Chunk:      transfer.Received,
	})
	s.sendMessage(client, ackMsg)
}

func (s *Server) handleAck(client *Client, msg *protocol.Message) {
	if !client.Authed {
		return
	}

	var payload protocol.AckPayload
	if err := msg.ParseData(&payload); err != nil {
		return
	}

	if payload.TransferID != "" {
		s.ackMu.Lock()
		ch, ok := s.ackCallbacks[payload.TransferID]
		s.ackMu.Unlock()
		if ok {
			select {
			case ch <- payload.Chunk:
			default:
			}
		}
	}
}

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

	transfer.Hasher.Write(data)
	transfer.Received++
}

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
	if !ok {
		transfer = client.ActiveTransfer
	}

	if transfer != nil {
		delete(s.transfers, transfer.TransferID)
		client.ActiveTransfer = nil
	}
	s.transfersMu.Unlock()

	if transfer == nil {
		return
	}

	transfer.File.Close()

	elapsed := time.Since(transfer.StartTime)
	log.Printf("[File] Received: %s (%d bytes in %d chunks, %v)", transfer.Filename, transfer.TotalBytes, transfer.Received, elapsed.Round(time.Millisecond))

	if transfer.FileSize > 0 && transfer.TotalBytes != transfer.FileSize {
		log.Printf("[File] WARNING: Size mismatch: %d received vs %d expected", transfer.TotalBytes, transfer.FileSize)
	}

	if payload.Checksum != "" {
		actualChecksum := fmt.Sprintf("%x", transfer.Hasher.Sum(nil))
		if actualChecksum != payload.Checksum {
			log.Printf("[File] WARNING: Checksum mismatch for %s. Expected %s, got %s", transfer.Filename, payload.Checksum, actualChecksum)
		}
	}

	ack, _ := protocol.NewMessage(protocol.TypeAck, protocol.AckPayload{
		MessageID: msg.ID,
		Status:    "ok",
	})
	s.sendMessage(client, ack)
}

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

func (s *Server) SendFile(deviceID, filePath string) error {
	client, err := s.getClient(deviceID)
	if err != nil {
		return err
	}

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

	metaMsg, _ := protocol.NewMessage(protocol.TypeFileMeta, protocol.FileMetaPayload{
		Name:       stat.Name(),
		Size:       stat.Size(),
		TransferID: transferID,
	})
	if err := s.sendMessage(client, metaMsg); err != nil {
		return fmt.Errorf("send file meta: %w", err)
	}

	buf := make([]byte, config.ChunkSize)
	chunkIndex := 0
	hasher := sha256.New()

	ackChan := make(chan int, 50)
	s.ackMu.Lock()
	s.ackCallbacks[transferID] = ackChan
	s.ackMu.Unlock()

	defer func() {
		s.ackMu.Lock()
		delete(s.ackCallbacks, transferID)
		s.ackMu.Unlock()
		close(ackChan)
	}()

	// Wait for Mobile to initialize the file and send an ACK for readiness (chunk 0)
	ready := false
	for !ready {
		select {
		case ackChunk := <-ackChan:
			if ackChunk == 0 {
				ready = true
			}
		case <-time.After(10 * time.Second):
			log.Printf("[File] ⚠️ Readiness ACK timeout for %s", stat.Name())
			return fmt.Errorf("readiness ACK timeout")
		}
	}

	for {
		n, err := f.Read(buf)
		if n > 0 {
			data := buf[:n]
			hasher.Write(data)

			client.mu.Lock()
			err = client.Conn.WriteMessage(websocket.BinaryMessage, data)
			client.mu.Unlock()
			if err != nil {
				return fmt.Errorf("send binary chunk %d: %w", chunkIndex, err)
			}
			chunkIndex++

			// Wait for ACK
			matched := false
			for !matched {
				select {
				case ackChunk := <-ackChan:
					if ackChunk == chunkIndex {
						matched = true
					}
				case <-time.After(8 * time.Second):
					log.Printf("[File] ⚠️ ACK timeout for chunk #%d", chunkIndex)
					return fmt.Errorf("ACK timeout for chunk #%d", chunkIndex)
				}
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("read file: %w", err)
		}
	}

	checksum := fmt.Sprintf("%x", hasher.Sum(nil))
	endMsg, _ := protocol.NewMessage(protocol.TypeFileEnd, protocol.FileEndPayload{
		TransferID:  transferID,
		Checksum:    checksum,
		TotalChunks: chunkIndex,
	})
	if err := s.sendMessage(client, endMsg); err != nil {
		return fmt.Errorf("send file end: %w", err)
	}

	log.Printf("[File] Sent binary: %s (%d chunks, %d bytes)", stat.Name(), chunkIndex, stat.Size())
	return nil
}

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

func (s *Server) sendMessage(client *Client, msg *protocol.Message) error {
	data, err := msg.Encode()
	if err != nil {
		return err
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.Conn.WriteMessage(websocket.TextMessage, data)
}

func (s *Server) sendError(client *Client, errMsg string) {
	msg, _ := protocol.NewMessage(protocol.TypeError, protocol.ErrorPayload{
		Code:    400,
		Message: errMsg,
	})
	s.sendMessage(client, msg)
}

func (s *Server) getClient(deviceID string) (*Client, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

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

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"ok"}`))
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	connectedCount := len(s.clients)
	s.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"device_name":"%s","device_id":"%s","version":"1.0.0","port":%d,"connected":%d}`,
		s.cfg.DeviceName, s.cfg.DeviceID, s.cfg.Port, connectedCount)
}

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
