"""Stage and publish a signed Android APK in the Lecture Desk download directory."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess
from urllib.request import Request, urlopen


SERVER = "http://8.141.106.190/lecture-desk/"
GITHUB = "repos/Moheng-ideal/lecture-desk/releases/latest"

REMOTE = r"""
import fcntl
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import time

operation, metadata = sys.argv[1:]
release = json.loads(metadata)
folder = Path('/srv/lecture-desk-downloads')
assert folder.resolve() == folder and folder.is_dir(), 'Unexpected download directory'
apk = folder / release['file']
latest = folder / 'latest.json'


def replace_with_stream(destination, stream, check=None):
    with tempfile.NamedTemporaryFile(dir=folder, prefix='.publish-', suffix='.part', delete=False) as tmp:
        temp = Path(tmp.name)
        try:
            shutil.copyfileobj(stream, tmp)
            tmp.flush()
            if check:
                check(temp)
            temp.chmod(0o644)
            temp.replace(destination)
        finally:
            temp.unlink(missing_ok=True)


def check_apk(path):
    with path.open('rb') as stream:
        checksum = hashlib.sha256()
        for chunk in iter(lambda: stream.read(65536), b''):
            checksum.update(chunk)
    assert path.stat().st_size == release['size'], 'APK size mismatch'
    assert checksum.hexdigest() == release['sha256'], 'APK SHA-256 mismatch'


with (folder / '.publish.lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    assert not latest.is_symlink() and not apk.is_symlink(), 'Unexpected symbolic link'
    current = json.loads(latest.read_text()) if latest.exists() else None
    if current:
        assert current['versionCode'] <= release['versionCode'], 'Refusing to downgrade the mirror'
        if current['versionCode'] == release['versionCode']:
            assert current == release, 'Release version already belongs to another APK'

    if operation == 'stage':
        if apk.exists():
            check_apk(apk)
            # Drain stdin even if a previous run already staged the same APK.
            with open('/dev/null', 'wb') as sink:
                shutil.copyfileobj(sys.stdin.buffer, sink)
        else:
            replace_with_stream(apk, sys.stdin.buffer, check_apk)
    elif operation == 'activate':
        from io import BytesIO
        check_apk(apk)
        replace_with_stream(latest, BytesIO((metadata + '\n').encode()))
    else:
        assert operation == 'clean' and current == release, 'Mirror changed before cleanup'
        old_package = re.compile(r'lecture-desk-android-(\d+)\.(\d+)\.(\d+)\.apk(?:\.sha256)?')
        old_temp = re.compile(r'\.publish-[a-z0-9_]+\.part')
        for entry in sorted(folder.iterdir()):
            if entry.name in {apk.name, latest.name, '.publish.lock'}:
                continue
            if entry.is_symlink() or not entry.is_file():
                print('Retained ' + entry.name)
                continue
            match = old_package.fullmatch(entry.name)
            older = match and tuple(map(int, match.groups())) < tuple(map(int, release['version'].split('.')))
            abandoned = old_temp.fullmatch(entry.name) and time.time() - entry.stat().st_mtime > 3600
            if older or abandoned:
                entry.unlink()
                print('Removed ' + entry.name)
            else:
                print('Retained ' + entry.name)
"""


def read_json(url):
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "LectureDesk-Release",
                                    "Cache-Control": "no-cache"})
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def check_public_apk(url, release):
    with urlopen(url, timeout=60) as stream:
        digest = hashlib.sha256()
        size = 0
        for chunk in iter(lambda: stream.read(65536), b""):
            size += len(chunk)
            if size > release["size"]:
                raise ValueError(f"Unexpected APK size at {url}")
            digest.update(chunk)
    if size != release["size"] or digest.hexdigest() != release["sha256"]:
        raise ValueError(f"Public APK mismatch at {url}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["stage", "publish"])
    parser.add_argument("apk", type=Path)
    parser.add_argument("--ssh", required=True, help="SSH alias or user@host for the mirror")
    parser.add_argument("--identity-file", type=Path)
    parser.add_argument("--known-hosts", type=Path)
    parser.add_argument("--gh", default="gh", help="Path to an authenticated GitHub CLI")
    args = parser.parse_args()

    match = re.fullmatch(r"lecture-desk-android-((0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]?)\.(0|[1-9][0-9]?))\.apk",
                         args.apk.name)
    if not match:
        parser.error("Expected lecture-desk-android-X.Y.Z.apk")
    version, major, minor, patch = match.groups()
    data = args.apk.read_bytes()
    if not 0 < len(data) <= 128 * 1024 * 1024:
        parser.error("APK size out of bounds")
    release = {"version": version, "versionCode": int(major) * 10000 + int(minor) * 100 + int(patch),
               "file": args.apk.name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}

    ssh = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=12"]
    if args.identity_file:
        ssh += ["-o", "IdentitiesOnly=yes", "-i", str(args.identity_file)]
    if args.known_hosts:
        ssh += ["-o", f"UserKnownHostsFile={args.known_hosts}"]
    ssh += ["--", args.ssh]

    def run_remote(operation, upload=None):
        command = shlex.join(["python3", "-I", "-c", REMOTE, operation, json.dumps(release)])
        subprocess.run([*ssh, command], input=upload if upload is not None else b"", check=True)

    apk_url = SERVER + release["file"]
    if args.operation == "stage":
        run_remote("stage", data)
        check_public_apk(apk_url, release)
        print("Verified mirror APK: " + apk_url)
        return

    github = json.loads(subprocess.check_output([args.gh, "api", "--hostname", "github.com", GITHUB]))
    tag = f"v{version}-android"
    published = next((asset for asset in github["assets"] if asset["name"] == release["file"]), {})
    if (github["tag_name"] != tag or github.get("draft") or github.get("prerelease")
            or published.get("size") != release["size"] or published.get("digest") != "sha256:" + release["sha256"]):
        raise ValueError(f"GitHub latest must be {tag} with the same APK before activation")

    check_public_apk(apk_url, release)
    run_remote("activate")
    if read_json(SERVER + "latest.json") != release:
        raise ValueError("Public mirror metadata did not match; cleanup skipped")
    run_remote("clean")
    print(f"Published v{version} on both sources. SHA-256 {release['sha256']}")


if __name__ == "__main__":
    main()
