#!/usr/bin/env python3
"""
dump_full_local.py — download a COMPLETE Niconico (or any) HLS stream and rewrite
it to a fully-local, offline-playable tree.

Fetches the master, every variant + audio-rendition media playlist, and ALL their
segments + init sections + AES keys, then rewrites every URL (master variant
URIs, EXT-X-MEDIA, EXT-X-MAP, EXT-X-KEY, segment lines) to local *relative*
filenames. Result: a directory where

    cd <outdir> && ffmpeg -allowed_extensions ALL -i master.m3u8 -c copy out.mp4

reproduces the exact bytes the player gets — no CDN, no signed-URL expiry.

Usage
-----
  python3 dump_full_local.py \
      --page-url 'https://www.nicovideo.jp/watch/so46361162' \
      --cookies-from-browser firefox \
      --outdir ./nico_full

  python3 dump_full_local.py \
      --url 'https://delivery.domand.nicovideo.jp/.../master.m3u8?...' \
      --header 'Origin: https://www.nicovideo.jp' \
      --header 'Referer: https://www.nicovideo.jp/' \
      --header 'Cookie: domand_bid=...' \
      --outdir ./nico_full
"""
import argparse, os, re, sys, urllib.parse, urllib.request, http.cookiejar

OPENER = None          # urllib opener (carries the cookie jar)
HEADERS = {}           # default headers applied to every request

# ─── http ────────────────────────────────────────────────────────────────────
def http_get(url, extra=None):
    h = dict(HEADERS)
    if extra:
        h.update(extra)
    req = urllib.request.Request(url, headers=h)
    opener = OPENER or urllib.request.build_opener()
    with opener.open(req, timeout=60) as r:
        return r.read()

def collect_headers(args, page_url):
    h = {}
    for line in args.header:
        if ":" in line:
            k, v = line.split(":", 1); h[k.strip()] = v.strip()
    if args.headers_file:
        for line in open(args.headers_file):
            if ":" in line:
                k, v = line.split(":", 1); h[k.strip()] = v.strip()
    h.setdefault("User-Agent", args.user_agent or
                 "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                 "(KHTML, like Gecko) Chrome/124 Safari/537.36")
    # delivery.domand validates Origin/Referer on every request — default them
    # from the page origin (https://www.nicovideo.jp) unless overridden.
    if page_url:
        p = urllib.parse.urlparse(page_url)
        origin = f"{p.scheme}://{p.netloc}"
        h.setdefault("Origin", origin)
        h.setdefault("Referer", origin + "/")
    return h

# ─── yt-dlp resolution ────────────────────────────────────────────────────────
def resolve_with_ytdlp(page_url, cookies_from_browser):
    """Return (master_url, cookiejar, fmt_headers)."""
    try:
        import yt_dlp
    except ImportError:
        sys.exit("yt-dlp not installed. `pip install yt-dlp` or use --url directly.")
    opts = {"quiet": True, "skip_download": True}
    if cookies_from_browser:
        opts["cookiesfrombrowser"] = (cookies_from_browser, None, None, None)
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(page_url, download=False)
        jar = ydl.cookiejar          # CookieJar populated from the browser
    master, fmt_headers = None, {}
    for f in info.get("formats", []):
        mu = f.get("manifest_url")
        if mu and ".m3u8" in mu:
            master = mu
            fmt_headers = f.get("http_headers") or {}
            break
    if not master:
        sys.exit("Could not find an HLS master via yt-dlp; pass --url instead.")
    return master, jar, fmt_headers

# ─── m3u8 helpers ─────────────────────────────────────────────────────────────
def safe_name(uri, fallback):
    name = urllib.parse.urlparse(uri).path.rsplit("/", 1)[-1] or fallback
    return "".join(c if (c.isalnum() or c in "._-") else "_" for c in name)

def parse_master(text):
    out, lines = [], text.splitlines()
    for i, line in enumerate(lines):
        s = line.strip()
        if s.startswith("#EXT-X-MEDIA:"):
            m = re.search(r'URI="([^"]+)"', s)
            if m: out.append(("media", m.group(1)))
        elif s.startswith("#EXT-X-STREAM-INF:"):
            for j in range(i + 1, len(lines)):
                n = lines[j].strip()
                if n and not n.startswith("#"):
                    out.append(("variant", n)); break
    return out

# ─── per-variant download + rewrite ──────────────────────────────────────────
def process_variant(variant_uri, master_url, outdir, used):
    abs_uri = urllib.parse.urljoin(master_url, variant_uri)
    pl_name = safe_name(variant_uri, "variant.m3u8")
    if not pl_name.endswith(".m3u8"):
        pl_name += ".m3u8"
    if pl_name in used:
        return pl_name
    used.add(pl_name)
    base = pl_name[:-5]

    text = http_get(abs_uri).decode("utf-8", "replace")
    out_lines, seg_no = [], 0
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("#EXT-X-MAP:"):
            m = re.search(r'URI="([^"]+)"', s)
            if m:
                ext = os.path.splitext(safe_name(m.group(1), "init"))[1] or ".mp4"
                local = f"{base}__init{ext}"
                open(os.path.join(outdir, local), "wb").write(
                    http_get(urllib.parse.urljoin(abs_uri, m.group(1))))
                out_lines.append(re.sub(r'URI="[^"]+"', f'URI="{local}"', s))
                print(f"    init  -> {local}")
            else: out_lines.append(line)
        elif s.startswith("#EXT-X-KEY:") and "METHOD=NONE" not in s:
            m = re.search(r'URI="([^"]+)"', s)
            if m:
                local = f"{base}.key"
                open(os.path.join(outdir, local), "wb").write(
                    http_get(urllib.parse.urljoin(abs_uri, m.group(1))))
                out_lines.append(re.sub(r'URI="[^"]+"', f'URI="{local}"', s))  # keep IV=
                print(f"    key   -> {local}")
            else: out_lines.append(line)
        elif s and not s.startswith("#"):
            seg_no += 1
            ext = os.path.splitext(safe_name(s, "seg"))[1] or ".bin"
            local = f"{base}__{seg_no:05d}{ext}"
            open(os.path.join(outdir, local), "wb").write(
                http_get(urllib.parse.urljoin(abs_uri, s)))
            out_lines.append(local)
            if seg_no % 25 == 0:
                print(f"    seg   -> {seg_no} so far")
        else:
            out_lines.append(line)
    open(os.path.join(outdir, pl_name), "w").write("\n".join(out_lines) + "\n")
    print(f"  [{base}] {seg_no} segments -> {pl_name}")
    return pl_name

def rewrite_master(master_text, outdir, name_map):
    out = []
    for line in master_text.splitlines():
        s = line.strip()
        if s.startswith("#EXT-X-MEDIA:"):
            m = re.search(r'URI="([^"]+)"', s)
            if m and m.group(1) in name_map:
                out.append(re.sub(r'URI="[^"]+"', f'URI="{name_map[m.group(1)]}"', s))
            else: out.append(line)
        elif s and not s.startswith("#") and s in name_map:
            out.append(name_map[s])
        else:
            out.append(line)
    open(os.path.join(outdir, "master.m3u8"), "w").write("\n".join(out) + "\n")

# ─── main ─────────────────────────────────────────────────────────────────────
def main():
    global OPENER, HEADERS
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--page-url"); g.add_argument("--url")
    ap.add_argument("--header", action="append", default=[])
    ap.add_argument("--headers-file"); ap.add_argument("--cookies-from-browser")
    ap.add_argument("--user-agent"); ap.add_argument("--outdir", default="./nico_full")
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)

    jar = http.cookiejar.CookieJar()
    if args.page_url:
        master_url, jar, fmt_headers = resolve_with_ytdlp(args.page_url, args.cookies_from_browser)
    else:
        master_url, fmt_headers = args.url, {}

    HEADERS = collect_headers(args, args.page_url)
    for k, v in fmt_headers.items():        # yt-dlp's per-format headers (Referer, UA…)
        HEADERS.setdefault(k, v)
    OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    print(f"master: {master_url[:90]}...")
    print(f"cookies in jar: {len(jar)}  headers: {sorted(HEADERS)}")
    master_text = http_get(master_url).decode("utf-8", "replace")
    open(os.path.join(args.outdir, "master.original.m3u8"), "w").write(master_text)

    declared = parse_master(master_text)
    print(f"declared renditions: {len(declared)}")
    name_map, used = {}, set()
    for kind, uri in declared:
        print(f"  [{kind}] {uri.split('?')[0][-48:]}")
        name_map[uri] = process_variant(uri, master_url, args.outdir, used)

    rewrite_master(master_text, args.outdir, name_map)
    print(f"\nDone -> {args.outdir}/master.m3u8")
    print(f"  cd {args.outdir} && ffmpeg -v verbose -allowed_extensions ALL -i master.m3u8 -c copy out.mp4")

if __name__ == "__main__":
    main()
