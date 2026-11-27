# -*- coding: utf-8 -*-
"""Upload a file to HiAgent up-upload service (NodePort) and print JSON.

Usage:
  python upload_helper.py <file> [--endpoint URL] [--ak KEY] [--sk SECRET]

Env fallbacks: HIAGENT_UP_ENDPOINT, HIAGENT_ACCESS_KEY, HIAGENT_SECRET_KEY
Output JSON: {"Path": "...", "Url": "...", "Sha256": "...", "Size": N}
"""
import argparse
import hashlib
import json
import os
import sys
import uuid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--endpoint", default=os.getenv("HIAGENT_UP_ENDPOINT", ""))
    ap.add_argument("--ak", default=os.getenv("HIAGENT_ACCESS_KEY", ""))
    ap.add_argument("--sk", default=os.getenv("HIAGENT_SECRET_KEY", ""))
    ap.add_argument("--download-base", default=os.getenv("HIAGENT_DOWN_BASE", ""),
                    help="public base for down URL, e.g. https://coze.nankai.edu.cn")
    args = ap.parse_args()

    if not args.endpoint or not args.ak or not args.sk:
        print(json.dumps({"error": "缺少 endpoint / AK / SK"}, ensure_ascii=False))
        return 2

    from hiagent_api.up import UpService
    from hiagent_api import up_types

    with open(args.file, "rb") as f:
        blob = f.read()
    sha = hashlib.sha256(blob).hexdigest()
    size = len(blob)
    # very small heuristic; adjust if the platform rejects the type
    content_type = "image/jpeg" if args.file.lower().endswith((".jpg", ".jpeg")) else "image/png"
    if args.file.lower().endswith(".pdf"):
        content_type = "application/pdf"

    up = UpService(endpoint=args.endpoint, region="cn-north-1")
    up.set_ak(args.ak)
    up.set_sk(args.sk)

    req = up_types.UploadRawRequest(
        Id=uuid.uuid4().hex, ContentType=content_type, Expire="15h", Sha256=sha)
    with open(args.file, "rb") as f:
        resp = up.UploadRaw(req, file=f)
    path = resp.Path
    key = ""
    try:
        key = up.DownloadKey(up_types.DownloadKeyRequest(Path=path)).Key
    except Exception:
        pass
    url = ""
    if args.download_base and key:
        from urllib.parse import quote
        url = ("%s/api/proxy/down?Action=Download&Version=2022-01-01&Path=%s&IsAnonymous=true"
               % (args.download_base.rstrip("/"), quote(path, safe="")))
    print(json.dumps({"Path": path, "Key": key, "Url": url,
                      "Sha256": sha, "Size": size}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    sys.exit(main())
