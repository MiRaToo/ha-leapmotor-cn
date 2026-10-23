# HA / App 原始观测同步协议 v1

状态：v1 实现规范，等待 App 联调。协议版本为 1，与集成发布版本无关。

## 1. 范围与约束

HA 持续采集车辆数据，App 在前台或主动同步时完整下载原始观测；App 不必常驻后台。HA 不负责向 App 输出距离、时长、平均速度、功率、耗电、费用等业务计算结果。App 自行分段、统计及匹配手机来源记录。

“完整”指 HA 实际收到并保存的全部轮询样本，不代表车机每秒产生的所有定位点。两次轮询之间云端未返回的样本、定位授权中断和 HA 离线期间的点不能凭空恢复。

原始观测及同步日志必须保存在本集成独立管理的 SQLite 中，不使用 HA Recorder 数据库。已有 HA 卡片、实体、行程/充电算法及 Store 文件继续工作；档案是同步原始事实的唯一来源，不要求重写现有算法。读取同步接口不得触发额外零跑云端请求或改变轮询频率。

本版本使用 HA `/api/websocket` 自定义命令。所有新命令仅允许 HA 管理员，复用 HA 认证；不引入额外登录令牌或匿名文件下载。普通用户/按车辆 ACL 为后续能力，不得在 v1 中宣称已经支持。现有卡片接口权限不受影响。

## 2. 车辆与来源隔离（强制）

- `source_id`：本 HA 同步源的持久 UUID；IP、URL、手机号、设备昵称、HA config entry ID 均不得作为来源主键。
- `dataset_id`：档案数据集代次 UUID；重建档案时重新生成。正常重启保持不变。
- `vehicle_id`：本数据集中分配并持久保存的车辆 UUID，通过规范化 VIN（去首尾空格、转大写）查找。重新认证、重命名、移除后重新添加同 VIN 不改变此 ID。
- `record_id`：保留已有行程/充电 ID；主键必须至少包含 `(vehicle_id, kind, record_id)`，不能假设旧 ID 全局唯一。
- `observation_id`：档案分配的稳定样本 ID，重传不改变。
- `origin`：`leapmotor_cloud`、`legacy_ha_trip`、`legacy_ha_charge`。手机在 App 端另建自己的 source_id / origin。

除 info / vehicles 外，所有命令必须显式提供 `vehicle_id`。即使只配置一辆车也不得默选第一辆。SQL 查询、下载、快照、游标和删除均绑定车辆。游标 A、样本 ID A 或记录 ID A 不能在车辆 B 请求中读取到 A 的数据。不存在或冲突必须返回错误，不能降级为其它车辆。

成功响应统一包含 `protocol_version: 1`、`source_id`、`dataset_id`；车辆级响应还包含 `vehicle_id`。样本和采集事件的客户端主键使用 `(source_id, dataset_id, vehicle_id, entity_type, entity_id)`；record 必须再纳入 `kind`，即使 trip 与 charge 的 record_id 恰好相同也不能覆盖。

账号不是车辆标识的一部分。同 VIN 通过不同账号取得时仍表示同一辆物理车；不同 VIN 始终拥有不同 vehicle_id，与昵称或车型是否相同无关。

VIN 不一定存在于手机 GPS 数据，App 必须先建立明确的车辆绑定；不能仅以车型或蓝牙连接推断一定是这辆车。

## 3. 原始采集位置与字段

必须在坐标转换、舍入、重复位置过滤、功率计算、控制指令乐观覆盖和轨迹抽稀之前捕获原始字段。T03 具名帧也必须在别名归一化之前捕获原键/原值。不得仅把 `CarState.raw` 的归一化结果称为所有车型的原始响应。

只保留同步所需的允许列表：原始经纬度及备用定位字段、定位时间（若提供）、速度、挡位、总里程、SOC/精确 SOC、电压、电流、插枪/直流枪状态、车辆/供电/充电状态。由版本化字段字典说明字段含义、原始单位及枚举。未提供值保持缺失，不补零，不把 boolean/string 强制改成其它类型后丢弃原值。

禁止导出账号/车端 token、签名、密钥、操作密码、完整认证报文、带签名 URL；不得把整个响应无筛选地存入档案。异常信息只记固定状态、异常类名和必要业务码，不记录请求头或异常原文中的凭据。

`observation` 结构：

```json
{
  "observation_id": "uuid",
  "vehicle_id": "uuid",
  "origin": "leapmotor_cloud",
  "fidelity": "native_raw",
  "field_schema": "leapmotor.raw.v1",
  "layout": "signal_map",
  "coordinate_system": "gcj02",
  "received_at_ms": 1800000000123,
  "source_timestamps": {"collectTime": 1800000000000, "sts": 1800000000000},
  "signals_raw": {"2": "120.1234567", "3": "30.1234567", "1204": 62},
  "legacy_record": null
}
```

- JSON 数字仅作示例，不代表精度或额外推断。
- `layout`：`signal_map` / `named_signal` / `named_data` / `legacy_points`。
- `coordinate_system`：`gcj02` / `wgs84` / `unknown`；不能猜测未知坐标系。
- `source_timestamps` 保存服务端明确提供的原始时间键值。`received_at_ms` 是 HA 接收时刻。缺失车端时间时不以接收时刻填充。
- 时间键来自不同层级时分别保留，例如普通帧的 `collectTime` / `signalMap.sts`，T03 的 `data.collectTimeMs` / `source.sts`。它们不能相互覆盖，也不能用解析器补出的时间代替。App 按字段字典解释单位，原值本身不改写。
- `fidelity`：`native_raw` / `legacy_processed` / `legacy_partial`。
- 原始值不做业务计算；字段字典、ID、序号、版本、完整性信息属于必要协议元数据。

每个新车端样本都要保留，即使坐标与上一帧相同、缺少定位，或 HA 没生成行程。重复返回同一车端时间及完全一致的原始允许字段可复用样本 ID，但保留实际请求结果的 capture_event。相同时间但内容不同必须保留；缺乏可靠车端样本时间时不得仅凭字段相同去重。

仅接受本 coordinator 绑定 VIN 的响应；响应明确包含不同 VIN 时拒绝入档，记录 sanitized capture_event，不可串入另一辆车。

## 4. 分组与采集事实

`record` 仅含：`record_id`、`kind`（trip/charge）、`phase`（recording/completed/partial）、`revision`、原始观测引用/分组边界提示、分段算法版本、旧记录来源标记。可保留 HA 的观测起止时刻作为 `boundary_hint`，必须说明是 HA 分组提示，并非车辆实际行驶/充电起止事实。

不得输出 distance / duration / energy / power / cost / efficiency / average / peak 等计算字段。行程、充电最终关联的 observation 可通过 observations 命令读取；所有原始观测独立进入全量/增量流，不能只同步已分组点。

`capture_event` 至少支持：collector_started、collector_stopped、poll_success、poll_failed、vehicle_unavailable、archive_recovered。携带发生时间、实际采集来源、已知请求结果、当时采样间隔；不把旧缓存帧当本轮成功采样。断电无法产生准确 stop，启动事实与最后成功事实之间是未知区间。

档案写入失败不得破坏现有实体/车控/记录链路；必须标记同步服务未就绪并记录脱敏警告，恢复后提供恢复事实，不伪造丢失样本。

## 5. SQLite、版本与崩溃一致性

数据库位于 HA config 下由集成管理的非公开位置，不放入 www。所有 SQLite I/O 在串行 worker/executor 中执行，禁止阻塞 HA 主事件循环；启用外键、事务，安全关闭。不允许多个线程共享连接而不串行化。

建议表：metadata、vehicles、observations、record_versions、record_observations、capture_events、changes、snapshots。可用等价布局，但必须满足：

1. 样本插入与 observation.upsert 变更同事务，记录版本及其变更同事务，删除及墓碑同事务。
2. 每辆车拥有持久递增 `seq`；每条变更有随机 `commit_id`。发布后 payload 不变，不从当前可变对象临时拼历史事件。
3. 记录版本持续保留到使用它的快照/变更不再有效；原始观测在显式删除之前不可覆盖。
4. 同一次 HA 重启不会重新生成 source_id / dataset_id / vehicle_id，也不会重置 seq。
5. 重复摄入、重复迁移、客户端重传均幂等。

v1 不自动抽稀或按现有 3000/1024/400 上限清理新档案，也不自动删除变更日志。info 必须如实公布保留策略。未来增加空间上限时，必须增加明确的 data.purged 事件和游标失效边界，不能静默清理。

游标是不透明、有完整性校验的令牌，绑定 source_id、dataset_id、vehicle_id、已应用 seq 及该 seq 的 commit_id。签名材料仅保存在服务端。必须验证服务端对应提交仍匹配：仅 seq 没有超过当前 head 不能证明游标有效，备份回档后重新增长可能复用旧 seq。

## 6. 命令与分页

所有时间元数据统一 UTC 毫秒；原始服务端时间字段不改写。所有命令需要 HA 管理员权限。

### 6.1 leapmotor/sync/v1/info

返回协议、来源、数据集、是否 ready、支持命令、字段字典、是否原始全量保留、迁移状态及限制。不暴露 cursor 签名密钥或底层文件路径。

`schemas[field_schema].fields` 描述原始字段的 name / unit / notes（以及已知枚举）；`schemas[field_schema].source_timestamps` 描述原始时间路径的单位。`fields` 是当前 native schema 的便捷副本。`unknown` 表示未确认，客户端不能自行套用其它车型的单位或枚举。

### 6.2 leapmotor/sync/v1/vehicles

返回档案中车辆及当前配置映射：vehicle_id、VIN、显示名、当前 entry_id/device_id（可空）、loaded、archive_ready。历史仍存在但条目卸载时不返回假空库；App 可继续同步已持久数据。车辆是否 loaded 不等于其数据是否有权限。

每车还返回 `migration_status`（pending / partial / complete）。旧历史在后台导入，不延迟原有 HA 实体启动。ready 只表示档案可读写，不表示旧历史已全部迁移；迁移中的旧记录会继续通过 pull 到达，App 应等待 complete 后再判断历史范围是否缺失。

### 6.3 leapmotor/sync/v1/bootstrap

请求：vehicle_id、limit（默认 100，1..200）、page_token（可选）。首请求在单一已提交边界 H 创建快照，返回 items、next_page_token、has_more；末页返回从 H 之后继续的 `cursor`。

items 为带 entity_type 的 observation / record / capture_event；包含完整允许字段，不抽稀、不只返回最近 31 天。可以读取旧数据的全部实际留存点。

所有页面属于同一快照；需通过短期物化快照或不可变版本保留实现。不能简单筛选当前行 `revision <= H`，否则更新后的旧行会漏掉。不得为手机分页长期占用 SQLite 读事务。

当前实现保存快照对应的不可变 journal 序号引用；每页只加载该页 payload，避免每次分页重读整份档案。快照到期清理引用，原始数据及 journal 继续保留。

page_token 绑定车辆、快照和位置，默认有效期 30 分钟。失效返回 snapshot_expired，从头重试本次 bootstrap；不能将不完整快照当空数据。单个响应限制目标 512 KiB，必要时提前截页，不能丢掉超限项。

### 6.4 leapmotor/sync/v1/pull

请求：vehicle_id、cursor、limit（默认 100，1..200）。返回：changes、next_cursor、has_more。按 seq 升序，包含固定版本的完整 observation payload、record 元数据、capture_event 或删除墓碑。单页同样有字节上限。

```json
{
  "protocol_version": 1,
  "source_id": "ha-uuid",
  "dataset_id": "dataset-uuid",
  "vehicle_id": "vehicle-a-uuid",
  "changes": [
    {"seq": 42, "op": "observation.upsert", "entity_id": "point-uuid", "data": {}}
  ],
  "next_cursor": "opaque",
  "has_more": false
}
```

上例 data 省略，实际必须包含完整原始 observation。变更顺序包括在该页边界内所有已提交操作；分页游标推进到实际扫描边界，不跳过数据。无变化仍返回有效 cursor。游标 scope 冲突必须拒绝。

支持 op：observation.upsert、observation.delete、record.upsert、record.delete、capture_event.append。v1 尚未提供主动原始清理入口，不得宣称支持 data.purged 自动清理。

### 6.5 leapmotor/sync/v1/observations

请求：vehicle_id、record_id + kind（可选，只筛选某记录）、after（不透明分页 token，可选）、limit（默认 100，1..200）。返回完整 points、next_page_token、has_more。无 record 过滤时枚举全部观测，包含未被分段的点。

此接口用于重新下载/核验，不能成为“列表已同步但轨迹必须用户打开才下载”的设计。主 bootstrap/pull 已经内联完整原始样本，App 应完整保存。

observations / records 是实时浏览分页，期间数据变化时不保证快照一致性。可靠首次完整同步必须使用 bootstrap，再衔接 pull。

### 6.6 leapmotor/sync/v1/records

请求：vehicle_id、kind（trip/charge，可选）、after、limit。返回分组元数据、next_page_token、has_more，无业务计算结果。持续修改的分组由 pull 发布新 revision；此浏览接口不替代 bootstrap。

### 6.7 错误

统一 HA WebSocket error：unauthorized、vehicle_required、vehicle_unavailable、vehicle_conflict、archive_unavailable、invalid_cursor、reset_required、snapshot_expired、invalid_format、not_found。不同车辆的资源 ID 请求返回 not_found 或 scope 错误，不能泄露其它车的内容。

缺少必填 vehicle_id / cursor、长度或类型错误通常在 HA 命令 schema 层返回 invalid_format；客户端应将其视为请求错误，不尝试默认车辆。

非法/篡改 token 为 invalid_cursor；来源/数据代次/提交分叉/已不再保留的历史为 reset_required。所有错误不得伪装成成功空列表。请求数量、limit、标识与 token 长度应有上限。

## 7. 客户端应用规则

App 在本地数据库事务中同时应用当前页全部实体/墓碑和 next_cursor；网络中断或崩溃后重传不重复计入。首次快照全部完成前使用暂存区，不清除已有成功同步的数据。分页每一页已完整包含对应原始样本，不需要为每点发请求。

记录关联只代表来源的分段提示。App 在自己的计算层维护 logical_trip -> 多个 source record / observation 的关系；保留原始来源，不把多个来源物理拼接后删除原始证据。App 原有手机数据与 HA 数据使用不同 source_id，车辆映射明确后才匹配。

同云端采集可基于同 VIN、原始时间和原始字段识别同一车端事实；手机 GNSS 是另一种观测，需时间/路线/精度/车辆绑定共同判断。不能只按时间戳去重，也不能由手机停车推断充电。App 必须区分同步未完成、源采集缺口、源漏分段、分段差异、互补及无法确认。

HA 来源 record.delete 只作用 HA 副本，不删除手机数据。原始点删除应另有 observation.delete，App 应避免基于被删除样本重新生成已经执行隐私删除的内容；仅隐藏分组与删除原始事实不是同一操作。v1 不新增 App 写回/车辆控制命令。

## 8. 旧历史导入

导入已有行程和充电的实际留存点，保留原 record_id，按车辆与 kind 区分。导入标识持久化，重复启动不重复插入；已经由新档案完整采集的记录不再重复导入其卡片副本。迁移失败可在重新加载条目时重试，不删除旧 Store 文件，不影响现有 HA 页面。

- 行程位置已转换/舍入/过滤/可能抽稀，标记 legacy_processed，明确坐标系及已有坐标版本；时间只按旧存储实际含义标注，不能声称是原车时间。
- 充电可导出仍存在的时间与 SOC；旧 power_samples 是派生功率，不作为原始电压/电流，也不输出为原始值。
- 没有 SOC 就缺失，不能补造；没有点的分组仍可作为 legacy metadata，但无计算摘要。
- 点数量、原始性与可用时间范围如实呈现，不宣称恢复旧版本清理过的数据。

## 9. 必须通过的验收

1. A/B 车有相同旧 record_id、同时采样时，所有表、快照、游标、分页与下载均不串车；重认证/重添加同 VIN 保持 vehicle_id。
2. 同样本重传幂等，同时间不同值保留，位置静止但新时间保留，缺定位但有电流保留；T03 原键/原值不丢。
3. 重启后 source/dataset/车辆/seq 稳定；事务中断不出现只有日志或只有样本；备份分叉旧 cursor 失效。
4. 首次多页快照期间新增/更新/删除不漏；末页 cursor 能接上增量；超时/未就绪不返回假空库。
5. 完整下载超过 3000 个轨迹点、超过 1024 个充电样本，字节/条数截页不漏项；分页中断可重试。
6. legacy 重复导入不重复；不导出费用、距离、计算功率；请求/日志/档案不含认证秘密。
7. 非管理员拒绝；篡改/跨车辆 token 拒绝；卸载一辆车不关闭其它车档案。
8. 原有卡片、车控、轮询次数及记录算法保持通过现有测试。数据库 I/O 不在主事件循环，停止/重载能关闭或释放资源。

## 10. 后续能力（不属于已实现承诺）

按 HA 用户的车辆 ACL、App 写回、变化订阅、大文件压缩下载、自动保留策略与确认机制需另行版本化协商。info 只能宣告已实际实现且经测试的能力。
