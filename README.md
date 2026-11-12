# 角色属性求值服务

规则驱动的属性引擎：基础数值、装备修正、临时增益、场景压制各有独立的来源身份。求值顺序由属性规则声明，派生关系构成显式依赖图；任何撤销都按来源身份执行，不按数值匹配。

## 快速开始

```bash
npm install
npm test          # 类型检查 + 构建 + 48 项测试
npm run scenarios # 打印覆盖题目要求的时间线与输入
npm run build     # 构建 panel 到 dist/
npm start         # http://localhost:4173
```

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
src/web/*               面板视图模型与浏览器控制器
tests/                  规则顺序、来源撤销、配置事务、面板
```
