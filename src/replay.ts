import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import type { Asset, Anomaly, CausalEdge, Telemetry } from './types.js';

// Independent replay-session API.
//
// A replay session captures a *frozen* deep copy of telemetry / asset / anomaly
// / causal-graph state at creation time. Execution never reads or mutates live
// state, so later ingested points, anomaly resolution and graph edits cannot
// leak into a finished production-window review. Re-running a session is
// deterministic: the same snapshot + parameters always produce the same result
// and resultHash.

export type ReplayStatus = 'pending' | 'success' | 'invalid';
export type InvalidCode =
  | 'BAD_TIMESTAMP'
  | 'WINDOW_REVERSED'
  | 'ASSET_NOT_FOUND'
  | 'INVALID_ROOT_NODE'
  | 'EMPTY_WINDOW';

export type Issue = { code: InvalidCode; message: string };

export type ReplaySnapshot = {
  capturedAt: string;
  assets: Asset[];
  telemetry: Telemetry[];
  anomalies: Anomaly[];
  causalEdges: CausalEdge[];
};

export type ConstraintPoint = {
  index: number;
  time: string;
  assetId: string;
  quality: Telemetry['quality'];
  values: Record<string, number>;
  checks: Record<string, { min: number; max: number; actual: number; pass: boolean; deviation: number }>;
  passCount: number;
  checkCount: number;
  allPass: boolean;
  inferredState: Asset['state'];
  violations: { variable: string; actual: number; min: number; max: number; severity: Anomaly['severity'] }[];
};

export type CausalHypothesis = {
  cause: string;
  evidenceCount: number;
  openEvidenceCount: number;
  edgeWeight: number | null;
  reachableFromRoot: boolean;
  confidence: number;
  supportingAnomalyIds: string[];
};

export type CausalEvidence = {
  rootId: string;
  rootReachable: boolean;
  anomaliesInWindow: number;
  openAnomaliesInWindow: number;
  hypotheses: CausalHypothesis[];
};

export type ReplayResult = {
  executedAt: string;
  assetId: string;
  rootId: string;
  window: { from: string; to: string };
  inputSnapshots: Telemetry[];
  deviceStates: {
    baseline: Asset;
    timeline: { time: string; state: Asset['state']; values: Record<string, number>; violations: ConstraintPoint['violations'] }[];
    finalState: Asset['state'];
  };
  constraints: {
    points: ConstraintPoint[];
    totalChecks: number;
    passedChecks: number;
    violatedChecks: number;
    passRate: number;
    allPass: boolean;
  };
  causalEvidence: CausalEvidence;
  resultHash: string;
};

export type ReplaySession = {
  id: string;
  name?: string;
  assetId: string;
  rootId: string;
  from: string;
  to: string;
  createdAt: string;
  createdBy?: string;
  status: ReplayStatus;
  preflight: { checkedAt: string; issues: Issue[] };
  result: ReplayResult | null;
  invalidReason: Issue | null;
  runCount: number;
  lastRunAt: string | null;
  snapshot: ReplaySnapshot;
};

export type ReplayStores = {
  assets: Asset[];
  telemetry: Telemetry[];
  anomalies: Anomaly[];
  causalEdges: CausalEdge[];
};

type MaybeLog = (action: string, entity: string, payload: unknown) => void;

const clone = <T>(value: T): T =>
  // Snapshot data is plain JSON-safe process state (no functions/classes).
  JSON.parse(JSON.stringify(value)) as T;

function parseTs(value: unknown): number {
  if (typeof value !== 'string' || value.trim() === '') return Number.NaN;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

function severityFor(deviation: number, span: number): Anomaly['severity'] {
  const score = Math.min(1, 0.45 + deviation / (span || 1));
  return score > 0.8 ? 'high' : score > 0.6 ? 'medium' : 'low';
}

function validateWindow(session: ReplaySession, snapshot: ReplaySnapshot): Issue[] {
  const issues: Issue[] = [];
  const fromMs = parseTs(session.from);
  const toMs = parseTs(session.to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    issues.push({
      code: 'BAD_TIMESTAMP',
      message: `时间戳无法解析：from=${JSON.stringify(session.from)}, to=${JSON.stringify(session.to)}，需要 ISO 8601 字符串`,
    });
    return issues;
  }
  if (fromMs > toMs) {
    issues.push({ code: 'WINDOW_REVERSED', message: `时间窗倒置：from(${session.from}) 晚于 to(${session.to})` });
  }
  const asset = snapshot.assets.find(a => a.id === session.assetId);
  if (!asset) issues.push({ code: 'ASSET_NOT_FOUND', message: `快照中不存在资产 ${session.assetId}` });

  // Root node must be either a known asset or a node present in the frozen causal graph.
  const graphNodes = new Set(snapshot.causalEdges.flatMap(e => [e.from, e.to]));
  if (snapshot.assets.every(a => a.id !== session.rootId) && !graphNodes.has(session.rootId)) {
    issues.push({
      code: 'INVALID_ROOT_NODE',
      message: `根节点 ${session.rootId} 既不是资产也不在因果图中（快照节点 ${graphNodes.size} 个）`,
    });
  }

  if (asset && !issues.some(i => i.code === 'WINDOW_REVERSED')) {
    const hit = snapshot.telemetry.some(t => {
      const ms = parseTs(t.time);
      return !Number.isNaN(ms) && ms >= fromMs && ms <= toMs && t.assetId === session.assetId;
    });
    if (!hit) {
      issues.push({
        code: 'EMPTY_WINDOW',
        message: `时间窗内没有资产 ${session.assetId} 的遥测点（${session.from} ~ ${session.to}）`,
      });
    }
  }
  return issues;
}

function hashResult(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function buildResult(session: ReplaySession, snapshot: ReplaySnapshot): ReplayResult {
  const fromMs = Date.parse(session.from);
  const toMs = Date.parse(session.to);
  const asset = snapshot.assets.find(a => a.id === session.assetId)!;

  const points = snapshot.telemetry
    .map((t, originalIndex) => ({ t, originalIndex, ms: Date.parse(t.time) }))
    .filter(x => !Number.isNaN(x.ms) && x.ms >= fromMs && x.ms <= toMs && x.t.assetId === session.assetId)
    .sort((a, b) => a.ms - b.ms || a.originalIndex - b.originalIndex);

  const inputSnapshots = points.map(x => clone(x.t));

  // Constraint evaluation per point, against frozen asset limits.
  const constraintPoints: ConstraintPoint[] = points.map((x, index) => {
    const checks: ConstraintPoint['checks'] = {};
    const violations: ConstraintPoint['violations'] = [];
    for (const [variable, limit] of Object.entries(asset.limits)) {
      const actual = x.t.values[variable];
      if (actual == null) continue;
      const deviation = actual < limit.min ? limit.min - actual : actual > limit.max ? actual - limit.max : 0;
      const pass = deviation === 0;
      checks[variable] = { min: limit.min, max: limit.max, actual, pass, deviation: Number(deviation.toFixed(4)) };
      if (!pass) {
        violations.push({ variable, actual, min: limit.min, max: limit.max, severity: severityFor(deviation, limit.max - limit.min) });
      }
    }
    const passCount = Object.values(checks).filter(c => c.pass).length;
    const checkCount = Object.keys(checks).length;
    return {
      index,
      time: x.t.time,
      assetId: x.t.assetId,
      quality: x.t.quality,
      values: clone(x.t.values),
      checks,
      passCount,
      checkCount,
      allPass: violations.length === 0,
      inferredState: violations.some(v => v.severity === 'high') ? 'degraded' : 'running',
      violations,
    };
  });

  // Device state reconstructed from the point stream; baseline comes from the frozen asset.
  const timeline = constraintPoints.map(p => ({ time: p.time, state: p.inferredState, values: clone(p.values), violations: clone(p.violations) }));
  const finalState = timeline.length ? timeline[timeline.length - 1].state : asset.state;

  const totalChecks = constraintPoints.reduce((n, p) => n + p.checkCount, 0);
  const passedChecks = constraintPoints.reduce((n, p) => n + p.passCount, 0);

  // Causal evidence: link window anomalies to hypothesised causes and the frozen graph.
  const graphNodes = new Set(snapshot.causalEdges.flatMap(e => [e.from, e.to]));
  const windowAnomalies = snapshot.anomalies
    .filter(a => {
      const ms = Date.parse(a.time);
      return !Number.isNaN(ms) && ms >= fromMs && ms <= toMs && a.assetId === session.assetId;
    })
    .sort((a, b) => (Date.parse(a.time) - Date.parse(b.time) || a.id.localeCompare(b.id)));

  const reachable = new Set<string>([session.rootId]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const edge of snapshot.causalEdges) {
      if (reachable.has(edge.from) && !reachable.has(edge.to)) {
        reachable.add(edge.to);
        changed = true;
      }
    }
  }
  const rootReachable = graphNodes.has(session.rootId) || snapshot.assets.some(a => a.id === session.rootId);

  const byCause = new Map<string, { count: number; openCount: number; ids: string[] }>();
  for (const a of windowAnomalies) {
    for (const cause of a.causes) {
      const entry = byCause.get(cause) || { count: 0, openCount: 0, ids: [] };
      entry.count += 1;
      if (a.status !== 'resolved') entry.openCount += 1;
      entry.ids.push(a.id);
      byCause.set(cause, entry);
    }
  }
  const hypotheses: CausalHypothesis[] = [...byCause.entries()]
    .map(([cause, entry]) => {
      const edgeWeightVals = snapshot.causalEdges
        .filter(e => e.from === cause && e.relation === 'causes' && typeof e.weight === 'number')
        .map(e => e.weight as number);
      const edgeWeight = edgeWeightVals.length ? Math.max(...edgeWeightVals) : null;
      return {
        cause,
        evidenceCount: entry.count,
        openEvidenceCount: entry.openCount,
        edgeWeight,
        reachableFromRoot: reachable.has(cause),
        confidence: Number(((edgeWeight ?? 0.3) * Math.min(1, entry.count / 2)).toFixed(4)),
        supportingAnomalyIds: [...entry.ids].sort(),
      };
    })
    .sort((a, b) => b.confidence - a.confidence || b.evidenceCount - a.evidenceCount || a.cause.localeCompare(b.cause));

  const resultWithoutHash = {
    assetId: session.assetId,
    rootId: session.rootId,
    window: { from: session.from, to: session.to },
    inputSnapshots,
    deviceStates: { baseline: clone(asset), timeline, finalState },
    constraints: {
      points: constraintPoints,
      totalChecks,
      passedChecks,
      violatedChecks: totalChecks - passedChecks,
      passRate: totalChecks ? Number((passedChecks / totalChecks).toFixed(4)) : 1,
      allPass: totalChecks === passedChecks,
    },
    causalEvidence: {
      rootId: session.rootId,
      rootReachable,
      anomaliesInWindow: windowAnomalies.length,
      openAnomaliesInWindow: windowAnomalies.filter(a => a.status !== 'resolved').length,
      hypotheses,
    },
  };
  const resultHash = hashResult(resultWithoutHash);
  return { executedAt: '', ...resultWithoutHash, resultHash };
}

// executedAt is supplied by the caller but kept out of the hashed payload so that
// repeated runs against the same snapshot hash identically.
export function executeSession(session: ReplaySession): ReplayResult {
  const issues = validateWindow(session, session.snapshot);
  if (issues.length) {
    session.status = 'invalid';
    session.invalidReason = issues[0];
    session.result = null;
    session.runCount += 1;
    session.lastRunAt = new Date().toISOString();
    throw new SessionInvalidError(issues);
  }
  const result = buildResult(session, session.snapshot);
  // executedAt is fixed at the first (and only) computation; re-runs reuse the
  // cached result. It is excluded from resultHash to keep the hash stable.
  const executedAt = new Date().toISOString();
  result.executedAt = executedAt;
  session.status = 'success';
  session.invalidReason = null;
  session.result = result;
  session.runCount += 1;
  session.lastRunAt = executedAt;
  return result;
}

export class SessionInvalidError extends Error {
  issues: Issue[];
  constructor(issues: Issue[]) {
    super(issues[0].message);
    this.name = 'SessionInvalidError';
    this.issues = issues;
  }
}

function serializeSession(s: ReplaySession, includeSnapshot: boolean) {
  return {
    id: s.id,
    name: s.name,
    assetId: s.assetId,
    rootId: s.rootId,
    from: s.from,
    to: s.to,
    createdAt: s.createdAt,
    createdBy: s.createdBy,
    status: s.status,
    preflight: s.preflight,
    invalidReason: s.invalidReason,
    runCount: s.runCount,
    lastRunAt: s.lastRunAt,
    result: s.result,
    ...(includeSnapshot ? { snapshot: { capturedAt: s.snapshot.capturedAt, assetCount: s.snapshot.assets.length, telemetryCount: s.snapshot.telemetry.length, anomalyCount: s.snapshot.anomalies.length, edgeCount: s.snapshot.causalEdges.length } } : {}),
  };
}

export function registerReplayRoutes(app: FastifyInstance, stores: ReplayStores, log?: MaybeLog) {
  const sessions: ReplaySession[] = [];

  // POST /api/replay/sessions — create a session with an immutable snapshot.
  app.post('/api/replay/sessions', async (req: any, res) => {
    const b = req.body ?? {};
    if (!b.assetId || !b.rootId || !b.from || !b.to) {
      return res.code(400).send({ error: 'assetId、rootId、from、to 必填' });
    }
    const nowIso = new Date().toISOString();
    const session: ReplaySession = {
      id: randomUUID(),
      name: typeof b.name === 'string' ? b.name : undefined,
      assetId: String(b.assetId),
      rootId: String(b.rootId),
      from: String(b.from),
      to: String(b.to),
      createdAt: nowIso,
      createdBy: typeof b.createdBy === 'string' ? b.createdBy : undefined,
      status: 'pending',
      preflight: { checkedAt: nowIso, issues: [] },
      result: null,
      invalidReason: null,
      runCount: 0,
      lastRunAt: null,
      snapshot: {
        capturedAt: nowIso,
        assets: clone(stores.assets),
        telemetry: clone(stores.telemetry),
        anomalies: clone(stores.anomalies),
        causalEdges: clone(stores.causalEdges),
      },
    };
    session.preflight.issues = validateWindow(session, session.snapshot);
    sessions.push(session);
    log?.('replay-session.create', session.id, { assetId: session.assetId, rootId: session.rootId, preflightIssues: session.preflight.issues.map(i => i.code) });
    return res.code(201).send(serializeSession(session, true));
  });

  // GET /api/replay/sessions — list sessions, newest first, optional filters.
  app.get('/api/replay/sessions', async (req: any) => {
    const q = req.query ?? {};
    let list = [...sessions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id.localeCompare(b.id)));
    if (q.assetId) list = list.filter(s => s.assetId === q.assetId);
    if (q.rootId) list = list.filter(s => s.rootId === q.rootId);
    if (q.status) list = list.filter(s => s.status === q.status);
    return { items: list.map(s => serializeSession(s, false)), total: list.length };
  });

  // GET /api/replay/sessions/:id — session detail (without full snapshot payload).
  app.get('/api/replay/sessions/:id', async (req: any, res) => {
    const s = sessions.find(x => x.id === (req.params as any).id);
    if (!s) return res.code(404).send({ error: 'replay session not found' });
    return serializeSession(s, true);
  });

  // POST /api/replay/sessions/:id/run — execute against the frozen snapshot.
  app.post('/api/replay/sessions/:id/run', async (req: any, res) => {
    const s = sessions.find(x => x.id === (req.params as any).id);
    if (!s) return res.code(404).send({ error: 'replay session not found' });

    if (s.status === 'invalid') {
      s.runCount += 1;
      s.lastRunAt = new Date().toISOString();
      return res.code(422).send({
        status: 'invalid',
        code: s.invalidReason?.code,
        message: s.invalidReason?.message,
        invalidReason: s.invalidReason,
        preflight: s.preflight,
        runCount: s.runCount,
      });
    }

    if (s.status === 'success' && s.result) {
      s.runCount += 1;
      s.lastRunAt = s.result.executedAt;
      log?.('replay-session.rerun', s.id, { runCount: s.runCount, resultHash: s.result.resultHash });
      return { status: 'success', reused: true, runCount: s.runCount, lastRunAt: s.lastRunAt, session: serializeSession(s, false) };
    }

    try {
      const result = executeSession(s);
      log?.('replay-session.run', s.id, { runCount: s.runCount, resultHash: result.resultHash, points: result.inputSnapshots.length });
      return { status: 'success', reused: false, runCount: s.runCount, lastRunAt: s.lastRunAt, session: serializeSession(s, false) };
    } catch (err) {
      if (err instanceof SessionInvalidError) {
        log?.('replay-session.invalid', s.id, { issues: err.issues.map(i => i.code) });
        return res.code(422).send({
          status: 'invalid',
          code: err.issues[0].code,
          message: err.issues[0].message,
          invalidReason: s.invalidReason,
          allIssues: err.issues,
          preflight: s.preflight,
          runCount: s.runCount,
        });
      }
      throw err;
    }
  });

  // GET /api/replay/sessions/:id/result — query the computed replay result.
  app.get('/api/replay/sessions/:id/result', async (req: any, res) => {
    const s = sessions.find(x => x.id === (req.params as any).id);
    if (!s) return res.code(404).send({ error: 'replay session not found' });
    if (s.status === 'pending') {
      return res.code(409).send({ status: 'pending', message: '会话尚未执行，请先 POST .../run' });
    }
    if (s.status === 'invalid') {
      return res.code(422).send({ status: 'invalid', invalidReason: s.invalidReason, preflight: s.preflight });
    }
    return { status: 'success', runCount: s.runCount, lastRunAt: s.lastRunAt, result: s.result };
  });
}
