export interface BenchmarkResult {
  scenario: string;
  hz: number;
  substepsPerFrame: number;
  ticks: number;
  frames: number;
  perTickMs: { mean: number; p50: number; p95: number; p99: number; max: number };
  perFrameMs: { mean: number; p50: number; p95: number; p99: number; max: number };
  tickThroughputPerSec: number;
  frameBudgetUtilization: number;
  memory: {
    rssDeltaBytes: number;
    heapDeltaBytes: number;
    arrayBuffersDeltaBytes: number;
    rssBytes: number;
    heapUsedBytes: number;
    arrayBuffersBytes: number;
    serializedStateBytes: number;
  };
  digest: string;
}

export function runBenchmark(options?: { warmupTicks?: number; totalTicks?: number }): BenchmarkResult[];
