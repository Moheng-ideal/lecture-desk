# -*- coding: utf-8 -*-\nimport os\n"""Lecture-desk: test Zhipu GLM-4V-Flash vision API with real images."""
import base64
import io
import json
import sys
import time
import urllib.error
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

KEY = os.environ.get('ZHIPU_KEY', 'YOUR_ZHIPU_KEY')
URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
H = {"Authorization": "Bearer " + KEY, "Content-Type": "application/json"}


def ask(image_b64, question, stream=True):
    body = {
        "model": "glm-4v-flash",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + image_b64}},
                {"type": "text", "text": question},
            ],
        }],
        "stream": stream,
    }
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers=H, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            if not stream:
                data = json.loads(r.read())
                return data["choices"][0]["message"]["content"], time.time() - t0, data.get("usage")
            text = ""
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                p = line[5:].strip()
                if p == "[DONE]":
                    break
                try:
                    d = json.loads(p)
                    delta = d.get("choices", [{}])[0].get("delta", {})
                    if delta.get("content"):
                        text += delta["content"]
                except Exception:
                    pass
            return text, time.time() - t0, None
    except urllib.error.HTTPError as e:
        return "HTTP %s: %s" % (e.code, e.read().decode("utf-8", "replace")[:400]), time.time() - t0, None
    except Exception as e:
        return "ERR %s" % str(e)[:200], time.time() - t0, None


# ---------- test 1: synthetic image with known content ----------
try:
    from PIL import Image, ImageDraw, ImageFont
    im = Image.new("RGB", (420, 200), "white")
    d = ImageDraw.Draw(im)
    d.rectangle([10, 10, 410, 190], outline="black", width=3)
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 30)
    except Exception:
        font = ImageFont.load_default()
    d.text((40, 50), "识图测试 OK", font=font, fill="black")
    d.ellipse([300, 90, 370, 160], fill="red")
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=80)
    b64 = base64.b64encode(buf.getvalue()).decode()
    print("test image bytes:", len(buf.getvalue()), "b64:", len(b64))
    ans, cost, usage = ask(b64, "请描述这张图片：上面写了什么字？有什么图形？")
    print("\n=== 合成图测试 (%.1fs) ===" % cost)
    print(ans[:400])
except Exception as e:
    print("synth image skipped:", e)

# ---------- test 2: real screenshot (Huawei event) ----------
img_path = r"C:\Users\jjf\.dsh\attachments\v1\objects\e2\e218037d8384c77ccff6bf5238ac5cffb1f43548d96fce949a22e2f114fe97af"
try:
    im = Image.open(img_path).convert("RGB")
    im.thumbnail((1200, 1200))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=80)
    b64 = base64.b64encode(buf.getvalue()).decode()
    print("\nreal image bytes:", len(buf.getvalue()), "b64:", len(b64))
    ans, cost, usage = ask(b64, "这张图里是什么活动？什么时间？什么地点？请简要回答。")
    print("\n=== 真实截图测试 (%.1fs) ===" % cost)
    print(ans[:500])
except Exception as e:
    print("real image test failed:", e)
