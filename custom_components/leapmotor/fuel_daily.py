"""增程车逐日耗油估算：只用有效行车燃油量差值，不使用油量百分比或均值造日数据。"""
from datetime import datetime
import time
from zoneinfo import ZoneInfo
from .charging import number, MAX_GAP_SECONDS


class FuelDayRecorder:
    def __init__(self,hass,vin,timezone,*,store=None):
        if store is None:
            from homeassistant.helpers.storage import Store
            store=Store(hass,1,f"leapmotor_{vin}_fuel_days")
        self.store=store;self.timezone=ZoneInfo(timezone);self.days={};self.previous=None;self.seen=0

    async def async_load(self):
        self.days=(await self.store.async_load() or {}).get("days",{})

    def process(self,state,*,reev,now=None):
        now=time.time() if now is None else now
        ts=number(getattr(state,"collect_time",None))
        if ts and ts>10_000_000_000:ts/=1000
        if not reev or not ts or now-ts>MAX_GAP_SECONDS or ts>now+120:
            self.previous=None;return
        if ts<=self.seen:return
        self.seen=ts
        fuel=number(state.get("fuel_ml"))
        if state.vehicle_state!="driving" or fuel is None or not 0<fuel<=150_000:
            self.previous=None;return
        old=self.previous;self.previous=(ts,fuel)
        if old is None or ts-old[0]>MAX_GAP_SECONDS:return
        delta=(old[1]-fuel)/1000
        # 油箱增加、传感器跳变或不合理下降不折算；不拿加油量当负消耗。
        if delta<0 or delta>30*(ts-old[0])/3600:return
        begin=old[0];duration=ts-begin
        while begin<ts:
            nxt=min(ts,(int(begin//60)+1)*60)
            day=datetime.fromtimestamp((begin+nxt)/2,self.timezone).date().isoformat()
            self.days[day]=self.days.get(day,0)+delta*(nxt-begin)/duration
            begin=nxt
        self.days=dict(sorted(self.days.items())[-400:])
        self.store.async_delay_save(lambda:{"days":self.days},5)

    def snapshot(self):return {day:round(v,3) for day,v in self.days.items()}
