# 工业过程数字孪生与异常根因推理服务

纯后端 Node.js + TypeScript + Fastify 服务，默认无需 Docker、数据库或消息中间件即可运行。

## 启动

```bash
npm install
npm run dev
```

默认端口：`6301`。健康检查：`GET /health`。

## 业务闭环

- 领域状态模型与事件输入
- 可回放的时间序列/仿真流程
- 约束校验与风险门禁
- 方案版本、审计轨迹与异常处置
- 所有状态暂存于进程内，便于本机演示；可扩展为数据库、事件总线和实时流处理架构

## 增强业务闭环

- 配方版本、工艺窗口风险评估与审批
- What-if 工况推演，输出吞吐量、质量、能耗和风险
- 受控闭环控制命令，受操作窗口和高严重度异常门禁约束
- 维修窗口、备件准备、下游影响与 LOTO 锁定确认
- 综合过程健康评分

扩展接口：`/api/recipes`、`/api/control/commands`、`/api/maintenance/windows`、`/api/process/health-score`。

## 复盘会话（Replay Session）

面向已结束生产时段的独立回放，与实时链路完全隔离：

- `POST /api/replay/sessions`：按 `assetId`、`from`/`to` 时间窗、`rootNodeId` 创建会话，创建即冻结快照（资产、窗口内遥测/异常、因果边深拷贝），之后写入的实时数据不会混入
- `POST /api/replay/sessions/:id/run`：执行回放，产出按时间排序的输入快照、设备状态、约束结果与因果证据；只读计算，不修改实时 telemetry、anomaly、causal graph；终态会话重复执行返回同一结果
- `GET /api/replay/sessions`（支持 `assetId`、`status` 过滤）、`GET /api/replay/sessions/:id`、`GET /api/replay/sessions/:id/result`

会话状态：`pending`（未执行）→ `completed`（成功）或 `invalid`（无效终止，附可解释原因：空窗口 `empty-window`、坏时间戳 `invalid-time-window`、无效根节点 `unknown-root-node`、未知资产 `unknown-asset`）。
