package protocol

import (
	"encoding/json"
	"fmt"
	"time"
)

// Message types
const (
	TypeAuth      = "AUTH"
	TypeAuthResp  = "AUTH_RESP"
	TypeText      = "TEXT"
	TypeFileStart = "FILE_START"
	TypeFileChunk = "FILE_CHUNK"
	TypeFileEnd   = "FILE_END"
	TypeClipboard = "CLIPBOARD"
	TypePing      = "PING"
	TypePong      = "PONG"
	TypePairReq   = "PAIR_REQ"
	TypePairResp  = "PAIR_RESP"
	TypeAck       = "ACK"
	TypeError     = "ERROR"
)

// Message is the base message envelope sent over WebSocket
type Message struct {
	Type      string          `json:"type"`
	ID        string          `json:"id,omitempty"`
	Timestamp int64           `json:"timestamp"`
	Data      json.RawMessage `json:"data,omitempty"`
}

// NewMessage creates a new message with the given type and data payload
func NewMessage(msgType string, data interface{}) (*Message, error) {
	var rawData json.RawMessage
	if data != nil {
		d, err := json.Marshal(data)
		if err != nil {
			return nil, fmt.Errorf("marshal data: %w", err)
		}
		rawData = d
	}
	return &Message{
		Type:      msgType,
		ID:        generateID(),
		Timestamp: time.Now().UnixMilli(),
		Data:      rawData,
	}, nil
}

// ParseData unmarshals the message data into the provided target
func (m *Message) ParseData(target interface{}) error {
	if m.Data == nil {
		return fmt.Errorf("message has no data")
	}
	return json.Unmarshal(m.Data, target)
}

// Encode serializes the message to JSON bytes
func (m *Message) Encode() ([]byte, error) {
	return json.Marshal(m)
}

// DecodeMessage parses a JSON byte slice into a Message
func DecodeMessage(data []byte) (*Message, error) {
	var msg Message
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, fmt.Errorf("decode message: %w", err)
	}
	return &msg, nil
}

// --- Payload types ---

// AuthPayload is sent by the phone to authenticate after connecting
type AuthPayload struct {
	DeviceID   string `json:"device_id"`
	AuthToken  string `json:"auth_token"`
	DeviceName string `json:"device_name"`
}

// AuthRespPayload is the server's response to authentication
type AuthRespPayload struct {
	Success    bool   `json:"success"`
	Message    string `json:"message,omitempty"`
	DeviceName string `json:"device_name,omitempty"`
}

// TextPayload carries a plain text message
type TextPayload struct {
	Content string `json:"content"`
}

// FileStartPayload signals the beginning of a file transfer
type FileStartPayload struct {
	Filename   string `json:"filename"`
	FileSize   int64  `json:"file_size"`
	MimeType   string `json:"mime_type,omitempty"`
	ChunkSize  int    `json:"chunk_size"`
	TransferID string `json:"transfer_id"`
}

// FileChunkPayload carries a chunk of file data (base64 encoded)
type FileChunkPayload struct {
	TransferID string `json:"transfer_id"`
	Index      int    `json:"index"`
	Data       string `json:"data"` // base64 encoded
	Size       int    `json:"size"`
}

// FileEndPayload signals the end of a file transfer
type FileEndPayload struct {
	TransferID  string `json:"transfer_id"`
	Checksum    string `json:"checksum"` // SHA-256
	TotalChunks int    `json:"total_chunks"`
}

// ClipboardPayload carries clipboard text
type ClipboardPayload struct {
	Content string `json:"content"`
	Source  string `json:"source"` // "pc" or "phone"
}

// PairReqPayload is sent by the phone to request pairing
type PairReqPayload struct {
	PairingCode string `json:"pairing_code"`
	DeviceName  string `json:"device_name"`
	DeviceID    string `json:"device_id"`
}

// PairRespPayload is the server's response to a pairing request
type PairRespPayload struct {
	Success    bool   `json:"success"`
	Message    string `json:"message,omitempty"`
	AuthToken  string `json:"auth_token,omitempty"`
	DeviceName string `json:"device_name,omitempty"`
	ServerID   string `json:"server_id,omitempty"`
}

// ErrorPayload carries error information
type ErrorPayload struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// AckPayload acknowledges receipt of a message
type AckPayload struct {
	MessageID string `json:"message_id"`
	Status    string `json:"status"` // "ok" or "error"
}

// --- Helper ---

var idCounter int64

func generateID() string {
	idCounter++
	return fmt.Sprintf("%d-%d", time.Now().UnixNano(), idCounter)
}
