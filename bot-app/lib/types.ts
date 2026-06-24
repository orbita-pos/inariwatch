export type Alert = {
  id: string;
  projectId: string;
  projectName?: string;
  severity: "critical" | "warning" | "info";
  title: string;
  body: string | null;
  aiReasoning: string | null;
  sourceIntegrations: string[];
  isRead: boolean;
  isResolved: boolean;
  createdAt: string;
};

export type AlertDetail = Alert & {
  postmortem: string | null;
  fingerprint: string | null;
  resolvedAt: string | null;
  substrate?: SubstrateRecording | null;
  communityFix?: CommunityFix | null;
  remediations?: RemediationSession[];
};

export type SubstrateRecording = {
  recordingId: string;
  command: string | null;
  runtime: string;
  eventCount: number;
  durationMs: number;
  categories: Record<string, number> | null;
  context: string | null;
};

export type CommunityFix = {
  fixId: string;
  fixApproach: string;
  fixDescription: string;
  successRate: number;
  totalApplications: number;
};

export type RemediationSession = {
  id: string;
  status: string;
  attempt: number;
  prUrl: string | null;
  confidenceScore: number | null;
  steps: RemediationStep[];
  createdAt: string;
};

export type RemediationStep = {
  id: string;
  type: string;
  message: string;
  status: "running" | "completed" | "failed";
  timestamp: string;
};

export type UptimeMonitor = {
  projectName: string;
  url: string;
  isDown: boolean;
  statusCode: number | null;
  responseTimeMs: number | null;
};
