"""驻车充电账本：复用车况采样，不增加云端请求；费用是估算而非电表读数。"""
from __future__ import annotations

from datetime import datetime
import math
import time
from typing import Any
from zoneinfo import ZoneInfo

MAX_GAP_SECONDS = 900
KEEP_SESSIONS = 400
DEFAULT_TARIFF = {"peak_price": None, "valley_price": None,
                  "ac_peak_price": None, "ac_valley_price": None,
                  "dc_periods": None, "ac_efficiency": None, "dc_efficiency": None,
                  "valley_start": "23:00", "valley_end": "07:00", "efficiency": 0.9}


def number(value: Any) -> float | None:
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (ValueError, TypeError):
        return None


def minute_of(value: str) -> int:
    try:
        if len(value) != 5 or value[2] != ":":
            raise ValueError
        hour, minute = map(int, value.split(":"))
        if not 0 <= hour < 24 or not 0 <= minute < 60:
            raise ValueError
        return hour * 60 + minute
    except (TypeError, ValueError):
        raise ValueError("峰谷时间须为有效的 HH:MM") from None


def validate_tariff(data: dict) -> dict:
    out = {**DEFAULT_TARIFF, **{k: v for k, v in data.items() if k in DEFAULT_TARIFF}}
    for key in ("peak_price", "valley_price", "ac_peak_price", "ac_valley_price"):
        v = out[key]
        n = number(v)
        if v in (None, ""):
            out[key] = None
        elif n is None or not 0 <= n <= 100:
            raise ValueError("电价须为 0～100 元/kWh")
        else:
            out[key] = n
    start, end = minute_of(out["valley_start"]), minute_of(out["valley_end"])
    if start == end:
        raise ValueError("谷电开始与结束时间不能相同；统一电价可将峰谷电价设为相同值")
    efficiency = number(out["efficiency"])
    if efficiency is None or not 0.5 <= efficiency <= 1:
        raise ValueError("充电效率须为 50%～100%")
    out["efficiency"] = efficiency
    for key in ("ac_efficiency", "dc_efficiency"):
        value = out[key]
        if value is None:
            continue  # 旧账本保留共用效率，显式设置后才分别采用。
        value = number(value)
        if value is None or not 0.5 <= value <= 1:
            raise ValueError("交流和直流充电效率须为 50%～100%")
        out[key] = value
    periods=out["dc_periods"]
    if periods is not None:
        if not isinstance(periods,list) or not 1<=len(periods)<=24:raise ValueError("直流分时电价须设置 1～24 个时段")
        occupied=[False]*1440;normalized=[]
        for period in periods:
            if not isinstance(period,dict):raise ValueError("电价时段格式无效")
            a,b=minute_of(period.get("start")),minute_of(period.get("end"));price=number(period.get("price"))
            if price is None or not 0<=price<=100:raise ValueError("每个时段须填写 0～100 元/kWh 的价格")
            minutes=list(range(a,b)) if a<b else [*range(a,1440),*range(b)] if a>b else list(range(1440))
            if any(occupied[m] for m in minutes):raise ValueError("直流电价时段不能重叠")
            for m in minutes:occupied[m]=True
            normalized.append({"start":period["start"],"end":period["end"],"price":price})
        if not all(occupied):raise ValueError("直流电价时段须完整覆盖一天 24 小时")
        out["dc_periods"]=normalized
    return out


def session_tariff(session: dict, tariff: dict) -> dict:
    out=dict(tariff)
    out["periods"]=None
    kinds=[k for k in session.get("charge_types",[]) if k!="unknown"]
    if kinds==["ac"]:
        out["efficiency"] = tariff.get("ac_efficiency") or tariff["efficiency"]
        for band in ("peak","valley"):
            if tariff.get("ac_"+band+"_price") is not None:out[band+"_price"]=tariff["ac_"+band+"_price"]
    elif kinds==["dc"]:
        out["efficiency"] = tariff.get("dc_efficiency") or tariff["efficiency"]
        out["periods"]=tariff.get("dc_periods")
    override=session.get("price_override") or {}
    if override.get("mode")=="unit":out.update(peak_price=override["value"],valley_price=override["value"],periods=None)
    return out


def interval_buckets(begin: float, end: float, kwh: float, tariff: dict, tz: ZoneInfo) -> list[dict]:
    """按实际时间轴的分钟切分，跨午夜、跨谷电边界及夏令时均按本地时钟归属。"""
    if end <= begin or kwh <= 0:
        return []
    start, stop = minute_of(tariff["valley_start"]), minute_of(tariff["valley_end"])
    buckets: dict[tuple[str, str], dict] = {}
    cursor = begin
    while cursor < end:
        nxt = min(end, (math.floor(cursor / 60) + 1) * 60)
        local = datetime.fromtimestamp((cursor + nxt) / 2, tz)
        minute = local.hour * 60 + local.minute
        valley = start <= minute < stop if start < stop else minute >= start or minute < stop
        band = "valley" if valley else "peak"
        day = local.date().isoformat()
        energy = kwh * (nxt - cursor) / (end - begin)
        key = (day, band)
        row = buckets.setdefault(key, {"day": day, "band": band, "kwh": 0.0, "grid_kwh": 0.0, "cost": None})
        row["kwh"] += energy
        row["grid_kwh"] += energy / tariff["efficiency"]
        price = tariff[band + "_price"]
        if tariff.get("periods") is not None:
            price=None
            for period in tariff["periods"]:
                a,b=minute_of(period["start"]),minute_of(period["end"])
                if a==b or (a<=minute<b if a<b else minute>=a or minute<b):price=period["price"];break
        if price is not None:
            row["cost"] = (row["cost"] or 0.0) + energy / tariff["efficiency"] * price
        cursor = nxt
    return list(buckets.values())


class ChargeRecorder:
    def __init__(self, hass: Any, vin: str, capacity_kwh: float, *, store: Any = None,
                 timezone: str = "Asia/Shanghai") -> None:
        if store is None:
            from homeassistant.helpers.storage import Store
            store = Store(hass, 1, f"leapmotor_{vin}_charges")
        self._store = store
        self.capacity = capacity_kwh
        self.timezone = ZoneInfo(timezone)
        self.tariff = dict(DEFAULT_TARIFF)
        self.sessions: list[dict] = []
        self.active: dict | None = None
        self._previous: dict | None = None
        self._seen = 0.0
        self.revision = 0

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.sessions = [s for s in data.get("sessions", []) if isinstance(s, dict) and isinstance(s.get("intervals"), list)][-KEEP_SESSIONS:]
        self.active = data.get("active") if isinstance(data.get("active"), dict) else None
        self._seen = float(data.get("seen") or 0)
        try:
            self.tariff = validate_tariff(data.get("tariff") or {})
        except ValueError:
            self.tariff = dict(DEFAULT_TARIFF)
        # 重启前最后一帧与重启后之间可能漏掉开车/停充，绝不跨重启积分。
        if self.active:
            self._finish(float(self.active.get("last_at") or self.active["started_at"]), "重启中断", partial=True)

    def _dump(self) -> dict:
        return {"sessions": self.sessions[-KEEP_SESSIONS:], "active": self.active,
                "seen": self._seen, "tariff": self.tariff}

    def _save(self) -> None:
        self.revision += 1
        self._store.async_delay_save(self._dump, 5)

    async def set_tariff(self, data: dict) -> dict:
        tariff = validate_tariff({**self.tariff, **data})
        # 保存成功再切换，失败时前端不会误以为电价已生效。
        await self._store.async_save({**self._dump(), "tariff": tariff})
        self.tariff = tariff
        self.revision += 1
        return tariff

    async def set_session_price(self, session_id: str, mode: str, value=None) -> None:
        if mode not in ("auto","unit","total"):raise ValueError("无效的计价方式")
        n=number(value)
        if mode!="auto" and (n is None or not 0<=n<=(100 if mode=="unit" else 100000)):
            raise ValueError("请输入有效的单价（0～100）或总费用（0～100000）")
        if not any(s.get("id")==session_id for s in self.sessions):raise ValueError("记录不存在或仍在充电，结束后可修改价格")
        sessions=[dict(s) for s in self.sessions]
        for s in sessions:
            if s.get("id")==session_id:
                if mode=="auto":s.pop("price_override",None)
                else:s["price_override"]={"mode":mode,"value":n}
        await self._store.async_save({**self._dump(),"sessions":sessions})
        override=next(s.get("price_override") for s in sessions if s.get("id")==session_id)
        # 落盘期间车况轮询可能刚结束另一条充电；只合并目标字段，不覆盖新记录。
        for s in self.sessions:
            if s.get("id")==session_id:
                if override is None:s.pop("price_override",None)
                else:s["price_override"]=dict(override)
        self._save()

    def _finish(self, at: float, reason: str, *, partial: bool = False) -> None:
        if self.active:
            self.active.update(ended_at=at, reason=reason, partial=partial or self.active.get("partial", False))
            self.sessions.append(self.active)
            self.sessions = self.sessions[-KEEP_SESSIONS:]
        self.active = None
        self._previous = None
        self._save()

    def process(self, state: Any, *, now: float | None = None) -> None:
        now = time.time() if now is None else now
        self.expire(now)
        raw_ts = number(getattr(state, "collect_time", None))
        if not raw_ts or raw_ts <= 0:
            # 缺少采样时刻无法区分反复返回的旧帧，不用轮询时刻补造样本。
            if self.active:
                self._finish(float(self.active["last_at"]), "采样时刻缺失", partial=True)
            return
        at = raw_ts / 1000 if raw_ts > 10_000_000_000 else raw_ts
        if at <= self._seen or at > now + 120:
            return
        self._seen = at
        speed = number(state.get("speed"))
        gear = number(state.get("gear"))
        valid = (state.vehicle_state == "parked" and state.charging is True
                 and not (speed is not None and speed > 0) and gear not in (1, 3)
                 and now - at <= MAX_GAP_SECONDS)
        if not valid:
            if self.active:
                unknown = state.charging is None or state.vehicle_state is None or now - at > MAX_GAP_SECONDS
                self._finish(float(self.active["last_at"]), "状态未知" if unknown else "停止充电", partial=unknown)
            return
        soc = number(state.soc)
        if soc is not None and not 0 <= soc <= 100:
            soc = None
        voltage, current = number(state.get("charging_voltage")), number(state.get("charging_current"))
        power = abs(voltage * current) / 1000 if voltage is not None and current is not None and voltage > 0 else None
        if power is not None and not 0 < power <= 400:
            power = None
        sample = {"at": at, "soc": soc, "power": power}
        if self._previous and at - self._previous["at"] > MAX_GAP_SECONDS:
            self._finish(self._previous["at"], "采样中断", partial=True)
        if not self.active:
            self.active = {"id": f"charge-{int(at * 1000)}", "started_at": at, "last_at": at,
                           "soc_start": soc, "soc_end": soc, "intervals": [], "partial": False,
                           "power_samples": [], "peak_kw": None, "charge_types": []}
        dc, plug = state.flag("dc_cable_connected"), state.flag("charge_plug")
        kind = "dc" if dc is True else "ac" if dc is False and plug is True else "unknown"
        known=[k for k in self.active.get("charge_types",[]) if k!="unknown"]
        if kind!="unknown" and known and kind not in known:
            self._finish(float(self.active["last_at"]),"充电枪类型改变")
            self.active={"id":f"charge-{int(at*1000)}","started_at":at,"last_at":at,"soc_start":soc,"soc_end":soc,"intervals":[],"partial":False,"power_samples":[],"peak_kw":None,"charge_types":[]}
        kinds=self.active.setdefault("charge_types", [])
        if kind not in kinds: kinds.append(kind)
        samples=self.active.setdefault("power_samples", [])
        samples.append([at,power])
        if len(samples)>1024: samples[:]=samples[::2]+[samples[-1]]
        if power is not None: self.active["peak_kw"]=max(self.active.get("peak_kw") or 0,power)
        previous = self._previous
        if previous:
            hours = (at - previous["at"]) / 3600
            energy, source = None, ""
            soc_drop = previous["soc"] is not None and soc is not None and soc < previous["soc"] - .5
            if not soc_drop and previous["power"] is not None and power is not None:
                energy = (previous["power"] + power) / 2 * hours
                source = "power"
            elif previous["soc"] is not None and soc is not None and soc >= previous["soc"]:
                energy = (soc - previous["soc"]) / 100 * self.capacity
                source = "soc"
            # SOC 突然回跳、没有电量和功率证据或超出合理功率范围时不造数据。
            if energy is not None and 0 <= energy <= 400 * hours:
                intervals = self.active["intervals"]
                if energy == 0 and intervals and intervals[-1][2] == 0 and intervals[-1][3] == source:
                    intervals[-1][1] = at
                else:
                    intervals.append([previous["at"], at, energy, source])
                if len(intervals) > 4096:
                    a, b = intervals[:2]
                    intervals[:2] = [[a[0], b[1], a[2] + b[2], a[3] if a[3] == b[3] else "mixed"]]
                    self.active["partial"] = True
            else:
                self.active["partial"] = True
        self.active.update(last_at=at, soc_end=soc)
        self._previous = sample
        self._save()

    def expire(self, now: float) -> None:
        if self.active and now - float(self.active["last_at"]) > MAX_GAP_SECONDS:
            self._finish(float(self.active["last_at"]), "遥测中断", partial=True)

    def view(self, days: int = 30, *, now: float | None = None) -> dict:
        from datetime import timedelta
        now = time.time() if now is None else now
        today = datetime.fromtimestamp(now, self.timezone).date()
        start_day = today - timedelta(days=days - 1)
        begin = datetime.combine(start_day, datetime.min.time(), self.timezone).timestamp()
        end = now
        daily = { (start_day + timedelta(days=i)).isoformat(): {"day": (start_day + timedelta(days=i)).isoformat(),
                  "kwh": 0.0, "grid_kwh": 0.0, "peak_kwh": 0.0, "valley_kwh": 0.0, "cost": 0.0} for i in range(days)}
        unpriced=set()
        configured=bool(self.tariff.get("dc_periods")) or any(self.tariff.get(k) is not None for k in ("peak_price","valley_price","ac_peak_price","ac_valley_price")) or any(s.get("price_override") for s in self.sessions)
        records = []
        for session in [*self.sessions, *([self.active] if self.active else [])]:
            if float(session.get("last_at", 0)) < begin:
                continue
            total = grid = cost = peak = valley = 0.0
            sources = set()
            tariff=session_tariff(session,self.tariff)
            override=session.get("price_override") or {}
            total_grid=sum(p[2] for p in session.get("intervals",[]))/tariff["efficiency"]
            if override.get("mode")=="total" and total_grid>0:
                tariff.update(peak_price=override["value"]/total_grid,valley_price=override["value"]/total_grid,periods=None)
            priced=configured
            for interval in session.get("intervals", []):
                a, b, kwh, source = interval
                total += kwh
                grid += kwh / tariff["efficiency"]
                sources.add(source)
                for row in interval_buckets(a, b, kwh, tariff, self.timezone):
                    if row["cost"] is None and row["kwh"]>0:priced=False
                    if row["cost"] is not None:
                        cost += row["cost"]
                    if row["band"] == "peak": peak += row["kwh"]
                    else: valley += row["kwh"]
                left, right = max(a, begin), min(b, end)
                if right > left:
                    for row in interval_buckets(left, right, kwh * (right - left) / (b - a), tariff, self.timezone):
                        d = daily.get(row["day"])
                        if d:
                            for key in ("kwh", "grid_kwh"): d[key] += row[key]
                            d[row["band"] + "_kwh"] += row["kwh"]
                            if row["cost"] is not None: d["cost"] += row["cost"]
                            elif row["kwh"]>0:unpriced.add(row["day"])
            if override.get("mode")=="total" and total_grid<=0:
                # 实付已知但没有可分配的能量，归入结束日，不由费用倒算电量。
                day=datetime.fromtimestamp(float(session.get("ended_at") or session["last_at"]),self.timezone).date().isoformat()
                if day in daily:daily[day]["cost"]+=override["value"]
            expired = session is self.active and now - float(session["last_at"]) > MAX_GAP_SECONDS
            known=[p for p in session.get("intervals",[]) if p[3]=="power"]
            hours=sum((p[1]-p[0])/3600 for p in known)
            kinds=[k for k in session.get("charge_types",[]) if k!="unknown"]
            records.append({k: session.get(k) for k in ("id", "started_at", "ended_at", "last_at", "soc_start", "soc_end", "reason", "partial")} |
                           {"kwh": round(total, 3) if sources else None, "grid_kwh": round(grid, 3) if sources else None,
                            "cost": override["value"] if override.get("mode")=="total" else round(cost, 2) if sources and priced else None,
                            "price_override":dict(override) if override else None,
                            "peak_kwh": round(peak, 3), "valley_kwh": round(valley, 3),
                            "sources": sorted(sources), "active": session is self.active and not expired,
                            "charge_type": kinds[0] if len(kinds)==1 else "mixed" if kinds else "unknown",
                            "peak_kw": session.get("peak_kw"), "average_kw": round(sum(p[2] for p in known)/hours,2) if hours else None,
                            "power_samples": session.get("power_samples",[]),
                            "partial": expired or session.get("partial", False)})
        for d in daily.values():
            for key in ("kwh", "grid_kwh", "peak_kwh", "valley_kwh", "cost"):
                d[key] = round(d[key], 3)
            if not configured or d["day"] in unpriced: d["cost"] = None
        rows = list(daily.values())
        return {"days": rows, "sessions": records[::-1], "tariff": dict(self.tariff), "revision": self.revision,
                "summary": {"kwh": round(sum(d["kwh"] for d in rows), 2),
                            "grid_kwh": round(sum(d["grid_kwh"] for d in rows), 2),
                            "cost": round(sum(d["cost"] for d in rows), 2) if all(d["cost"] is not None for d in rows) else None,
                "count": len(records)}, "timezone": str(self.timezone), "active": bool(self.active and now-float(self.active["last_at"])<=MAX_GAP_SECONDS)}
