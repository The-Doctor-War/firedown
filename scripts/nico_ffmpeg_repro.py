#!/usr/bin/env python3
"""
nico_ffmpeg_repro.py — reproduce the Niconico domand "hangs probing all
segments" bug against a *stock* ffmpeg, the way downloader.c / metadatareader.c
would, WITHOUT ever pre-fetching the AES key.

Why this design
---------------
The domand key is single-use per session: the FIRST fetch of a signed key URL
returns the real key, every later fetch returns a garbage decoy. So ANY tool
that GETs the key before the real consumer poisons the run. This script never
touches the key — it only hands the master playlist to ffmpeg and lets ffmpeg
do every fetch. ffmpeg propagates the -headers we set on the master to its
sub-requests (media playlist, segments, AND the AES key — hls.c copies
avio_opts), so the Cookie/Origin/Referer reach the key fetch exactly like the
OkHttp bridge does on device.

There are TWO independent reasons stock ffmpeg walks every segment to EOF
during avformat_open_input / find_stream_info; this script helps tell them
apart:

  (A) SEEKABILITY (transport): firedown's replacement libavformat/http.c sets
      h->is_streamed = (total <= 0). Stock ffmpeg does not, so a
      seekable-but-unknown-size fMP4 segment stream defeats the mov demuxer's
      read_header early-out and mov walks every moof/mdat to EOF *during the
      open itself*. This happens even with a perfectly good key.

  (B) SINGLE-USE KEY (our 0004 hls.c cache): the SECOND open of a session
      (downloader after metadatareader) fetches a decoy key -> every segment
      decrypts to garbage -> mov skips a phantom giant box to EOF during
      find_stream_info.

A single fresh run here is the FIRST consumer of the session, so its key fetch
should be the real one — meaning a walk on run #1 points at (A) seekability.
Running again (or letting the device download afterwards) burns a decoy and
demonstrates (B). Use --runs 2 to show both, but note it consumes the session;
mint a fresh resolved.json for each clean test.

Usage
-----
  python3 nico_ffmpeg_repro.py --resolved resolved.json
  python3 nico_ffmpeg_repro.py --resolved resolved.json --mode download --runs 2
  python3 nico_ffmpeg_repro.py --url '<master.m3u8>' --cookie 'a=b; c=d'

Requires only stock `ffmpeg`/`ffprobe` on PATH (the "fresh ffmpeg 8.1.1" case).
"""

import argparse
import json
import re
import subprocess
import sys
import time

KEY_RE = re.compile(r"/keys/|\.key(\?|$)")
SEG_RE = re.compile(r"\.cmfa|\.m4s|\.ts(\?|$)|/segments/")
OPEN_RE = re.compile(r"Opening '([^']+)' for reading")


def find_first(obj, pred):
    """Depth-first search for the first value satisfying pred(value)."""
    stack = [obj]
    while stack:
        cur = stack.pop()
        if pred(cur):
            return cur
        if isinstance(cur, dict):
            stack.extend(cur.values())
        elif isinstance(cur, list):
            stack.extend(cur)
    return None


def collect_headers(obj):
    """Pull request headers out of whatever shape resolved.json uses."""
    headers = {}

    # requestHeaders: [{name, value}, ...]  (the parser's sendNative shape)
    def is_header_list(v):
        return (isinstance(v, list) and v and isinstance(v[0], dict)
                and "name" in v[0] and "value" in v[0])

    hl = find_first(obj, is_header_list)
    if hl:
        for h in hl:
            headers[str(h["name"])] = str(h["value"])

    # headers: {name: value}
    hd = find_first(obj, lambda v: isinstance(v, dict)
                    and any(k.lower() == "cookie" for k in v.keys()))
    if hd and not headers:
        headers.update({str(k): str(v) for k, v in hd.items()})

    # cookies: [{name, value}, ...]  -> build a Cookie header
    def is_cookie_list(v):
        return (isinstance(v, list) and v and isinstance(v[0], dict)
                and "name" in v[0] and "value" in v[0]
                and any(c.get("name", "").startswith(("nicosid", "domand_bid"))
                        for c in v))

    if not any(k.lower() == "cookie" for k in headers):
        cl = find_first(obj, is_cookie_list)
        if cl:
            headers["Cookie"] = "; ".join(f'{c["name"]}={c["value"]}' for c in cl)

    return headers


def load_resolved(path):
    with open(path) as f:
        data = json.load(f)
    url = find_first(
        data,
        lambda v: isinstance(v, str) and ".m3u8" in v and "http" in v)
    headers = collect_headers(data)
    return url, headers, data


def build_headers_blob(headers):
    """ffmpeg -headers wants CRLF-terminated 'Key: Value' lines."""
    return "".join(f"{k}: {v}\r\n" for k, v in headers.items())


def run_once(args, headers, run_idx):
    blob = build_headers_blob(headers)
    common = [
        "-hide_banner", "-loglevel", "debug",
        "-rw_timeout", str(args.rw_timeout * 1_000_000),
        "-protocol_whitelist", "file,crypto,data,http,https,tcp,tls",
        "-allowed_extensions", "ALL",
    ]
    if blob:
        common += ["-headers", blob]

    if args.mode == "download":
        out = f"{args.out_prefix}.run{run_idx}.mp4"
        cmd = ["ffmpeg", *common, "-i", args.url, "-c", "copy", "-y", out]
    else:  # probe == avformat_open_input + find_stream_info, like metadatareader
        cmd = ["ffprobe", *common, "-show_streams", "-show_format", args.url]

    print(f"\n=== run #{run_idx} ({args.mode}) ===")
    print("CMD:", " ".join(
        (c if c != blob else "<headers>") for c in cmd))

    log_path = f"{args.out_prefix}.run{run_idx}.log"
    started = time.monotonic()
    timed_out = False
    with open(log_path, "w") as logf:
        try:
            proc = subprocess.run(cmd, stdout=logf, stderr=subprocess.STDOUT,
                                  timeout=args.timeout)
            rc = proc.returncode
        except subprocess.TimeoutExpired:
            timed_out = True
            rc = None
    elapsed = time.monotonic() - started

    # ---- analyze the verbose log ----
    key_fetches = seg_opens = 0
    found_streams = had_codec_fail = False
    with open(log_path, errors="replace") as f:
        for line in f:
            m = OPEN_RE.search(line)
            if m:
                u = m.group(1)
                if KEY_RE.search(u):
                    key_fetches += 1
                elif SEG_RE.search(u):
                    seg_opens += 1
            if "Could not find codec parameters" in line:
                had_codec_fail = True
            if "[STREAM]" in line or "codec_type=" in line:
                found_streams = True

    print(f"  elapsed={elapsed:.1f}s timed_out={timed_out} rc={rc}")
    print(f"  key fetches={key_fetches}  segment opens={seg_opens}")
    print(f"  found_streams={found_streams}  codec_param_failure={had_codec_fail}")
    print(f"  full log: {log_path}")

    walked = timed_out or seg_opens > args.walk_threshold
    if walked:
        cause = ("(A) seekability — real key but mov walks during open"
                 if run_idx == 1 else
                 "(B) single-use key decoy — OR still (A)")
        print(f"  VERDICT: WALK reproduced ({seg_opens} segment opens). "
              f"Likely cause {cause}.")
    else:
        print("  VERDICT: converged (no walk).")
    return walked


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--resolved", help="path to resolved.json")
    ap.add_argument("--url", help="master .m3u8 (overrides resolved.json)")
    ap.add_argument("--cookie", help="Cookie header value (overrides)")
    ap.add_argument("--origin", default="https://www.nicovideo.jp")
    ap.add_argument("--referer", default="https://www.nicovideo.jp/")
    ap.add_argument("--mode", choices=["probe", "download"], default="probe",
                    help="probe = ffprobe (find_stream_info); "
                         "download = ffmpeg -c copy")
    ap.add_argument("--runs", type=int, default=1,
                    help="repeat N times (>1 BURNS the single-use key)")
    ap.add_argument("--timeout", type=int, default=90,
                    help="per-run wall-clock timeout (s)")
    ap.add_argument("--rw_timeout", type=int, default=20,
                    help="ffmpeg per-IO timeout (s)")
    ap.add_argument("--walk-threshold", type=int, default=4,
                    help="segment opens above this == a walk")
    ap.add_argument("--out-prefix", default="nico_repro")
    args = ap.parse_args()

    headers = {}
    if args.resolved:
        url, headers, _ = load_resolved(args.resolved)
        if not args.url:
            args.url = url
        print(f"resolved.json: url={'<found>' if url else '<MISSING>'}, "
              f"headers={list(headers)}")
    if args.url is None:
        ap.error("no master URL (give --url or a resolved.json that has one)")

    if args.cookie:
        headers["Cookie"] = args.cookie
    headers.setdefault("Origin", args.origin)
    headers.setdefault("Referer", args.referer)
    if "Cookie" not in headers:
        print("WARNING: no Cookie header — domand will likely reject the key "
              "fetch and you'll get a decoy on the FIRST fetch (confound).",
              file=sys.stderr)

    if args.runs > 1:
        print("NOTE: --runs > 1 consumes the single-use key; run #2+ are "
              "expected to get a decoy. Mint a fresh resolved.json for a clean "
              "single-consumer test.\n")

    for i in range(1, args.runs + 1):
        run_once(args, headers, i)


if __name__ == "__main__":
    main()
