# 接到 HomeKit(以及 Google / Alexa)

> **先说结论**:集成本身**不提供** HomeKit —— 这不是本项目的取舍,而是 Home Assistant 的架构:
> 集成只负责把"设备与实体"做好,**平台对接统一由 HA 的桥完成**。所以任何集成(小米、美的……)
> 接 HomeKit 都是"用户加一个桥 + 扫码配对"这两步,而且**配对必须在 iPhone 上扫码**,
> 天然无法自动化。

## 1. 为什么要单独讲这件事

HA 的 HomeKit 桥有两条配置路径,而**界面那条做不到"只暴露某几个实体"**:

| 路径 | 能做到 | 做不到 |
|---|---|---|
| **界面**(设置 → 设备与服务 → 添加集成 → HomeKit Bridge) | 选域、选实体、排除 | ❌ 只选实体不选域 —— 实体列表是**按域过滤**的,域留空就一个都选不到 |
| **YAML**(`configuration.yaml`) | 精确到"只要这几个实体" | 改了要重启 HA;界面上不可编辑 |

原因是 HA 过滤器的判定规则是**并集**:`include_entities` 是"额外再加上这些",
**不会**收窄 `include_domains` 的范围。只有"只写 include_entities、不写 include_domains"
(规则第 6 条)才是"只包含列出的实体"。

## 2. 推荐做法:一个只放车的 YAML 桥

把下面这段追加到 `configuration.yaml`,**把 `<slug>` 换成你自己实体 ID 中间那段**
(在 HA 里看任意一个零跑实体,形如 `lock.<slug>_che_men_suo`),然后重启 HA:

```yaml
homekit:
  - name: 零跑汽车
    port: 21065            # 与其它桥不同即可(常见桥用 21063/21064)
    filter:
      include_entities:    # ← 只写实体、不写 include_domains = "只包含这些"
        - lock.<slug>_che_men_suo
        - climate.<slug>_kong_diao
        - switch.<slug>_hou_bei_xiang          # 后备箱
        - switch.<slug>_zhe_yang_lian          # 遮阳帘
        - switch.<slug>_fang_xiang_pan_jia_re  # 方向盘加热
        - switch.<slug>_hou_shi_jing_jia_re    # 后视镜加热
        - switch.<slug>_jian_kang_chong_dian   # 健康充电
        - switch.<slug>_yu_yue_chong_dian      # 预约充电
        - button.<slug>_xun_che_ming_di        # 寻车鸣笛
        - button.<slug>_che_chuang_quan_kai    # 车窗-全开
        - button.<slug>_che_chuang_wei_kai     # 车窗-微开
        - button.<slug>_che_chuang_ban_kai     # 车窗-半开
        - button.<slug>_che_chuang_guan        # 车窗-关
        - button.<slug>_dian_chi_yu_re_kai     # 电池预热-开
        - button.<slug>_dian_chi_yu_re_guan    # 电池预热-关
        - button.<slug>_shua_xin_che_kuang     # 刷新车况
        - sensor.<slug>_che_nei_wen_du         # 车内温度(HomeKit 支持 temperature)
```

这 17 个是**能进桥**的:车门锁 / 空调 / 6 个开关 / 8 个按钮 / 车内温度。
其余实体进不去的原因见 §3 —— 不是配置问题,是 HomeKit 没有对应的配件类型。

重启后:设置 → 设备与服务 里会出现 **HomeKit Bridge(零跑汽车)** →
点开它给出的**通知**扫码 → iPhone 家庭 App → ＋ → 添加配件。

> 懒着手写的话,仓库里也带了个生成器 `tools/make_homekit_yaml.py`,
> 它会按你的实体前缀自动生成同样的一份清单(见 `tools/make_homekit_yaml.py --help`)。
>
> 老安装的实体 ID 可能还是旧名字(改中文名不会改已注册的 entity_id),
> 例如车窗-全开在**老安装**里可能仍叫 `..._che_chuang_kai`(改名不会改已注册的 entity_id),
> 新装则是 `..._che_chuang_quan_kai` —— 以你自己 HA 里看到的为准。

## 3. 三个必须知道的坑

1. **每个桥最多 150 个配件**(HomeKit 协议限制,HA 文档明确写了)。如果家里已有几百个
   配件塞在同一个桥里,新配件会**加不进去** —— 解决办法就是**按用途拆桥**(车单独一个桥)。
2. **HomeKit 不支持的域**(写进去也不会出现, 实测于 2026-09 的 HA + C10):
   `number`(**充电上限、座椅加热通风 —— HomeKit 压根没有 number 域**)、`device_tracker`
   (车辆位置)、`time`(预约充电时间)、`image`(驻车照片)、`text`(原始指令)。
   传感器也只有**部分类型**会暴露:车内温度(temperature)✓ 能进;电量(battery)✗ 不会单独成配件
(HomeKit 的电池只作为别的配件的"关联电池"),续航/胎压/总里程(distance/pressure)✗ 无对应类型。
   → 想在 iPhone 上调充电上限/座椅, 目前只能回 HA 界面(或做场景/脚本用)。
3. **诊断类实体默认不进桥**:`会话状态`、`交付天数`、`充电配置`、`驻车照片地址`、`最近指令回执`
   标了 diagnostic,除非在实体列表里**明确点名**,否则不会暴露。

## 4. 配对之后:改动的可见性

* **新增**配件:桥重启后几秒内自动出现在家庭 App(没出现就下拉刷新 / 重启家庭 App)
* **移除**配件:HA 侧删掉后,家庭 App 里会变成"无响应" —— 需要**手动清理**:
  家庭 App → 长按该配件 → 设置 → 移除配件
* 改了 YAML → 必须**重启 HA** 才生效

## 5. Google Assistant / Alexa / Matter 呢?

**同一批实体直接可用,不需要本项目做任何额外工作** —— 在 HA 里加对应的集成即可:

| 平台 | 怎么做 | 备注 |
|---|---|---|
| **Google Assistant** | 设置 → 设备与服务 → 添加集成 → Google Assistant | 需要 HA Cloud 订阅,或自建(Google 项目 + 服务账号) |
| **Alexa** | 同上,选 Alexa | 同样需要 HA Cloud 或自建 |
| **Matter** | 由 HA 的 Matter 桥提供 | 视 HA 版本而定 |

实体只要用**标准域 + 标准 `device_class`**,各平台就能正确识别 —— 本集成的电量/温度/胎压/里程
都是标准类型,所以这一步是现成的。

## 6. 常见问题

**Q: 家庭 App 里看不到某个实体?**
先确认它属于 HomeKit 支持的域(见 §3),再确认它没被标成诊断类;`device_tracker`/`time`/
`image`/`text` 无论如何都不会出现。

**Q: 桥里配件数量对不上?**
用界面配置时,"域"里勾了哪些,那个域下**所有**实体都会进(并集规则)。想精确控制就改用 §2 的 YAML 桥。

**Q: 控制没反应 / 显示无响应?**
先看 HA 里实体本身是否可用(诊断传感器「会话状态」);HomeKit 侧"无响应"常见于配件已被 HA 移除
但 iOS 还留着记录 —— 按 §4 手动删掉再重加。
