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

## 生产时段复盘（Replay Sessions）

独立于实时状态的会话式回放，用于复盘已结束的生产时段。会话创建时对 telemetry、设备、anomaly 和因果图做**深拷贝快照**，执行只基于该快照，不会读写或修改任何实时数据；之后新入库的点、异常处置或图谱变更都不会渗入历史复盘。

- `POST /api/replay/sessions`：按 `assetId`、`rootId`、`from`、`to`（ISO 8601）创建会话，立即返回 `preflight` 预检问题，初始状态 `pending`。
- `POST /api/replay/sessions/:id/run`：执行回放。成功结果只计算一次，重复执行返回缓存（`reused:true`），`resultHash` 与 `executedAt` 稳定。
- `GET /api/replay/sessions`：列表，支持 `status`/`assetId`/`rootId` 过滤。
- `GET /api/replay/sessions/:id`：会话详情（含快照规模摘要）。
- `GET /api/replay/sessions/:id/result`：查询结果——按时间排序的输入快照、设备状态轨迹与冻结基线、逐点约束校验，以及关联快照异常与冻结因果边的根因证据；未执行返回 409，无效终止返回 422。

会话状态：`pending`（未执行）、`success`（成功）、`invalid`（无效终止，携带可解释的 `invalidReason`）。无效终止错误码：`BAD_TIMESTAMP`（坏时间戳）、`WINDOW_REVERSED`（窗口倒置）、`EMPTY_WINDOW`（窗口内无该资产测点）、`ASSET_NOT_FOUND`、`INVALID_ROOT_NODE`（根节点既不是资产也不在因果图中）。

