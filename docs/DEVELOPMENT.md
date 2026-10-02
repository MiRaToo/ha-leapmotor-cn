# 开发指南

> 给想改这个项目的开发者:代码怎么组织、加一个实体/一条指令要动哪几处、怎么测、怎么部署。
> 协议细节见 [PROTOCOL.md](PROTOCOL.md);面向用户的安装见 [SETUP.md](SETUP.md)。

### 下发指令的约定(`coordinator.async_call`)

`await coordinator.async_call("ac_off")` 这类调用有两条必须知道的约定:

1. **失败会抛异常**。云端没受理时抛 `HomeAssistantError`(HA 界面上会弹提示),
   **不会**返回一个 `code != 0` 的字典让你自己判断。所以在它之后可以直接写
   "记下乐观状态 / 更新界面", 不用担心把一个没发生的动作显示成已发生。
2. **签名类错误会自动重试一次**。车端 JWT 是轮换的, 若本地用的是旧密钥,
   服务端会回 `302010205/302002002/39`; 这时 `async_call` 会强制重新交换
   车端 token 并原样重发一次, 用户无感。这类错误**不等于**会话失效,
   不要往"重新认证"上引导(两套判定见 `api_client.SIGNATURE_ERROR_CODES`
   与 `AUTH_ERROR_CODES`, 测试保证二者互斥)。

新增指令时: 在 `poller/api_client.py` 里加 `xxx()` 方法(形状参考
`docs/PROTOCOL.md` §6.2), 跑 `python tools/sync_api.py` 同步到集成,
再用 `python -m pytest tests/test_command_payloads.py` 把形状钉住。
真车验证前先确认 cmdId 在你这辆车的授权清单(`rightList`)里, 否则只会拿到 `code=40`。


## 1. 代码结构

```
poller/
  api_client.py        ★ 唯一真源:登录/签名/车端交换/车况/车控/信号表(SIGNAL_IDS)

custom_components/leapmotor/     ★ HA 自定义集成(用户实际安装的东西)
  __init__.py          平台注册 + 自带前端卡片注册
  config_flow.py       手机号 + 短信验证码登录; 重新认证(reauth)流程
  coordinator.py       轮询、token 续期、会话失效判定、指令下发封装
  entity.py            实体基类(设备信息/命名)
  api.py               ← 由 poller/api_client.py 同步而来, 不要手改
  lock/climate/switch/number/time/button/sensor/device_tracker/image/text.py
  brand/               集成页显示的项目图标
  www/leapmotor-map.js 高德底图地图卡(注册为前端模块)
  translations/*.json  中英文字符串

tools/
  sync_api.py          poller/api_client.py → custom_components/leapmotor/api.py 同步
  deploy_ha.py         通过 SSH 把集成推到你自己的 HA 并重启(凭据走环境变量)
  make_homekit_yaml.py 生成「只暴露车实体」的 HomeKit 桥 YAML(见 docs/homekit.md)

tests/                 pytest; 覆盖签名/指令/解析/信号/会话判定等
```

**改 API 相关逻辑只改 `poller/api_client.py`**,然后跑:

```bash
python tools/sync_api.py        # 把 api_client.py 同步进集成
python -m pytest tests -q       # 全部用例
```

> 测试只覆盖本项目自己的部分:协议解析、车况信号、会话续期、指令形状、地图卡逻辑。

## 2. 加一个传感器(最常见)

1. 先确认信号存在:`LeapmotorClient.get_car_state()` 拿到 `CarState`,看 `raw` 里有没有目标信号号
2. 在 `poller/api_client.py` 的 `SIGNAL_IDS` 里加一行 `"信号号": "字段名"`
3. 在 `custom_components/leapmotor/sensor.py` 里写一个类,继承 `_Base`:

```python
class LeapmotorSomething(_Base):
    key = "something"                      # ← 决定 unique_id, 必须唯一
    _attr_device_class = SensorDeviceClass.ENERGY
    _attr_native_unit_of_measurement = "kWh"

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "中文实体名")

    @property
    def native_value(self) -> float | None:
        st = self.coordinator.car_state
        return st.get("字段名") if st else None
```

4. 把它加进同文件 `async_setup_entry` 的 `add([...])` 列表 —— **顺序即设备页显示顺序**
5. 加个测试(参考 `tests/test_car_state.py`),跑 `pytest`

> ⚠️ 四个胎压传感器踩过的坑:`key` 必须在每个实例上唯一,否则只有第一个注册成功。
> 需要"同一类多个实例"时,在 `__init__` 里先设 `self.key = f"xxx_{参数}"` 再 `super().__init__`。

## 3. 加一条控制指令

1. 在 `poller/api_client.py` 的 `CMD_*` 常量里确认/新增 cmdId
2. 写一个方法,走 `self.remote_control(vin, CMD_XXX, state_dict)` —— 它会自动先校验操作密码

```python
def my_action(self, vin: str = "", on: bool = True) -> dict:
    """实测(日期/来源): state 形状 {"value":"1"}。"""
    return self.remote_control(vin, CMD_MY_ACTION, {"value": "1" if on else "0"})
```

3. 在对应平台里调用:`await self.coordinator.async_call("my_action", on=True)`
4. 若该功能在车况里有对应信号(例如开关状态),**让实体优先读真实状态**,读不到再退回"假定状态"
   (见 `switch.py` 的 `_real` / `assumed_state` 写法)
5. 别忘了 `state` 里的枚举值必须是**字符串**,否则服务端受理、车端不执行

## 4. 调试

* **看数据**:集成里 `最近指令回执` 与 `会话状态` 两个诊断传感器;日志开 debug:
  ```yaml
  logger:
    logs:
      custom_components.leapmotor: debug
  ```
* **看原始响应**:`最近指令回执` 诊断传感器里存着最近一条指令的完整响应(含 `code`/`message`),
  排查"受理了但车不动"最直接;要更细就按上面的 `logger` 开 debug
* **单独测接口**:不用 HA,直接跑 Python:
  ```bash
  python -c "
  import sys; sys.path.insert(0,'poller')
  from api_client import LeapmotorClient, Session
  s=Session.load('session.json'); c=LeapmotorClient(s)
  print(c.get_car_state().signals)"
  ```
  (`session.json` 由 `scripts/login.py` 生成;里面有 token,已被 .gitignore 忽略)
* **签名不对**时的排查顺序:确认 `hkdf_key_hex` 非空 → 确认参与签名的头齐全 → 确认业务参数
  (查询串/表单字段)也进了签名 → 注意交换端点用 SHA256 而非 HMAC
* **指令受理但车不动**:优先怀疑 `state` 形状(枚举值要字符串)、cmdId 是否属于该车型的 `rightList`、
  以及操作密码是否正确(连错 3 次会锁 5 分钟)

## 5. 部署到自己的 HA

```bash
HA_HOST=<你的HA> HA_USER=hassio HA_PASSWORD=<密码> python tools/deploy_ha.py --restart
```

* 凭据只从环境变量读,**不要写进仓库**
* 脚本用 shell 通道写文件(SSH 附加组件默认禁用 sftp)、`sudo` 写 `/config`
* 部署后验证:`bash -lc 'ha core logs | grep -i leapmotor'`,或在 HA 里看实体状态
* 改前端卡片时记得同时改 `__init__.py` 的 `CARD_VERSION`,否则浏览器会用缓存里的旧文件

发布/打包见 [DEPLOY.md](DEPLOY.md)。

## 6. 前端卡片(地图)

`custom_components/leapmotor/www/leapmotor-map.js` 由集成在 `async_setup` 里注册成前端模块
(`/leapmotor-card/leapmotor-map.js`),用户不需要 HACS 或手动加资源。改完记得**改版本号**
(`__init__.py` 的 `CARD_VERSION`),否则浏览器缓存旧文件。

卡片用高德瓦片,因为国内网络加载不出 OpenStreetMap 底图;车端经纬度**本身就是 GCJ-02**,
与高德一致,**不要**再做坐标转换(转换反而会偏几百米)。详见 [dashboard.md](dashboard.md)。

## 7. 代码约定

* 注释写"为什么",不写"做了什么";中文注释,面向后续维护者
* 实测结论要带**日期和来源**(例:`实测(2026-09-27): POST 必须用表单`),方便日后复核
* 拿不准的地方明确标注"未验证",不要写成事实
* 会话/密码/token 绝不写进日志、文档、测试数据
