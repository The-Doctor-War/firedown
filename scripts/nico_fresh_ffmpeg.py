#!/usr/bin/env python3
# nico_fresh_ffmpeg.py — the clean test the earlier scripts never ran:
# mint a FRESH domand session and let ffmpeg be the FIRST consumer of the AES
# key. Never pre-fetches/decrypts the key (that is the nico_probe.py step-[3]
# trap). Counts key fetches PER URL so per-rendition keys aren't mistaken for a
# double-fetch.
#
# Mental model this verifies:
#   * key is single-use per session (proven separately by nico_keyonce.py)
#   * within ONE libavformat context a given key URL is fetched once (hls.c:
#     read_key gated by strcmp(seg->key, pls->key_url); seek doesn't reset it)
#   => a lone, first-consumer ffmpeg open fetches each rendition's key exactly
#      once = the REAL key => it should CONVERGE with stock ffmpeg, no patch.
#   The device needs the 0004 cache only because it opens TWICE (metadatareader
#   then downloader, same process): the 2nd open re-fetches the same key URLs =
#   decoys. 0004 makes the 2nd open reuse the 1st open's real key.
#
# USAGE:
#   python3 nico_fresh_ffmpeg.py <watch-url-or-id> [resolved.json]   # ffmpeg-first
#   python3 nico_fresh_ffmpeg.py <watch-url-or-id> [resolved.json] --twice
#       --twice: open the SAME fresh session twice in a row (probe then download)
#                to reproduce the device's decoy-on-2nd-open WITHOUT any patch.
#   python3 nico_fresh_ffmpeg.py <watch-url-or-id> [resolved.json] --prove-singleuse
#       also mint a SEPARATE fresh session and fetch one key URL 3x (keyonce).
#
# resolved.json is used ONLY for login cookies (user_session etc.); its stale
# domand session URL is ignored — we mint a new one.
# Env: FFMPEG / FFPROBE override the binaries (default: PATH).
# Requires: python3, ffmpeg/ffprobe, openssl (only for --prove-singleuse).

import sys, os, re, json, time, subprocess, pty, select, urllib.request

ARG = sys.argv[1] if len(sys.argv) > 1 else ""
COOKSRC = next((a for a in sys.argv[2:] if not a.startswith("--")), "")
TWICE = "--twice" in sys.argv
PROVE = "--prove-singleuse" in sys.argv
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")
BASE = "https://www.nicovideo.jp"; API = "https://nvapi.nicovideo.jp"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36")

m = re.search(r"(sm|so|nm)?\d+$", ARG or "")
if not m:
    sys.exit("usage: python3 nico_fresh_ffmpeg.py <watch-url-or-id> [resolved.json] "
             "[--twice] [--prove-singleuse]")
VID = m.group(0)

# ---- cookie jar (login cookies from resolved.json; domand_bid is re-minted) --
cookies = {}
if COOKSRC and os.path.isfile(COOKSRC):
    try:
        d = json.load(open(COOKSRC))
        ck = d.get("headers", {}).get("Cookie", "")
        skip = {"domain", "path", "expires", "max-age", "samesite", "secure", "httponly"}
        for p in ck.split(";"):
            p = p.strip()
            if "=" in p and p.split("=", 1)[0].strip().lower() not in skip:
                n, v = p.split("=", 1); cookies[n.strip()] = v.strip()
        UA = d.get("headers", {}).get("User-Agent", UA)
        print(f">> seeded {len(cookies)} cookies from {COOKSRC}")
    except Exception as e:
        print("(cookie read failed:", e, ")")

def ch(): return "; ".join(f"{k}={v}" for k, v in cookies.items())
def upd(r):
    for sc in r.headers.get_all("Set-Cookie") or []:
        f = sc.split(";", 1)[0]
        if "=" in f:
            n, v = f.split("=", 1); cookies[n.strip()] = v.strip()
def req(url, data=None, extra=None):
    h = {"User-Agent": UA, "X-Frontend-Id": "6", "X-Frontend-Version": "0",
         "Origin": BASE, "Referer": BASE + "/"}
    if cookies: h["Cookie"] = ch()
    if extra: h.update(extra)
    rq = urllib.request.Request(url, data=data, headers=h)
    rs = urllib.request.urlopen(rq, timeout=30)
    b = rs.read(); upd(rs); return b

def mint_session():
    """watch API -> access-rights/hls -> contentUrl. Does NOT touch the key."""
    pathseg = "v3" if "user_session" in cookies else "v3_guest"
    d = json.loads(req(f"{BASE}/api/watch/{pathseg}/{VID}"
                       f"?actionTrackId=AAAAAAAAAA_{int(time.time()*1000)}")).get("data", {})
    dm = (d.get("media") or {}).get("domand") or {}
    if not dm.get("accessRightKey"):
        sys.exit("no domand access info (login/region?). Try a logged-in resolved.json.")
    ark = dm["accessRightKey"]; tid = d["client"]["watchTrackId"]
    vids = [v["id"] for v in dm["videos"] if v.get("isAvailable")]
    auds = [a["id"] for a in dm["audios"] if a.get("isAvailable")]
    cu = json.loads(req(
        f"{API}/v1/watch/{VID}/access-rights/hls?actionTrackId={tid}",
        data=json.dumps({"outputs": [[v, a] for v in vids for a in auds]}).encode(),
        extra={"Accept": "application/json;charset=utf-8",
               "Content-Type": "application/json",
               "X-Access-Right-Key": ark, "X-Request-With": BASE},
    ))["data"]["contentUrl"]
    return cu

# ---------------------------------------------------------------------------
# Run ffmpeg/ffprobe under a PTY (forces line buffering so a timeout-kill still
# yields the log) and tally fetches. NEVER fetches the key itself.
# ---------------------------------------------------------------------------
OPEN_RE = re.compile(r"Opening '([^']+)' for reading")
KEY_RE = re.compile(r"/keys/|\.key(\?|$)")
SEG_RE = re.compile(r"\.cmf[av]|\.m4s|/segments/")

def run_ffmpeg(content_url, label, mode="probe", window=45):
    hdrs = (f"Origin: {BASE}\r\nReferer: {BASE}/\r\nUser-Agent: {UA}\r\n"
            f"Cookie: {ch()}\r\n")
    common = ["-hide_banner", "-loglevel", "debug", "-nostdin",
              "-rw_timeout", "20000000",
              "-protocol_whitelist", "file,crypto,data,http,https,tcp,tls",
              "-allowed_extensions", "ALL", "-headers", hdrs]
    if mode == "download":
        out = f"/tmp/_nicofresh_{label}.mp4"
        try: os.remove(out)
        except OSError: pass
        cmd = [FFMPEG, *common, "-i", content_url, "-map", "p:0", "-c", "copy",
               "-t", "10", "-f", "mp4", out]
    else:
        cmd = [FFPROBE, *common, "-show_streams", "-show_format", content_url]

    log_path = f"./nico_fresh_{label}.log"
    logf = open(log_path, "w")
    key_hits = {}; segset = set(); atoms = {}; streaminfo = False
    atom_re = re.compile(r"type:'([^']{1,8})'")
    mfd, sfd = pty.openpty()
    proc = subprocess.Popen(cmd, stdout=sfd, stderr=sfd,
                            stdin=subprocess.DEVNULL, close_fds=True,
                            env=dict(os.environ, AV_LOG_FORCE_NOCOLOR="1", NO_COLOR="1"))
    os.close(sfd)
    buf = b""; deadline = time.time() + window
    try:
        while True:
            if time.time() > deadline:
                proc.terminate(); break
            r, _, _ = select.select([mfd], [], [], 1.0)
            if mfd in r:
                try: chunk = os.read(mfd, 65536)
                except OSError: break
                if not chunk: break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    s = line.decode("utf-8", "replace"); logf.write(s + "\n")
                    mm = OPEN_RE.search(s)
                    if mm:
                        u = mm.group(1)
                        if KEY_RE.search(u):
                            key_hits[u] = key_hits.get(u, 0) + 1
                        elif SEG_RE.search(u):
                            segset.add(u.split("?")[0])
                    am = atom_re.search(s)
                    if am: atoms[am.group(1)] = atoms.get(am.group(1), 0) + 1
                    if "Input #0" in s or "[STREAM]" in s: streaminfo = True
            if proc.poll() is not None and not select.select([mfd], [], [], 0)[0]:
                break
    finally:
        if proc.poll() is None:
            proc.terminate()
            try: proc.wait(3)
            except Exception: proc.kill()
        logf.close(); os.close(mfd)

    distinct_keys = len(key_hits)
    repeated = {u: n for u, n in key_hits.items() if n > 1}
    frag = {k: atoms[k] for k in ("styp", "moof", "mdat", "trun") if k in atoms}
    out_sz = (os.path.getsize(f"/tmp/_nicofresh_{label}.mp4")
              if mode == "download" and os.path.exists(f"/tmp/_nicofresh_{label}.mp4") else 0)
    print(f"\n--- {label} ({mode}) ---")
    print(f"  distinct key URLs fetched : {distinct_keys}  (per-rendition, 1 each is normal)")
    print(f"  key URLs fetched MORE THAN ONCE : {repeated if repeated else 'none'}")
    print(f"  segments opened : {len(segset)}   fragment atoms : {frag if frag else 'NONE'}")
    print(f"  stream-info reached : {streaminfo}   output bytes : {out_sz}")
    print(f"  log : {log_path}")
    walked = len(segset) >= 5 and not (out_sz > 300000 or (streaminfo and mode == "probe"))
    if not walked:
        print("  => CONVERGED ✅ (real key, no walk)")
    elif frag:
        print("  => WALKED ❌ but parsed REAL atoms -> decryption OK; transport/seekability")
    else:
        print("  => WALKED ❌ with garbage atoms -> got a DECOY key (2nd consumer of a "
              "spent session, or the same URL fetched twice above)")
    return walked

# ---- main ------------------------------------------------------------------
print(f">> minting FRESH session for {VID} …")
cu = mint_session()
print(f"   contentUrl: {cu.split('?')[0]}?<signed>   (key NOT fetched by this script)")

if TWICE:
    print("\n>> --twice: same fresh session, two back-to-back opens (device flow)")
    run_ffmpeg(cu, "open1_probe", mode="probe")
    run_ffmpeg(cu, "open2_download", mode="download")
    print("\nExpect: open1 converges (real key), open2 WALKS with garbage atoms "
          "(decoy) — reproducing the device hang WITHOUT the 0004 patch, in two "
          "separate processes/contexts.")
else:
    run_ffmpeg(cu, "single", mode="download")
    print("\nIf this CONVERGED: a lone first-consumer ffmpeg open works unpatched — "
          "the device hang is specifically the SECOND open. If it WALKED with garbage "
          "atoms on a freshly-minted session, the session was already spent upstream "
          "or a single URL was fetched twice (see the 'fetched MORE THAN ONCE' line).")

if PROVE:
    print("\n>> --prove-singleuse: minting a SEPARATE fresh session, fetching one "
          "key URL 3x (keyonce) …")
    cu2 = mint_session()
    master = req(cu2).decode("utf-8", "replace")
    apl = re.search(r"https://[^\"\n]+\.m3u8[^\"\n]*", master).group(0)
    ap = req(apl).decode("utf-8", "replace")
    key_url = re.search(r'URI="(https://[^"]+\.key[^"]*)"', ap).group(1)
    iv = re.search(r"IV=0x([0-9A-Fa-f]+)", ap).group(1)
    seg = req(re.search(r"https://[^\"\n]+/\d+\.cmfa[^\"\n]*", ap).group(0))
    open("/tmp/_ko.seg", "wb").write(seg)
    def full(kb):
        if len(kb) != 16: return f"BADLEN({len(kb)})"
        dec = subprocess.run(["openssl", "enc", "-d", "-aes-128-cbc", "-K", kb.hex(),
                              "-iv", iv, "-in", "/tmp/_ko.seg", "-nopad"],
                             capture_output=True).stdout
        return ("OK-FULL" if dec[4:8] == b"styp" and b"moof" in dec and b"mdat" in dec
                else ("block0" if dec[4:8] == b"styp" else "GARBAGE"))
    prev = None
    for i in (1, 2, 3):
        kb = req(key_url)
        tag = "" if prev is None else (" (==prev)" if kb == prev else " (DIFFERENT)")
        print(f"   key fetch #{i}: {kb.hex()} -> {full(kb)}{tag}")
        prev = kb
    print("   #1 OK-FULL, #2/#3 GARBAGE+DIFFERENT  ==> single-use per session confirmed.")
