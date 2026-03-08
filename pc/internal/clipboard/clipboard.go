package clipboard

import (
	"context"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Monitor watches for clipboard changes and notifies via callback
type Monitor struct {
	mu          sync.Mutex
	lastContent string
	onChange    func(content string)
	interval    time.Duration
	cancel      context.CancelFunc
}

// NewMonitor creates a clipboard monitor
func NewMonitor(onChange func(content string)) *Monitor {
	detectTool()
	return &Monitor{
		onChange: onChange,
		interval: 1500 * time.Millisecond,
	}
}

// Start begins polling the clipboard for changes
func (m *Monitor) Start(ctx context.Context) {
	ctx, m.cancel = context.WithCancel(ctx)

	// Initial read
	if content, err := Read(); err == nil {
		m.mu.Lock()
		m.lastContent = content
		m.mu.Unlock()
	}

	go func() {
		ticker := time.NewTicker(m.interval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				content, err := Read()
				if err != nil {
					continue
				}
				m.mu.Lock()
				if content != m.lastContent && content != "" {
					m.lastContent = content
					m.mu.Unlock()
					m.onChange(content)
				} else {
					m.mu.Unlock()
				}
			}
		}
	}()

	log.Println("[Clipboard] Monitor started (polling interval:", m.interval, ")")
}

// Stop stops the clipboard monitor
func (m *Monitor) Stop() {
	if m.cancel != nil {
		m.cancel()
		log.Println("[Clipboard] Monitor stopped")
	}
}

// SetContent sets the last known content without triggering onChange
// Used when receiving clipboard from phone to avoid echo
func (m *Monitor) SetContent(content string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lastContent = content
}

var (
	readCmd        string
	readArgs       []string
	writeCmd       string
	writeArgs      []string
	toolDetectOnce sync.Once
)

func detectTool() {
	toolDetectOnce.Do(func() {
		// Prefer wl-paste if available (Wayland)
		if _, err := exec.LookPath("wl-paste"); err == nil {
			readCmd = "wl-paste"
			readArgs = []string{"--no-newline"}
			writeCmd = "wl-copy"
			writeArgs = []string{}
			return
		}

		// Try xclip
		if _, err := exec.LookPath("xclip"); err == nil {
			readCmd = "xclip"
			readArgs = []string{"-selection", "clipboard", "-o"}
			writeCmd = "xclip"
			writeArgs = []string{"-selection", "clipboard"}
			return
		}

		// Try xsel fallback
		if _, err := exec.LookPath("xsel"); err == nil {
			readCmd = "xsel"
			readArgs = []string{"--clipboard", "--output"}
			writeCmd = "xsel"
			writeArgs = []string{"--clipboard", "--input"}
			return
		}
	})
}

// Read reads the current clipboard content using the detected tool
func Read() (string, error) {
	detectTool()
	if readCmd == "" {
		return "", fmt.Errorf("no clipboard utility found")
	}

	out, err := exec.Command(readCmd, readArgs...).Output()
	if err != nil {
		return "", err
	}

	return strings.TrimSpace(string(out)), nil
}

// Write writes content to the system clipboard using the detected tool
func Write(content string) error {
	detectTool()
	if writeCmd == "" {
		return fmt.Errorf("no clipboard utility found")
	}

	cmd := exec.Command(writeCmd, writeArgs...)
	cmd.Stdin = strings.NewReader(content)
	return cmd.Run()
}
