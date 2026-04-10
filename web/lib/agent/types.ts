/**
 * Event types from the InariWatch eBPF Agent.
 *
 * These mirror the Rust #[repr(C,packed)] structs in crates/events/src/types.rs.
 * The agent sends batches of these events compressed with LZ4 over HTTPS.
 */

// Event type enum — must match agent's EventType
export type AgentEventType =
  | "process_exec"
  | "process_exit"
  | "process_fork"
  | "tcp_connect"
  | "tcp_state_change"
  | "tcp_retransmit"
  | "tcp_data"
  | "file_open"
  | "file_write"
  | "file_delete"
  | "dns_query"
  | "dns_response"
  | "tls_data"
  | "syscall"
  | "security_exec"
  | "security_file"
  | "security_socket"
  | "security_capability"
  | "security_namespace";

// Base event header (all events have this)
export interface AgentEventHeader {
  type: AgentEventType;
  timestamp_ns: number;
  pid: number;
  tid: number;
  comm: string; // process name (up to 16 chars)
  container_id?: string;
  pod_name?: string;
}

// Process events
export interface ProcessExecEvent extends AgentEventHeader {
  type: "process_exec";
  filename: string;
  args: string;
  ppid: number;
  uid: number;
  gid: number;
}

export interface ProcessExitEvent extends AgentEventHeader {
  type: "process_exit";
  exit_code: number;
  duration_ns: number;
}

export interface ProcessForkEvent extends AgentEventHeader {
  type: "process_fork";
  child_pid: number;
}

// Network events
export interface TcpConnectEvent extends AgentEventHeader {
  type: "tcp_connect";
  saddr: string;
  daddr: string;
  sport: number;
  dport: number;
}

export interface TcpStateChangeEvent extends AgentEventHeader {
  type: "tcp_state_change";
  saddr: string;
  daddr: string;
  sport: number;
  dport: number;
  old_state: number;
  new_state: number;
}

export interface TcpRetransmitEvent extends AgentEventHeader {
  type: "tcp_retransmit";
  saddr: string;
  daddr: string;
  sport: number;
  dport: number;
}

export interface TcpDataEvent extends AgentEventHeader {
  type: "tcp_data";
  saddr: string;
  daddr: string;
  sport: number;
  dport: number;
  bytes: number;
  direction: "send" | "recv";
}

// Filesystem events
export interface FileOpenEvent extends AgentEventHeader {
  type: "file_open";
  filename: string;
  flags: number;
}

export interface FileWriteEvent extends AgentEventHeader {
  type: "file_write";
  filename: string;
  bytes: number;
}

export interface FileDeleteEvent extends AgentEventHeader {
  type: "file_delete";
  filename: string;
}

// DNS events
export interface DnsQueryEvent extends AgentEventHeader {
  type: "dns_query";
  query_name: string;
  query_type: number; // A=1, AAAA=28, etc.
}

export interface DnsResponseEvent extends AgentEventHeader {
  type: "dns_response";
  query_name: string;
  response_ip: string;
  rcode: number;
  latency_us: number;
}

// TLS plaintext (intercepted via uprobes on SSL_read/SSL_write)
export interface TlsDataEvent extends AgentEventHeader {
  type: "tls_data";
  direction: "read" | "write";
  data: string; // first N bytes of plaintext (truncated)
  len: number;
  ssl_pid: number;
}

// Raw syscall (dispatcher)
export interface SyscallEvent extends AgentEventHeader {
  type: "syscall";
  syscall_nr: number;
  args: number[];
}

// Security events (LSM hooks)
export interface SecurityExecEvent extends AgentEventHeader {
  type: "security_exec";
  filename: string;
  decision: "allow" | "deny";
}

export interface SecurityFileEvent extends AgentEventHeader {
  type: "security_file";
  filename: string;
  flags: number;
  decision: "allow" | "deny";
}

export interface SecuritySocketEvent extends AgentEventHeader {
  type: "security_socket";
  daddr: string;
  dport: number;
  decision: "allow" | "deny";
}

export interface SecurityCapabilityEvent extends AgentEventHeader {
  type: "security_capability";
  capability: number;
  cap_name: string;
}

export interface SecurityNamespaceEvent extends AgentEventHeader {
  type: "security_namespace";
  ns_type: string; // "mnt", "pid", "net", etc.
  target_pid: number;
}

// Union of all event types
export type AgentEvent =
  | ProcessExecEvent
  | ProcessExitEvent
  | ProcessForkEvent
  | TcpConnectEvent
  | TcpStateChangeEvent
  | TcpRetransmitEvent
  | TcpDataEvent
  | FileOpenEvent
  | FileWriteEvent
  | FileDeleteEvent
  | DnsQueryEvent
  | DnsResponseEvent
  | TlsDataEvent
  | SyscallEvent
  | SecurityExecEvent
  | SecurityFileEvent
  | SecuritySocketEvent
  | SecurityCapabilityEvent
  | SecurityNamespaceEvent;

// Batch payload from the agent
export interface AgentBatch {
  agent_id: string;
  hostname: string;
  kernel_version: string;
  agent_version: string;
  batch_id: string;
  events: AgentEvent[];
  metrics?: {
    events_received: number;
    events_filtered: number;
    events_dropped: number;
    uptime_secs: number;
    cpu_percent: number;
  };
}

// Threat detected from event analysis
export interface DetectedThreat {
  severity: "critical" | "warning" | "info";
  title: string;
  body: string;
  alertType: "security" | "error";
  fingerprint: string;
  correlationData: Record<string, unknown>;
  sourceEvent: AgentEvent;
}
