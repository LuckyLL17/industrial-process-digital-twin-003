export type Telemetry = { time: string; assetId: string; values: Record<string, number>; quality: 'good' | 'suspect' | 'bad' };
export type Asset = { id: string; name: string; type: string; parentId?: string; limits: Record<string, { min: number; max: number }>; state: 'running' | 'degraded' | 'stopped'; last: Record<string, number> };
export type Anomaly = { id: string; time: string; assetId: string; variable: string; value: number; score: number; severity: 'low' | 'medium' | 'high'; status: 'open' | 'investigating' | 'resolved'; causes: string[] };
export type CausalEdge = { from: string; to: string; relation: string; weight?: number };
