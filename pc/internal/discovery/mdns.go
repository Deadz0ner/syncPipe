package discovery

import (
	"fmt"
	"log"
	"net"
	"os"

	"github.com/hashicorp/mdns"
)

// Service manages mDNS advertisement for device discovery
type Service struct {
	server      *mdns.Server
	port        int
	name        string
	serviceType string
}

// NewService creates a new mDNS discovery service
func NewService(port int, deviceName string) *Service {
	return &Service{
		port:        port,
		name:        deviceName,
		serviceType: "_mcsync._tcp",
	}
}

// Start begins advertising the mDNS service
func (s *Service) Start() error {
	hostname, _ := os.Hostname()

	// Get local IP addresses for mDNS
	ips := getLocalIPs()

	info := []string{
		fmt.Sprintf("device=%s", s.name),
		fmt.Sprintf("version=1.0"),
	}

	service, err := mdns.NewMDNSService(
		hostname,
		s.serviceType,
		"",
		"",
		s.port,
		ips,
		info,
	)
	if err != nil {
		return fmt.Errorf("create mDNS service: %w", err)
	}

	server, err := mdns.NewServer(&mdns.Config{Zone: service})
	if err != nil {
		return fmt.Errorf("start mDNS server: %w", err)
	}

	s.server = server
	log.Printf("[mDNS] Advertising %s on port %d", s.serviceType, s.port)
	return nil
}

// Stop shuts down the mDNS advertisement
func (s *Service) Stop() {
	if s.server != nil {
		s.server.Shutdown()
		log.Println("[mDNS] Service stopped")
	}
}

// Discover scans the network for mcSync servers (used for testing)
func Discover() ([]*mdns.ServiceEntry, error) {
	var entries []*mdns.ServiceEntry
	entriesCh := make(chan *mdns.ServiceEntry, 16)

	go func() {
		for entry := range entriesCh {
			entries = append(entries, entry)
		}
	}()

	if err := mdns.Lookup("_mcsync._tcp", entriesCh); err != nil {
		return nil, fmt.Errorf("mDNS lookup: %w", err)
	}

	return entries, nil
}

// getLocalIPs returns all non‐loopback IPv4 addresses
func getLocalIPs() []net.IP {
	var ips []net.IP
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ips
	}
	for _, addr := range addrs {
		if ipNet, ok := addr.(*net.IPNet); ok && !ipNet.IP.IsLoopback() {
			if ipNet.IP.To4() != nil {
				ips = append(ips, ipNet.IP)
			}
		}
	}
	return ips
}

// GetLocalIP returns the preferred local IP address
func GetLocalIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		// Fallback to scanning interfaces
		ips := getLocalIPs()
		if len(ips) > 0 {
			return ips[0].String()
		}
		return "127.0.0.1"
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).IP.String()
}
