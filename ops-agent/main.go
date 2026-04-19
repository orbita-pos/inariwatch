package main

import (
	"context"
	"crypto/subtle"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const listenAddr = "127.0.0.1:9500"

// Where to look for TLS certificates. We walk each root that exists and parse
// every .crt/.pem we find as PEM — Caddy stores under the first path,
// kamal-proxy under the second.
var certSearchRoots = []string{
	"/var/lib/caddy/.local/share/caddy/certificates",
	"/var/lib/docker/volumes/kamal-proxy-config/_data/certs",
}

// Allow-list of systemd units whose journal /logs will return. Keep tight —
// an operator poking around via the admin dashboard should not be able to
// enumerate arbitrary journals and leak PII.
var allowedLogServices = map[string]bool{
	"inari-staging":    true,
	"inari-worker":     true,
	"caddy-staging":    true,
	"eap-server":       true,
	"inariwatch-agent": true,
	"netdata":          true,
	"docker":           true,
	"kamal-proxy":      true,
	"fail2ban":         true,
	"ops-agent":        true,
}

type hostInfo struct {
	Hostname   string         `json:"hostname"`
	Kernel     string         `json:"kernel"`
	OS         string         `json:"os"`
	Arch       string         `json:"arch"`
	UptimeSecs int64          `json:"uptime_secs"`
	LoadAvg    [3]float64     `json:"load_avg"`
	MemoryMB   map[string]int `json:"memory_mb"`
	DiskRoot   diskStat       `json:"disk_root"`
	CPUCount   int            `json:"cpu_count"`
}

type diskStat struct {
	TotalBytes     uint64 `json:"total_bytes"`
	AvailableBytes uint64 `json:"available_bytes"`
	UsedBytes      uint64 `json:"used_bytes"`
	UsedPercent    int    `json:"used_percent"`
}

func main() {
	secret := strings.TrimSpace(os.Getenv("OPS_AGENT_SECRET"))
	if len(secret) < 32 {
		log.Fatalf("OPS_AGENT_SECRET missing or < 32 chars (got %d)", len(secret))
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/host", auth(secret, handleHost))
	mux.HandleFunc("/docker", auth(secret, handleDocker))
	mux.HandleFunc("/systemd", auth(secret, handleSystemd))
	mux.HandleFunc("/logs/", auth(secret, handleLogs))
	mux.HandleFunc("/certs", auth(secret, handleCerts))
	mux.HandleFunc("/fail2ban", auth(secret, handleFail2ban))
	mux.HandleFunc("/queues", auth(secret, handleQueues))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	srv := &http.Server{
		Addr:              listenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("ops-agent listening on %s", listenAddr)
	log.Fatal(srv.ListenAndServe())
}

func auth(secret string, next http.HandlerFunc) http.HandlerFunc {
	secretBytes := []byte(secret)
	return func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			writeErr(w, http.StatusUnauthorized, "missing Bearer token")
			return
		}
		tok := []byte(strings.TrimSpace(strings.TrimPrefix(h, "Bearer ")))
		if subtle.ConstantTimeCompare(tok, secretBytes) != 1 {
			writeErr(w, http.StatusUnauthorized, "invalid token")
			return
		}
		next(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func handleHost(w http.ResponseWriter, _ *http.Request) {
	hn, _ := os.Hostname()
	writeJSON(w, 200, hostInfo{
		Hostname:   hn,
		Kernel:     runCmd("uname", "-r"),
		OS:         osPretty(),
		Arch:       runtime.GOARCH,
		CPUCount:   runtime.NumCPU(),
		UptimeSecs: readUptime(),
		LoadAvg:    readLoadAvg(),
		MemoryMB:   readMemoryMB(),
		DiskRoot:   readDisk("/"),
	})
}

func runCmd(name string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func osPretty() string {
	b, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), "\"")
		}
	}
	return ""
}

func readUptime() int64 {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	parts := strings.Fields(string(b))
	if len(parts) == 0 {
		return 0
	}
	f, _ := strconv.ParseFloat(parts[0], 64)
	return int64(f)
}

func readLoadAvg() [3]float64 {
	var la [3]float64
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return la
	}
	parts := strings.Fields(string(b))
	for i := 0; i < 3 && i < len(parts); i++ {
		la[i], _ = strconv.ParseFloat(parts[i], 64)
	}
	return la
}

func readMemoryMB() map[string]int {
	m := map[string]int{}
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return m
	}
	want := map[string]bool{
		"MemTotal": true, "MemAvailable": true, "MemFree": true,
		"Cached": true, "Buffers": true,
	}
	for _, line := range strings.Split(string(b), "\n") {
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		key := strings.TrimSuffix(parts[0], ":")
		if !want[key] {
			continue
		}
		kb, _ := strconv.Atoi(parts[1])
		m[key] = kb / 1024
	}
	return m
}

func readDisk(path string) diskStat {
	var fs syscall.Statfs_t
	if err := syscall.Statfs(path, &fs); err != nil {
		return diskStat{}
	}
	total := fs.Blocks * uint64(fs.Bsize)
	avail := fs.Bavail * uint64(fs.Bsize)
	used := total - avail
	pct := 0
	if total > 0 {
		pct = int((used * 100) / total)
	}
	return diskStat{
		TotalBytes:     total,
		AvailableBytes: avail,
		UsedBytes:      used,
		UsedPercent:    pct,
	}
}

func handleDocker(w http.ResponseWriter, _ *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "ps", "-a", "--format", "{{json .}}").Output()
	if err != nil {
		writeErr(w, 500, "docker ps failed: "+err.Error())
		return
	}
	var containers []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		var c map[string]any
		if json.Unmarshal([]byte(line), &c) == nil {
			containers = append(containers, c)
		}
	}
	writeJSON(w, 200, map[string]any{"containers": containers})
}

func handleSystemd(w http.ResponseWriter, _ *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "systemctl", "list-units",
		"--type=service", "--state=running",
		"--no-pager", "--no-legend", "--plain").Output()
	if err != nil {
		writeErr(w, 500, "systemctl failed: "+err.Error())
		return
	}
	var units []map[string]string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		units = append(units, map[string]string{
			"unit":        fields[0],
			"load":        fields[1],
			"active":      fields[2],
			"sub":         fields[3],
			"description": strings.Join(fields[4:], " "),
		})
	}
	writeJSON(w, 200, map[string]any{"units": units})
}

func handleLogs(w http.ResponseWriter, r *http.Request) {
	name := strings.Trim(strings.TrimPrefix(r.URL.Path, "/logs/"), "/")
	if !isValidServiceName(name) {
		writeErr(w, 400, "invalid service name")
		return
	}
	if !allowedLogServices[name] {
		writeErr(w, 403, "service not in allowlist")
		return
	}
	lines := 100
	if l := r.URL.Query().Get("lines"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 500 {
			lines = n
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "journalctl",
		"-u", name+".service", "--no-pager",
		"-n", strconv.Itoa(lines), "-o", "short-iso").Output()
	if err != nil {
		writeErr(w, 500, "journalctl failed: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"service": name,
		"lines":   lines,
		"output":  string(out),
	})
}

type certInfo struct {
	Domain    string `json:"domain"`
	NotBefore string `json:"not_before"`
	NotAfter  string `json:"not_after"`
	DaysLeft  int    `json:"days_left"`
	Issuer    string `json:"issuer"`
	Path      string `json:"path"`
}

func handleCerts(w http.ResponseWriter, _ *http.Request) {
	certs := []certInfo{}
	for _, root := range certSearchRoots {
		if _, err := os.Stat(root); err != nil {
			continue
		}
		_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return nil
			}
			// Real cert files are tiny; skip huge ones to avoid edge cases.
			if info.Size() > 64*1024 {
				return nil
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			// Iterate through every PEM block — kamal-proxy files bundle
			// private key + cert together; Caddy files are cert-only. Stop at
			// the first CERTIFICATE block (the leaf).
			rest := raw
			for {
				var block *pem.Block
				block, rest = pem.Decode(rest)
				if block == nil {
					return nil
				}
				if block.Type != "CERTIFICATE" {
					continue
				}
				cert, err := x509.ParseCertificate(block.Bytes)
				if err != nil {
					return nil
				}
				domain := cert.Subject.CommonName
				if len(cert.DNSNames) > 0 {
					domain = cert.DNSNames[0]
				}
				certs = append(certs, certInfo{
					Domain:    domain,
					NotBefore: cert.NotBefore.UTC().Format(time.RFC3339),
					NotAfter:  cert.NotAfter.UTC().Format(time.RFC3339),
					DaysLeft:  int(time.Until(cert.NotAfter).Hours() / 24),
					Issuer:    cert.Issuer.CommonName,
					Path:      path,
				})
				return nil
			}
		})
	}
	writeJSON(w, 200, map[string]any{"certs": certs})
}

type jailStatus struct {
	Jail      string   `json:"jail"`
	Banned    int      `json:"banned_count"`
	Failed    int      `json:"failed_count"`
	BannedIPs []string `json:"banned_ips,omitempty"`
}

func handleFail2ban(w http.ResponseWriter, _ *http.Request) {
	if _, err := exec.LookPath("fail2ban-client"); err != nil {
		writeJSON(w, 200, map[string]any{"installed": false})
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	statusOut, err := exec.CommandContext(ctx, "fail2ban-client", "status").Output()
	if err != nil {
		writeErr(w, 500, "fail2ban-client status failed: "+err.Error())
		return
	}
	var jails []string
	for _, line := range strings.Split(string(statusOut), "\n") {
		if !strings.Contains(line, "Jail list:") {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		for _, j := range strings.Split(parts[1], ",") {
			if j = strings.TrimSpace(j); j != "" {
				jails = append(jails, j)
			}
		}
	}
	var result []jailStatus
	for _, jail := range jails {
		out, err := exec.CommandContext(ctx, "fail2ban-client", "status", jail).Output()
		if err != nil {
			continue
		}
		st := jailStatus{Jail: jail}
		for _, line := range strings.Split(string(out), "\n") {
			line = strings.TrimSpace(line)
			switch {
			case strings.HasPrefix(line, "Currently banned:"):
				st.Banned = parseIntAfterColon(line)
			case strings.HasPrefix(line, "Total failed:"):
				st.Failed = parseIntAfterColon(line)
			case strings.HasPrefix(line, "Banned IP list:"):
				parts := strings.SplitN(line, ":", 2)
				if len(parts) == 2 {
					st.BannedIPs = strings.Fields(parts[1])
				}
			}
		}
		result = append(result, st)
	}
	writeJSON(w, 200, map[string]any{"installed": true, "jails": result})
}

func parseIntAfterColon(line string) int {
	parts := strings.SplitN(line, ":", 2)
	if len(parts) != 2 {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(parts[1]))
	return n
}

// Queues the BullMQ workers use, in priority order.
var bullQueues = []string{"critical", "default", "low"}

// Name of the Redis container (as seen by `docker ps`). Used as the target
// for `docker exec`. Set to empty to disable the /queues endpoint.
const redisContainerName = "redis"

type queueRow struct {
	Queue   string `json:"queue"`
	Wait    int    `json:"wait"`
	Active  int    `json:"active"`
	Delayed int    `json:"delayed"`
	Failed  int    `json:"failed"`
}

func handleQueues(w http.ResponseWriter, _ *http.Request) {
	if _, err := exec.LookPath("docker"); err != nil {
		writeErr(w, 500, "docker not available")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rows := []queueRow{}
	for _, q := range bullQueues {
		row := queueRow{Queue: q}
		row.Wait = redisCLIInt(ctx, "LLEN", "bull:"+q+":wait")
		row.Active = redisCLIInt(ctx, "LLEN", "bull:"+q+":active")
		row.Delayed = redisCLIInt(ctx, "ZCARD", "bull:"+q+":delayed")
		row.Failed = redisCLIInt(ctx, "ZCARD", "bull:"+q+":failed")
		rows = append(rows, row)
	}
	writeJSON(w, 200, map[string]any{"rows": rows})
}

// redisCLIInt executes a single-command redis-cli inside the Redis container
// and parses the integer reply. Returns 0 on any error — the widget will
// display the row anyway; a single bad key shouldn't zero out the row.
func redisCLIInt(ctx context.Context, cmd, key string) int {
	out, err := exec.CommandContext(ctx, "docker", "exec", redisContainerName, "redis-cli", cmd, key).Output()
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	return n
}

func isValidServiceName(s string) bool {
	if len(s) == 0 || len(s) > 64 {
		return false
	}
	for _, c := range s {
		ok := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || c == '-' || c == '_'
		if !ok {
			return false
		}
	}
	return true
}
