/**
 * eBPF Agent event processor.
 *
 * Analyzes batches of kernel-level events for security threats,
 * anomalies, and performance issues. Creates alerts via the
 * existing createAlertIfNew() pipeline.
 */

import crypto from "crypto";
import type {
  AgentBatch,
  AgentEvent,
  DetectedThreat,
  TlsDataEvent,
  ProcessExecEvent,
  FileOpenEvent,
  FileWriteEvent,
  SecuritySocketEvent,
  SecurityExecEvent,
  SecurityNamespaceEvent,
  DnsQueryEvent,
  TcpConnectEvent,
} from "./types";

// --- Threat detection rules ---

const SQL_INJECTION_PATTERNS = [
  /'\s*(or|and)\s+'[^']*'\s*=\s*'[^']*'/i,
  /'\s*(or|and)\s+\d+\s*=\s*\d+/i,
  /union\s+(all\s+)?select\s/i,
  /;\s*(drop|delete|update|insert|alter)\s/i,
  /'\s*;\s*--/i,
  /sleep\s*\(\s*\d+\s*\)/i,
  /benchmark\s*\(/i,
  /load_file\s*\(/i,
  /into\s+(out|dump)file/i,
];

const XSS_PATTERNS = [
  /<script[\s>]/i,
  /javascript\s*:/i,
  /on(error|load|click|mouseover)\s*=/i,
  /eval\s*\(/i,
  /document\.(cookie|write|location)/i,
];

const COMMAND_INJECTION_PATTERNS = [
  /;\s*(cat|ls|id|whoami|wget|curl|nc|bash|sh|python|perl|ruby)\s/i,
  /\|\s*(cat|ls|id|whoami|bash|sh)\b/i,
  /`[^`]*(cat|ls|id|whoami|bash|sh)[^`]*`/i,
  /\$\([^)]*\)/,
];

const SSRF_PATTERNS = [
  /169\.254\.169\.254/,   // AWS metadata
  /metadata\.google/i,    // GCP metadata
  /100\.100\.100\.200/,   // Alibaba metadata
  /127\.0\.0\.1/,
  /0\.0\.0\.0/,
  /localhost/i,
  /\[::1\]/,             // IPv6 loopback
];

const SUSPICIOUS_BINARIES = new Set([
  "nc", "ncat", "netcat", "nmap", "masscan",
  "wget", "curl",  // suspicious when spawned by a web app process
  "python", "python3", "perl", "ruby", "php",
  "gcc", "cc", "make",
  "base64", "xxd",
  "chmod", "chown", "chattr",
  "useradd", "adduser", "passwd",
  "crontab", "at",
  "ssh", "scp", "sftp",
  "tcpdump", "wireshark", "tshark",
]);

const SENSITIVE_FILES = [
  "/etc/shadow",
  "/etc/passwd",
  "/etc/sudoers",
  "/root/.ssh/",
  "/root/.bash_history",
  "/proc/self/environ",
  "/var/run/docker.sock",
  "/var/run/secrets/kubernetes.io/",
];

const MALICIOUS_DNS = [
  /\.onion$/i,
  /\.bit$/i,
  /dnslog\./i,
  /interact\.sh/i,
  /burpcollaborator\./i,
  /oastify\.com/i,
  /canarytokens\./i,
];

/**
 * Process a batch of agent events and return detected threats.
 */
export function processAgentBatch(batch: AgentBatch): DetectedThreat[] {
  const threats: DetectedThreat[] = [];

  for (const event of batch.events) {
    const detected = analyzeEvent(event, batch);
    if (detected) threats.push(detected);
  }

  return threats;
}

function analyzeEvent(event: AgentEvent, batch: AgentBatch): DetectedThreat | null {
  switch (event.type) {
    case "tls_data":
      return analyzeTlsData(event, batch);
    case "process_exec":
      return analyzeProcessExec(event, batch);
    case "file_open":
      return analyzeFileOpen(event, batch);
    case "file_write":
      return analyzeFileWrite(event, batch);
    case "security_socket":
      return analyzeSecuritySocket(event, batch);
    case "security_exec":
      return analyzeSecurityExec(event, batch);
    case "security_namespace":
      return analyzeSecurityNamespace(event, batch);
    case "dns_query":
      return analyzeDnsQuery(event, batch);
    case "tcp_connect":
      return analyzeTcpConnect(event, batch);
    default:
      return null;
  }
}

// --- Analyzers ---

function analyzeTlsData(event: TlsDataEvent, batch: AgentBatch): DetectedThreat | null {
  const data = event.data;

  // SQL injection in HTTP request/response plaintext
  for (const pattern of SQL_INJECTION_PATTERNS) {
    if (pattern.test(data)) {
      return buildThreat(
        "critical",
        `SQL Injection detected in TLS traffic — ${event.comm} (PID ${event.pid})`,
        [
          `SQL injection pattern detected in ${event.direction === "write" ? "outgoing request" : "incoming response"}.`,
          `Process: ${event.comm} (PID ${event.pid})`,
          `Matched pattern: ${pattern.source}`,
          `Data excerpt: ${truncate(data, 500)}`,
          `Container: ${event.container_id || "host"}`,
        ].join("\n"),
        "security",
        event,
        batch
      );
    }
  }

  // XSS in response
  if (event.direction === "read") {
    for (const pattern of XSS_PATTERNS) {
      if (pattern.test(data)) {
        return buildThreat(
          "warning",
          `Potential XSS in TLS response — ${event.comm} (PID ${event.pid})`,
          [
            `XSS pattern detected in TLS plaintext response.`,
            `Process: ${event.comm} (PID ${event.pid})`,
            `Matched pattern: ${pattern.source}`,
            `Data excerpt: ${truncate(data, 500)}`,
          ].join("\n"),
          "security",
          event,
          batch
        );
      }
    }
  }

  // Command injection in request
  if (event.direction === "write") {
    for (const pattern of COMMAND_INJECTION_PATTERNS) {
      if (pattern.test(data)) {
        return buildThreat(
          "critical",
          `Command injection in TLS request — ${event.comm} (PID ${event.pid})`,
          [
            `Command injection pattern in outgoing TLS data.`,
            `Process: ${event.comm} (PID ${event.pid})`,
            `Matched pattern: ${pattern.source}`,
            `Data excerpt: ${truncate(data, 500)}`,
          ].join("\n"),
          "security",
          event,
          batch
        );
      }
    }
  }

  // SSRF indicators
  for (const pattern of SSRF_PATTERNS) {
    if (pattern.test(data)) {
      return buildThreat(
        "critical",
        `SSRF attempt detected — ${event.comm} accessing internal endpoint`,
        [
          `TLS traffic contains internal/metadata endpoint pattern.`,
          `Process: ${event.comm} (PID ${event.pid})`,
          `Matched: ${pattern.source}`,
          `Data excerpt: ${truncate(data, 500)}`,
        ].join("\n"),
        "security",
        event,
        batch
      );
    }
  }

  return null;
}

function analyzeProcessExec(event: ProcessExecEvent, batch: AgentBatch): DetectedThreat | null {
  const binary = event.filename.split("/").pop() ?? "";

  if (SUSPICIOUS_BINARIES.has(binary)) {
    return buildThreat(
      "warning",
      `Suspicious process executed: ${binary} — spawned by ${event.comm} (PID ${event.ppid})`,
      [
        `Suspicious binary execution detected.`,
        `Binary: ${event.filename}`,
        `Args: ${truncate(event.args, 500)}`,
        `Parent: ${event.comm} (PID ${event.ppid})`,
        `User: UID ${event.uid}, GID ${event.gid}`,
        `Container: ${event.container_id || "host"}`,
      ].join("\n"),
      "security",
      event,
      batch
    );
  }

  // Reverse shell patterns
  if (event.args && /\b(\/dev\/tcp|mkfifo|bash\s+-i)\b/i.test(event.args)) {
    return buildThreat(
      "critical",
      `Reverse shell attempt — ${event.filename}`,
      [
        `Reverse shell pattern detected in process arguments.`,
        `Binary: ${event.filename}`,
        `Args: ${truncate(event.args, 500)}`,
        `Parent: ${event.comm} (PID ${event.ppid})`,
        `Container: ${event.container_id || "host"}`,
      ].join("\n"),
      "security",
      event,
      batch
    );
  }

  return null;
}

function analyzeFileOpen(event: FileOpenEvent, batch: AgentBatch): DetectedThreat | null {
  for (const sensitive of SENSITIVE_FILES) {
    if (event.filename.startsWith(sensitive)) {
      return buildThreat(
        "critical",
        `Sensitive file access: ${event.filename} — by ${event.comm} (PID ${event.pid})`,
        [
          `Access to sensitive system file detected.`,
          `File: ${event.filename}`,
          `Process: ${event.comm} (PID ${event.pid})`,
          `Flags: ${event.flags}`,
          `Container: ${event.container_id || "host"}`,
        ].join("\n"),
        "security",
        event,
        batch
      );
    }
  }

  return null;
}

function analyzeFileWrite(event: FileWriteEvent, batch: AgentBatch): DetectedThreat | null {
  // Web shell detection: writing executable files to web-accessible directories
  const webPaths = ["/var/www/", "/srv/http/", "/public_html/", "/var/lib/nginx/"];
  const execExtensions = [".php", ".jsp", ".asp", ".aspx", ".cgi", ".py", ".pl", ".sh"];

  for (const webPath of webPaths) {
    if (event.filename.startsWith(webPath)) {
      for (const ext of execExtensions) {
        if (event.filename.endsWith(ext)) {
          return buildThreat(
            "critical",
            `Web shell upload: ${event.filename} — by ${event.comm}`,
            [
              `Executable file written to web-accessible directory.`,
              `File: ${event.filename}`,
              `Size: ${event.bytes} bytes`,
              `Process: ${event.comm} (PID ${event.pid})`,
              `Container: ${event.container_id || "host"}`,
            ].join("\n"),
            "security",
            event,
            batch
          );
        }
      }
    }
  }

  return null;
}

function analyzeSecuritySocket(event: SecuritySocketEvent, batch: AgentBatch): DetectedThreat | null {
  if (event.decision === "deny") {
    return buildThreat(
      "warning",
      `Blocked outbound connection to ${event.daddr}:${event.dport} — ${event.comm}`,
      [
        `LSM hook blocked outbound socket connection.`,
        `Destination: ${event.daddr}:${event.dport}`,
        `Process: ${event.comm} (PID ${event.pid})`,
        `Container: ${event.container_id || "host"}`,
      ].join("\n"),
      "security",
      event,
      batch
    );
  }
  return null;
}

function analyzeSecurityExec(event: SecurityExecEvent, batch: AgentBatch): DetectedThreat | null {
  if (event.decision === "deny") {
    return buildThreat(
      "warning",
      `Blocked execution: ${event.filename} — by ${event.comm}`,
      [
        `LSM hook blocked binary execution.`,
        `Binary: ${event.filename}`,
        `Process: ${event.comm} (PID ${event.pid})`,
        `Container: ${event.container_id || "host"}`,
      ].join("\n"),
      "security",
      event,
      batch
    );
  }
  return null;
}

function analyzeSecurityNamespace(event: SecurityNamespaceEvent, batch: AgentBatch): DetectedThreat | null {
  // Container escape: process trying to change namespace
  return buildThreat(
    "critical",
    `Container escape attempt: ${event.ns_type} namespace change — ${event.comm} (PID ${event.pid})`,
    [
      `Process attempting to change ${event.ns_type} namespace — potential container escape.`,
      `Process: ${event.comm} (PID ${event.pid})`,
      `Target PID: ${event.target_pid}`,
      `Namespace type: ${event.ns_type}`,
      `Container: ${event.container_id || "host"}`,
    ].join("\n"),
    "security",
    event,
    batch
  );
}

function analyzeDnsQuery(event: DnsQueryEvent, batch: AgentBatch): DetectedThreat | null {
  for (const pattern of MALICIOUS_DNS) {
    if (pattern.test(event.query_name)) {
      return buildThreat(
        "critical",
        `Suspicious DNS query: ${event.query_name} — by ${event.comm}`,
        [
          `DNS query to known malicious/exfiltration domain pattern.`,
          `Query: ${event.query_name} (type ${event.query_type})`,
          `Process: ${event.comm} (PID ${event.pid})`,
          `Container: ${event.container_id || "host"}`,
        ].join("\n"),
        "security",
        event,
        batch
      );
    }
  }
  return null;
}

function analyzeTcpConnect(event: TcpConnectEvent, batch: AgentBatch): DetectedThreat | null {
  // Detect connections to cloud metadata endpoints
  if (event.daddr === "169.254.169.254" || event.daddr === "100.100.100.200") {
    return buildThreat(
      "critical",
      `SSRF: Connection to cloud metadata — ${event.comm} → ${event.daddr}`,
      [
        `Direct TCP connection to cloud metadata endpoint.`,
        `Source: ${event.saddr}:${event.sport}`,
        `Destination: ${event.daddr}:${event.dport}`,
        `Process: ${event.comm} (PID ${event.pid})`,
        `Container: ${event.container_id || "host"}`,
      ].join("\n"),
      "security",
      event,
      batch
    );
  }
  return null;
}

// --- Helpers ---

function buildThreat(
  severity: "critical" | "warning" | "info",
  title: string,
  body: string,
  alertType: "security" | "error",
  event: AgentEvent,
  batch: AgentBatch,
): DetectedThreat {
  const fingerprint = crypto
    .createHash("sha256")
    .update(`${title}\n${event.type}\n${event.comm}\n${event.pid}`)
    .digest("hex");

  return {
    severity,
    title,
    body: `${body}\n\nHost: ${batch.hostname}\nKernel: ${batch.kernel_version}\nAgent: ${batch.agent_version}`,
    alertType,
    fingerprint,
    correlationData: {
      agent: {
        agent_id: batch.agent_id,
        hostname: batch.hostname,
        kernel_version: batch.kernel_version,
        agent_version: batch.agent_version,
        batch_id: batch.batch_id,
      },
      event: {
        type: event.type,
        timestamp_ns: event.timestamp_ns,
        pid: event.pid,
        tid: event.tid,
        comm: event.comm,
        container_id: event.container_id,
        pod_name: event.pod_name,
      },
    },
    sourceEvent: event,
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
