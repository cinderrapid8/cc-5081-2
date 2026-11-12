# 角色属性求值服务

规则驱动的属性引擎：基础数值、装备修正、临时增益、场景压制各有独立的来源身份。求值顺序由属性规则声明，派生关系构成显式依赖图；任何撤销都按来源身份执行，不按数值匹配。

## 快速开始

```bash
npm install
npm test          # 类型检查 + 构建 + 74 项测试
npm run scenarios # 打印覆盖题目要求的时间线与输入
npm run build     # 构建面板与规则服务单文件到 dist/
npm start         # 面板 http://localhost:4173
```

## 本地规则服务（干净机器可启动）

属性求值核心被打包为**零运行时三方依赖**的单文件服务 `dist/service/rule-service.mjs`，只使用 Node 内置模块（`node:http`/`node:fs`）。规则文件、版本摘要（manifest）和运行参数通过统一入口加载，规则目录在运行期只读。

```bash
npm run build
# 无需 npm install 的复跑路径（离线）：
bash deploy/run-offline.sh selftest   # 部署自检：13 项场景
bash deploy/run-offline.sh serve      # 常驻服务，默认 http://127.0.0.1:4277
# 或直接运行产物：
RULES_DIR=dist/service/rules STATE_FILE=state/s.jsonl node dist/service/rule-service.mjs
```

### 统一加载与运行参数

| 参数 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 规则目录 | `RULES_DIR` | `rules` | 含 `manifest.json` 与各版本子目录，只读 |
| 状态记录 | `STATE_FILE` | `state/service-state.json` | append-only JSONL，记录采用/拒绝/启停版本 |
| 监听 | `HOST` / `PORT` | `127.0.0.1` / `4277` | 仅绑定回环地址 |
| 锁定版本 | `PINNED_VERSION` | manifest.activeVersion | 启动时强制采用某版本 |
| 请求超时 | `REQUEST_TIMEOUT_MS` | `5000` | 单次请求处理上限 |
| 请求体上限 | `MAX_BODY_BYTES` | `1048576` | 超限返回 413 |
| 探针超时 | `PROBE_TIMEOUT_MS` | `15000` | 启动探针预算 |
| 仅自检 | `SELF_CHECK_ONLY=1` | 关 | 跑一次探针后退出 |

规则目录布局：`manifest.json` 给出 `activeVersion` 与版本摘要，每个版本一个自包含 JSON（规则、角色基础、系统来源、负载、效果）。运行参数遵循「显式参数 > 环境变量 > 内置默认」。

### 启动探针：真实装卸，而非探测端口

服务在监听前先执行启动探针（`src/rule-service/probe.ts`）：创建一名测试角色，**实际在两组负载配置间装卸**，按规则包内声明的派生公式独立复算 `maxHp → shieldCapacity → shieldRegen` 派生链并核对具体数值，再卸回初始负载确认可逆。任何数值不符即以退出码 4 终止，不带故障上线。

### 规则更新：先隔离校验，失败不污染活动版本

候选规则先在隔离的临时实例里完成结构解析与整图校验，通过且能求出非空属性表后才原子切换；**循环引用（`dependency-cycle`）或未知运算符/求值步骤（`unknown-operator`）使候选失败，活动角色继续使用已确认规则集**。校验失败绝不会把空属性表发布给调用方。

```bash
curl -X POST http://127.0.0.1:4277/rules/reload \
  -H 'content-type: application/json' --data-binary @rules/v2/rules.json
# 坏候选示例：deploy/candidates/{cyclic,unknown-operator,unknown-step}.json
```

### 退出码与资源上限

| 退出码 | 含义 |
| --- | --- |
| 0 | 正常运行 / 自检通过 / 优雅停止 |
| 2 | 规则或清单配置错误（含未知运算符、坏引导） |
| 3 | 启动资源缺失（清单/规则文件/目录不存在） |
| 4 | 启动探针失败 |
| 5 | 资源上限触发 |
| 10 | 未捕获运行时错误 |

资源上限（请求超时、请求体字节、探针预算）可经环境变量收紧，超大请求体返回明确的 `413` 而不是连接重置。状态记录的每条事件都带 `activeVersion` 与 `revision`，进程被停止后重启可据其说明最终采用了哪个版本。

### HTTP 接口

- `GET /health`、`GET /ready`：活动版本、状态、属性摘要、资源上限
- `GET /version`：当前规则版本与 revision
- `GET /attributes`、`GET /attributes/:id`：属性列表 / 单属性含求值解释
- `POST /query`：`{ "attributes": [...] }` 批量取值（真实客户端查询入口）
- `GET /loadouts`、`POST /loadouts/switch`：负载装卸
- `POST /rules/reload`：候选规则隔离校验 + 原子热替换

### 部署自检覆盖的场景

`deploy/self-check.mjs` 在临时干净目录中自动验证：零依赖启动、探针闸门、真实客户端查询、两组配置装卸、循环/未知运算符隔离拒绝、只读配置目录、启动资源缺失退出码、进程停止后再次启动且状态记录标明版本、超大请求体 413。**真实客户端完成一次属性查询后自检才算通过。**

## 数据结构与语义

| 来源类型 | 允许的修正 | 说明 |
| --- | --- | --- |
| `base` | 仅 `base` | 角色基础面板，不可单独卸下 |
| `equipment` | `flat` / `percent` / `override` / `derive` | 装备修正，跟随负载挂载/卸载 |
| `buff` | 同上 | 临时增益，按 tick 到期或主动结束 |
| `pressure` | 同上 | 场景压制，通常是负倍率或覆盖 |
| `derived` | 仅 `derive` | 系统固定的换算来源 |

修正算子：

- `base` / `flat`：固定加值
- `percent`：比率，`0.15` = +15%，`-0.4` = -40%，同一桶内按加法叠加
- `override`：覆盖；同属性按 `priority` 降序、`modifierId` 升序决胜，其余标记为 `shadowed`
- `derive`：`依赖属性最终值 × value + offset`，声明 `dependsOn`

规则声明的 `pipeline` 决定求值顺序（例如 `addFlat` 放在 `multiplyPercent` 前后结果不同），`clamp` 必须唯一且位于最后。未出现在 `pipeline` 的算子在整图校验时报 `unconsumed-modifier`。

## 依赖图

`derive` 修正构成 `属性 → 依赖属性` 的有向边。求值按拓扑序进行，`maxHp → shieldCapacity → shieldRegen` 的链会先算被依赖项。整图校验拒绝循环定义，并列出全部参与节点：

```
dependency-cycle 属性=shieldCapacity,shieldRegen ... 依赖图存在循环：shieldCapacity → shieldRegen → shieldCapacity（参与节点 shieldCapacity、shieldRegen）
```

缺失依赖在应用配置前就报 `missing-dependency`，不会等到求值时抛异常。

## 来源撤销的精确性

挂载表以来源身份（`sourceId` 或效果实例 `templateId#n`）为键，每条修正的 id 在实例化时重写并绑定来源。卸下装备、效果到期、切换负载都只删除对应键：

- 数值完全相同的两条 `+37` 修正来自不同来源，卸下其一时另一条仍保留
- 同一刻到期的多个来源在一次 `advanceTick` 中批量撤销，只产生一个 revision、一次重新求值

## 配置事务

```ts
const report = service.validateConfiguration(candidate); // 整图检查：规则 / 依赖 / 来源 / 覆盖 / 循环
const result = service.applyConfiguration(candidate);   // report.ok 才替换，否则旧状态原样保留
```

失败时 `revision` 不变，旧快照继续可算、`explain()` 仍返回旧版本。活动负载与运行效果在替换后保留，新规则若缺少它们引用的属性会被拒绝。

## 查询与解释接口

```ts
service.getValue('maxHp');
service.getValues(['maxHp', 'shieldCapacity']);
service.explain('maxHp');
// → steps: 每步 input/output/delta/桶汇总
// → contributions: 每条修正的 rawValue、appliedValue、shadowed、dependency、note
service.explainSource('loadout.siege.armor');
service.getDependencyGraph(); // { nodes, edges(from,to,modifierId,sourceId,sourceKind) }
```

`explain()` 直接返回该 revision 的求值快照，面板不做二次推导。

## 面板

`npm run build && npm start` 后打开 `http://localhost:4173`：

- 切换负载配置，所有属性值来自服务重新求值
- 选定属性查看求值步骤、来源贡献明细与依赖值；覆盖被压制的修正划线展示
- 激活/结束临时效果、推进 tick，观察同刻到期
- 载入一组含循环定义的候选配置，整图检查失败时应用按钮禁用且旧值不变

本机没有浏览器，面板交互通过 jsdom 加载真实构建产物验证（`tests/panel.test.ts`）。

## 目录

```
src/core/types.ts       公共类型（来源/修正/规则/解释/查询接口）
src/core/validate.ts    规则、来源、覆盖、依赖图循环校验
src/core/evaluate.ts    规则管线求值、拓扑排序、逐项贡献
src/core/service.ts     来源台账、负载/效果、tick、配置事务、查询
src/demo/catalog.ts     演示属性、装备、增益、压制与派生链
src/demo/scenarios.ts   覆盖要求输入的时间线编排
src/rule-service/       本地规则服务（打包为零依赖单文件）
  config.ts             运行参数/清单/规则文件统一加载、退出码、资源上限
  rule-bundle.ts        不受信 JSON 运行时解析（未知运算符/步骤/来源类型）
  version-manager.ts    候选规则隔离校验 + 原子切换，拒绝空属性表
  probe.ts              启动探针：真实装卸两组配置并核对派生数值
  state-journal.ts      append-only 状态记录，标明采用的版本
  http-server.ts        HTTP 接口、请求体上限与超时
  main.ts               启动顺序编排与信号处理
src/web/*               面板视图模型与浏览器控制器
rules/                  版本化规则文件（manifest.json + v1/ + v2/）
deploy/                 部署自检、离线复跑脚本、无效候选样例
tests/                  核心与规则服务（含真实进程的 HTTP 集成测试）
```
