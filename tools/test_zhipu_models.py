# -*- coding: utf-8 -*-\nimport os\n"""Probe which Zhipu vision models are available with this key."""
import base64
import io
import json
import sys
import urllib.error
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

KEY = os.environ.get('ZHIPU_KEY', 'YOUR_ZHIPU_KEY')
URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
H = {"Authorization": "Bearer " + KEY, "Content-Type": "application/json"}

from PIL import Image, ImageDraw, ImageFont
im = Image.new("RGB", (300, 120), "white")
d = ImageDraw.Draw(im)
try:
    f = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 28)
except Exception:
    f = ImageFont.load_default()
d.text((20, 30), "模型探测 A", font=f, fill="black")
d.rectangle([230, 20, 285, 95], fill="blue")
buf = io.BytesIO()
im.save(buf, "JPEG", quality=80)
b64 = base64.b64encode(buf.getvalue()).decode()

CANDIDATES = [
    "glm-4v-flash",
    "glm-4v",
    "glm-4v-plus",
    "glm-4v-plus-0111",
    "glm-4.5v",
    "glm-4.6v",
    "glm-4.6v-flash",
    "glm-4.7v",
    "glm-4.7v-flash",
    "glm-4.1v-thinking-flash",
    "glm-4.5v-flash",
]

for model in CANDIDATES:
    body = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}},
                {"type": "text", "text": "图里的文字是什么？颜色块是什么颜色？简短回答。"},
            ],
        }],
        "stream": False,
        "max_tokens": 100,
    }
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers=H, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read())
            ans = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            print("[OK]   %-26s %s" % (model, ans[:60].replace("\n", " ")))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            msg = json.loads(raw).get("error", {}).get("message", raw[:80])
        except Exception:
            msg = raw[:80]
        print("[FAIL] %-26s HTTP %s %s" % (model, e.code, msg[:70]))
    except Exception as e:
        print("[ERR]  %-26s %s" % (model, str(e)[:70]))
