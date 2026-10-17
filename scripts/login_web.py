#!/usr/bin/env python3
"""零跑 CN 网页版登录 —— 在浏览器里输入手机号 + 验证码, 不需要命令行。

给 Home Assistant 用户准备的最简入口: 在跑 HA 的那台机器上执行本脚本,
然后用浏览器打开提示的地址即可完成登录 + 生成 session.json。
**只用 Python 标准库**, 不依赖 FastAPI/paho, 也不会碰到现有 web/ 服务。

用法:
    python scripts/login_web.py                     # 监听 127.0.0.1:8765
    python scripts/login_web.py --host 0.0.0.0       # 允许局域网访问(见下方安全提示)
    python scripts/login_web.py -o /config/session.json

安全提示:
    * 默认只监听 127.0.0.1 —— 只有本机能访问。若要让手机/别的电脑打开,
      用 --host 0.0.0.0, 但请确认处在可信内网; 页面本身没有鉴权。
    * 登录成功后页面会把会话写到磁盘(含签名密钥), 等价于账号凭据。
"""

from __future__ import annotations

import argparse
import html
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from poller.api_client import (  # noqa: E402
    LeapmotorClient,
    Session,
    new_device_id,
)

STATE: dict = {"phone": "", "client": None, "message": "", "done": False, "log": []}
# 登录成功后给用户的下一步提示(自定义集成, 不需要 MQTT 桥)
ADDON_MODE = False
LOCK = threading.Lock()

PAGE = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>零跑 CN 登录</title><style>
body{{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;max-width:640px;
margin:24px auto;padding:0 16px;line-height:1.6;color:#222}}
h1{{font-size:1.35rem}} .warn{{background:#fff8e1;border:1px solid #f0d48a;border-radius:8px;
padding:12px 14px;margin:16px 0;font-size:.94rem}}
.card{{border:1px solid #ddd;border-radius:10px;padding:16px;margin:16px 0}}
input{{font-size:1rem;padding:10px;width:100%;box-sizing:border-box;border:1px solid #ccc;
border-radius:8px;margin:6px 0 12px}}
button{{font-size:1rem;padding:10px 18px;border:0;border-radius:8px;background:#0a7d55;
color:#fff;cursor:pointer}} button:disabled{{background:#9bb}} button.ghost{{background:#5a6b7a}}
pre{{background:#f6f6f6;border-radius:8px;padding:12px;overflow:auto;font-size:.86rem}}
.ok{{color:#0a7d55;font-weight:600}} .err{{color:#b3261e;font-weight:600}}
.msg{{margin:12px 0}} .muted{{color:#666;font-size:.9rem}}
</style></head><body>
<h1>零跑汽车登录</h1>
<div class="warn"><b>⚠️ 请务必使用【子账号】,不要用主账号。</b><br>
零跑云是单账号单会话:本项目持续登录会把手机上的官方 App 顶下线。<br>
正确做法:另一个手机号注册子账号 → 官方 App(主账号)里「我的车辆 → 车辆共享」邀请它 →
子账号接受共享 → 再来这里用<b>子账号</b>手机号登录。</div>
{body}
</body></html>"""

FORM_PHONE = """<div class="card"><form method="post" action="./send">
<label>子账号手机号</label>
<input name="phone" placeholder="138xxxxxxxx" value="{phone}" autofocus>
<button type="submit">发送验证码</button>
<p class="muted">登录协议与官方 App 相同,只是不需要装 App。</p>
</form></div>{msg}{log}"""

FORM_CODE = """<div class="card"><div class="msg">验证码已发送到 <b>{phone}</b>,请查收短信。</div>
{msg}
<form method="post" action="./login">
<input type="hidden" name="phone" value="{phone}">
<label>短信验证码</label>
<input name="code" placeholder="6 位数字" autofocus>
<button type="submit">登录</button>
</form>
<form method="post" action="./send" style="margin-top:12px">
<input type="hidden" name="phone" value="{phone}">
<button type="submit" class="ghost">重新发送验证码</button>
</form>
<p class="muted">验证码几分钟内有效;没收到就点「重新发送」(同一号码 60 秒内重复请求会被服务端拒绝)。</p>
</div>{log}"""

RESULT = """<div class="card"><div class="msg {cls}">{message}</div>
<pre>{detail}</pre>
{hint}
<p class="muted">token 约 2 小时后过期,到期后重新打开本页登录一次即可。</p></div>"""

RESULT_RETRY = """<div class="card"><div class="msg err">✗ {message}</div>
<pre>{detail}</pre>
<form method="post" action="./exchange" style="margin-top:12px">
<button type="submit">重试车端交换(不用重新收短信)</button></form>
<p class="muted">手机号登录已成功,账号 token 已保存;
上面这一步是"用账号 token 换车端 token",可以单独重试。</p>
</div>{log}"""

HINT_ADDON = ('<p class="muted">可以关闭本页 —— 把 custom_components/leapmotor/ 放进 HA 的 config/custom_components/ 后重启, 再在 设置 → 设备与服务 里添加「零跑」集成。</p>')
HINT_CLI = ('<p class="muted">可以关闭本页。之后把 custom_components/leapmotor/ 放进 HA 的 '
            'config/custom_components/ 并重启, 再在 设置 → 设备与服务 里添加「零跑」集成。</p>')


# 服务端错误码 → 给用户看的话(原始 JSON 仍会附在下面, 便于排查)
FRIENDLY = {
    100115: "验证码不正确 —— 请检查后重填,或点下面「重新发送验证码」",
    100116: "验证码已过期 —— 请点下面「重新发送验证码」",
    1019: "服务端返回 1019(参数为空):这是客户端把参数格式发错了,请把下面这段发给我",
    36: "验证码发送过于频繁(36)—— 等几分钟再试",
    1023: "账号环境被风控(1023)—— 请**静默等待 30 分钟以上**,期间不要重试"
          "(继续请求会不断续期冷却)",
}


def _friendly(code) -> str:
    return FRIENDLY.get(code, "")


def _log_html() -> str:
    if not STATE["log"]:
        return ""
    return "<pre>" + html.escape("\n".join(STATE["log"])) + "</pre>"


def render(body: str) -> bytes:
    return PAGE.format(body=body).encode("utf-8")


def _hint(out) -> str:
    return HINT_ADDON if ADDON_MODE else HINT_CLI.format(out=out)


class Handler(BaseHTTPRequestHandler):
    server_version = "LeapmotorCNLogin/1.0"

    def _send(self, body: str, code: int = 200):
        data = render(body)
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):   # 静默,避免刷屏
        pass

    # ---- 路由 ----
    def _route(self) -> str:
        """取路径最后一段 —— 独立运行时是 /send,走 HA Ingress 时是 /api/hassio_ingress/<token>/send。"""
        seg = (self.path or "/").split("?")[0].rstrip("/").rsplit("/", 1)[-1]
        return seg or "index"

    def do_GET(self):  # noqa: N802
        if self._route() == "healthz":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"ok")
            return
        self._send(FORM_PHONE.format(phone="", msg="", log=""))

    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("Content-Length") or 0)
        form = parse_qs(self.rfile.read(n).decode("utf-8", "replace"))
        route = self._route()
        if route == "send":
            self._do_send((form.get("phone") or [""])[0].strip())
        elif route == "exchange":
            self._do_exchange()
        elif route == "login":
            self._do_login((form.get("phone") or [""])[0].strip(),
                           (form.get("code") or [""])[0].strip())
        else:
            self._send(FORM_PHONE.format(phone="", msg="", log=""))

    # ---- 业务 ----
    def _do_send(self, phone: str):
        if not phone:
            self._send(FORM_PHONE.format(phone="", msg='<div class="msg err">请填手机号</div>', log=""))
            return
        with LOCK:
            sess = load_session(OUT)
            client = LeapmotorClient(sess)
            STATE.update(phone=phone, client=client)
            STATE["log"] = [f"设备 ID: {sess.device_id}"]
            try:
                r = client.request_sms_code(phone)
            except Exception as e:  # noqa: BLE001
                STATE["log"].append(f"发送异常: {e}")
                self._send(FORM_PHONE.format(phone=phone,
                                             msg=f'<div class="msg err">发送失败: {html.escape(str(e))}</div>',
                                             log=_log_html()))
                return
            code = r.get("code")
            STATE["log"].append(f"sendmessagecode → code={code} msg={r.get('msg') or r.get('message')}")
            if code == 1023:
                msg = ('<div class="msg err">风控冷却中(1023)。请<b>静默等待 30 分钟以上</b>,'
                       '期间不要重复请求 —— 继续请求会不断续期该冷却。</div>')
                self._send(FORM_PHONE.format(phone=phone, msg=msg, log=_log_html()))
                return
            if code == 36:
                self._send(FORM_PHONE.format(phone=phone,
                                             msg='<div class="msg err">验证码发送频繁(36),请等几分钟再试。</div>',
                                             log=_log_html()))
                return
            if code != 200:
                self._send(FORM_PHONE.format(
                    phone=phone,
                    msg=f'<div class="msg err">发送失败: {html.escape(json.dumps(r, ensure_ascii=False)[:300])}</div>',
                    log=_log_html()))
                return
        self._send(FORM_CODE.format(phone=html.escape(phone), msg="", log=_log_html()))

    def _do_exchange(self):
        """只重试"车端交换"——复用已保存的账号 token, 不用重新收短信。"""
        with LOCK:
            sess = load_session(OUT)
            if not sess.token or not sess.user_id:
                self._send(FORM_PHONE.format(
                    phone="",
                    msg='<div class="msg err">没有可用的账号 token,请重新用手机号登录。</div>',
                    log=_log_html()))
                return
            client = LeapmotorClient(sess)
            lines = [f"复用已保存的账号 token(userId={sess.user_id})"]
            STATE["log"] = lines          # 让重试页的日志区能看到
            try:
                r2 = client.car_login()
                lines.append(f"[2/3] 车端交换 → code={r2.get('code')} msg={r2.get('message')}")
                if not client.session.car_token or not client.session.sign_param:
                    self._send(RESULT_RETRY.format(
                        message="车端登录失败(仍失败)",
                        detail=html.escape(json.dumps(r2, ensure_ascii=False, indent=2)[:800]),
                        log=_log_html()))
                    return
                self._finish(client, lines)
            except Exception as e:  # noqa: BLE001
                self._send(RESULT_RETRY.format(message="车端交换异常",
                                               detail=html.escape(str(e)), log=_log_html()))

    def _finish(self, client, lines: list[str]):
        """交换成功后的收尾: 派生密钥 → 验证车辆列表 → 落盘 → 出结果页。"""
        key = client.session.seal_key()
        lines.append(f"[3/3] 本地派生签名密钥 → {key}")
        try:
            vs = client.get_vehicle_list()
        except Exception as e:  # noqa: BLE001
            vs = []
            lines.append(f"车辆列表异常: {e}")
        for v in vs:
            lines.append(f"车辆: {v.vin}  {v.car_type}  {v.year} 款  ({len(v.right_list)} 条指令授权)")
        client.session.save(OUT)
        lines.append(f"会话已写入 {OUT}")
        cls = "ok" if vs else "err"
        msg = "✅ 登录成功" + ("" if vs else "(未取到车辆,请确认子账号已被共享车辆)")
        self._send(RESULT.format(cls=cls, message=msg,
                                 detail=html.escape("\n".join(lines)), hint=_hint(OUT)))

    def _do_login(self, phone: str, code: str):
        client = STATE.get("client")
        if client is None or STATE.get("phone") != phone:
            self._send(FORM_PHONE.format(phone=html.escape(phone),
                                         msg='<div class="msg err">会话已失效,请重新发送验证码。</div>',
                                         log=""))
            return
        if not code:
            self._send(FORM_CODE.format(phone=html.escape(phone),
                                        msg='<div class="msg err">请填验证码</div>', log=_log_html()))
            return
        with LOCK:
            lines: list[str] = []
            try:
                r = client.login(phone, code)
                lines.append(f"[1/3] 账号登录 → code={r.get('code')} msg={r.get('msg') or r.get('message')}")
                if r.get("code") == 200 and client.session.token:
                    # 立刻落盘: 即使下一步(车端交换)失败, 也不用重新收短信
                    client.session.save(OUT)
                    lines.append("账号 token 已保存 —— 后续步骤失败也能单独重试")
                if r.get("code") != 200 or not client.session.token:
                    detail = json.dumps(r, ensure_ascii=False, indent=2)[:800]
                    bad = r.get("code")
                    tip = _friendly(bad)
                    # 风控是"终止态":别让用户反复点, 直接给结果页
                    if bad == 1023:
                        self._send(RESULT.format(cls="err", message=f"✗ {tip}", detail=detail,
                                                 hint=_hint(OUT)))
                        return
                    if bad == 1019:
                        self._send(RESULT.format(cls="err", message=f"✗ {tip}", detail=detail,
                                                 hint=_hint(OUT)))
                        return
                    # 验证码类错误:留在验证码页, 让他改一个或重发
                    self._send(FORM_CODE.format(
                        phone=html.escape(phone),
                        msg='<div class="msg err">✗ %s</div><pre>%s</pre>'
                            % (html.escape(tip or "登录失败"), html.escape(detail)),
                        log=_log_html()))
                    return

                r2 = client.car_login()
                lines.append(f"[2/3] 车端交换 → code={r2.get('code')} msg={r2.get('message')}")
                if not client.session.car_token or not client.session.sign_param:
                    detail = json.dumps(r2, ensure_ascii=False, indent=2)[:800]
                    self._send(RESULT_RETRY.format(message="车端登录失败", detail=html.escape(detail),
                                                   log=_log_html()))
                    return

                key = client.session.seal_key()
                lines.append(f"[3/3] 本地派生签名密钥 → {key}")

                try:
                    vs = client.get_vehicle_list()
                except Exception as e:  # noqa: BLE001
                    vs = []
                    lines.append(f"车辆列表异常: {e}")
                for v in vs:
                    lines.append(f"车辆: {v.vin}  {v.car_type}  {v.year} 款  ({len(v.right_list)} 条指令授权)")

                client.session.save(OUT)
                lines.append(f"会话已写入 {OUT}")
                cls = "ok" if vs else "err"
                msg = "✅ 登录成功" + ("" if vs else "(未取到车辆,请确认子账号已被共享车辆)")
                self._send(RESULT.format(cls=cls, message=msg,
                                         detail=html.escape("\n".join(lines)), hint=_hint(OUT)))
            except Exception as e:  # noqa: BLE001
                self._send(RESULT.format(cls="err", message="✗ 登录异常",
                                         detail=html.escape(f"{e}"), hint=_hint(OUT)))


def load_session(path: Path) -> Session:
    """复用已有 device_id —— 换设备 ID 更容易触发风控。"""
    if path.is_file():
        try:
            s = Session.load(path)
            s.hkdf_key_hex = ""
            return s
        except Exception:  # noqa: BLE001
            pass
    s = Session()
    s.device_id = new_device_id()
    return s


OUT = Path("session.json")


def serve(host: str = "127.0.0.1", port: int = 8765,
          out: str | Path = "session.json") -> ThreadingHTTPServer:
    """建好(但还没 serve_forever)的登录页服务器 —— 供 add-on 在后台线程里跑。"""
    global OUT
    OUT = Path(out)
    return ThreadingHTTPServer((host, port), Handler)


def main() -> int:
    ap = argparse.ArgumentParser(description="零跑 CN 网页登录(仅标准库)")
    ap.add_argument("--host", default="127.0.0.1", help="监听地址(默认仅本机)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("-o", "--out", default="session.json", help="会话输出文件")
    args = ap.parse_args()

    srv = serve(args.host, args.port, args.out)
    print("=" * 66)
    print("  零跑 CN 登录页已启动")
    print(f"  浏览器打开:  http://{'127.0.0.1' if args.host in ('0.0.0.0','::') else args.host}:{args.port}/")
    print(f"  会话将写入:  {Path(args.out).resolve()}")
    print("  ⚠️  请用【子账号】登录(主账号会被本项目顶下线)")
    print("=" * 66)
    print("  Ctrl+C 退出")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出。")
    finally:
        srv.server_close()
        time.sleep(0.1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
