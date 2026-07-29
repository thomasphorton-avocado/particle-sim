export interface BenchmarkResult {
  scenario: "representative" | "heavy";
  kind: "publicationCadence";
  hz: 60 | 30 | 20;
  publicationHz: 60 | 30 | 20;
  observedTicks: number;
  measuredTicks: number;
  timingWindowTicks: number;
  repetitions: number;
  runtimeMs: number;
  totalRuntimeMs: number;
  publicationCount: number;
  deliveredResultCount: number;
  expectedResultCount: number;
  resultOrderMatches: boolean;
  placementAttempts: number;
  acceptedPlacements: number;
  fallingUpdates: number;
  waterCellUpdates: number;
  weatherUpdates: number;
  perTickMs: { mean: number; p50: number; p95: number; p99: number; max: number };
  rawTickMaxMs: number;
  frameBudgetUtilization: number;
  payloadBytes: { mean: number; p50: number; p95: number; p99: number; max: number };
  payloadBudgetBytes: number;
  actorHighWater: number;
  recentReceiptCount: number;
  digest: string;
  clientDigest: string;
  authorityDigest: string;
  finalDigestMatchesAuthority: boolean;
}

export function runBenchmark(options?: { warmupTicks?: number; totalTicks?: number; repetitions?: number; gc?: () => void }): BenchmarkResult[];
export function assertBenchmarkResults(results: BenchmarkResult[]): void;
