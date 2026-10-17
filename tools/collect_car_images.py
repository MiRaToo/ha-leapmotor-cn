"""收集官方公开购车页的指定车型渲染图，不使用账号、VIN 或订单接口。"""
import argparse,json,re,sys
from pathlib import Path
from urllib.request import urlopen
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"custom_components/leapmotor"))
from market_picture import fetch_market_picture

def main():
    ap=argparse.ArgumentParser();ap.add_argument("--model",required=True);ap.add_argument("--year",required=True,type=int);ap.add_argument("--energy",choices=("bev","reev"),default="bev");ap.add_argument("--color",default="");ap.add_argument("--edition",default="");ap.add_argument("--output",type=Path,default=ROOT/".apk-cache/work/official-2d");args=ap.parse_args()
    result=fetch_market_picture(args.model,args.year,reev=args.energy=="reev",color=args.color,edition=args.edition)
    if not result.get("url"):print(result["reason"]);return 1
    args.output.mkdir(parents=True,exist_ok=True)
    name=re.sub(r"[^a-z0-9_-]","_",args.model.lower())+"_"+str(args.year)+"_"+args.energy
    with urlopen(result["url"],timeout=20) as r:data=r.read(8_000_000)
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):raise ValueError("整车素材不是 PNG，未写入")
    target=args.output/(name+".png");target.write_bytes(data);target.with_suffix(".json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
    print("素材已保存:",target);print("展示版本:",result.get("year"),result.get("edition"),result.get("color"));return 0
if __name__=="__main__":raise SystemExit(main())
