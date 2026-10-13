#!/usr/bin/env python3
"""
P3g — crawl Oracle's "Subject Areas for Transactional Business Intelligence in <product>" guides
(docs.oracle.com, public HTML) into area -> duty -> job JSONL keyed on the role CODE NAME.
Standalone: no database, no pod, no credentials. Runs inside python:3.12-slim with requests +
beautifulsoup4 + lxml; the exact command and the output contract are in docs/tbi-guides-crawl.md.

Discovery (one path): the OTBI page "Oracle Fusion Cloud Applications Content" (FA_INDEX) carries one
"Subject areas" link per pillar (pls/topic/lookup?ctx=fa-latest&id=<BOOK>). A lookup must land on
.../<book>/index.html whose <meta dcterms.isVersionOf> is <BOOK>; anything else (a 404, or one of the
release landing hubs many slugs redirect to with HTTP 200) fails that guide loudly, never a guess.
`--guide-index BOOK=URL` gives the index of a guide whose Oracle link is broken (the operator's
explicit input; it replaces the lookup for that book). A versioned guide (.../<product>/<rel>/<book>/)
is checked against the product hub's latest release and moved there when the book is published in
it; an unversioned guide ("FA Latest") has no release segment and keeps its published label.

Each guide's toc.htm lists the chapters "Subject Areas", "Business Questions", "Job Roles", "Duty
Roles" (<li><span class="wrap">N Title</span><ul>...). Pages read (business questions are skipped,
the chapter "Overview" pages too):
  subject area  <section> "Job Roles" / "Duty Roles":  li > a.xref -> the role pages
  duty role     <section> "Code Name" (FBI_*_DUTY, ORA_*_DUTY*), "Job Roles", "Subject Areas"
  job role      <section> "Code Name" (ORA_*_JOB), "Duty Roles", "Subject Areas"
A role reference resolves through its link to the crawled page's Code Name (file names and page ids
differ per release, so nothing is keyed on them); an unlinked reference resolves by exact name among
the guide's role pages; anything else is listed under `unresolved` in guides.jsonl and makes no row.
A Code Name must read [A-Z][A-Z0-9_]*; Oracle typos (an inner space, a trailing ")") are repaired by
dropping inner whitespace and outer punctuation, and every repair is logged as an anomaly with the raw
text. Placeholder roles ("Not Applicable", "test") stay invalid and produce no row.

Output: <out>/<release>/, <release> = the highest versioned guide release crawled, lowercase (e.g.
26d; the "FA Latest" guides are the current documentation at that release):
  area_duty.jsonl  {subject_area, duty_code, duty_name, guide, guide_release, url}   from SA pages
  duty.jsonl       {duty_code, duty_name, job_codes[], subject_areas[], guide, guide_release, url}
  job.jsonl        {job_code, job_name, duty_codes[], subject_areas[], guide, guide_release, url}
  guides.jsonl     one line per guide: title, product, release, doc id, created, index URL, how it
                   was found, page counts, failed pages, unresolved references, SA<->DR cross-check
Rows are per guide (the same area or duty can appear in several guides); `guide` is the book id
(FAOFB, FAOHB, ...); names are the page text with whitespace collapsed (HTML rendering); files are
sorted, UTF-8, LF.

Politeness: one request at a time, >= MIN_INTERVAL apart, a User-Agent naming the project, retries
with exponential backoff on network errors / 429 / 5xx (Retry-After honoured). `--cache DIR` keeps
raw responses so a re-parse does not re-fetch (an empty dir = a fresh crawl).
Exit status 1 when any guide or page failed; the outputs are still written and guides.jsonl says
what is missing — load only a clean run.
"""
import argparse
import hashlib
import json
import os
import re
import string
import sys
import time
from urllib.parse import parse_qs, unquote, urldefrag, urljoin, urlparse

import requests
from bs4 import BeautifulSoup

FA_INDEX = "https://docs.oracle.com/en/cloud/saas/otbi/fa-index.html"
SAAS = "https://docs.oracle.com/en/cloud/saas/"
HOST = "docs.oracle.com"
UA = "oservices-fusion-schema-mcp/p3_tbi_guides (Oracle TBI subject-area guide crawler; <=1 req/s)"
MIN_INTERVAL = 1.1          # seconds between request starts (policy: <= 1 request/s)
RETRIES = 5
TIMEOUT = (15, 60)
CHAPTERS = {"Subject Areas": "sa", "Job Roles": "jr", "Duty Roles": "dr"}
GUIDE_PATH = re.compile(r"^/en/cloud/saas/(?P<product>[^/]+)/(?:(?P<rel>\d{2}[a-d])/)?(?P<book>[a-z0-9]+)/index\.html$")
HUB_PATH = re.compile(r"^/en/cloud/saas/(?P<product>[^/]+)/(?P<rel>\d{2}[a-d])/index\.html$")
CODE = re.compile(r"^[A-Z][A-Z0-9_]*[A-Z0-9]$")
PUNCT = string.punctuation.replace("_", "")   # stripped from the ends of a Code Name (Oracle typos)
EXAMPLES = 10               # examples kept per cross-check list in guides.jsonl


def norm(s):
    return re.sub(r"\s+", " ", s or "").strip()


def bare(url):
    return urldefrag(url)[0] if url else url


def same(a, b):
    return unquote(bare(a) or "") == unquote(bare(b) or "")


def meta(soup, name):
    m = soup.find("meta", attrs={"name": name})
    return m.get("content") if m else None


def rel_key(rel):
    return (int(rel[:2]), rel[2].lower())


class Fetcher:
    """Serial GET with a rate gate, retries and an optional raw-response cache."""

    def __init__(self, cache_dir):
        self.session = requests.Session()
        self.session.headers["User-Agent"] = UA
        self.cache = cache_dir
        self.last = 0.0
        self.sent = 0
        self.hits = 0
        if cache_dir:
            os.makedirs(cache_dir, exist_ok=True)

    def get(self, url):
        """-> (status, final_url, text); status None = gave up after RETRIES (text = the error)."""
        key = os.path.join(self.cache, hashlib.sha256(url.encode()).hexdigest() + ".json") if self.cache else None
        if key and os.path.exists(key):
            with open(key, encoding="utf-8") as f:
                c = json.load(f)
            self.hits += 1
            return c["status"], c["final_url"], c["text"]
        err = None
        for attempt in range(RETRIES):
            wait = MIN_INTERVAL - (time.monotonic() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.monotonic()
            self.sent += 1
            try:
                r = self.session.get(url, timeout=TIMEOUT, allow_redirects=True)
            except requests.RequestException as e:
                err = f"{type(e).__name__}: {e}"
                time.sleep(2 ** (attempt + 1))
                continue
            if r.status_code == 429 or r.status_code >= 500:
                err = f"HTTP {r.status_code}"
                ra = r.headers.get("Retry-After", "")
                time.sleep(min(int(ra), 120) if ra.isdigit() else 2 ** (attempt + 1))
                continue
            text = r.content.decode("utf-8", errors="replace")    # every page declares UTF-8
            if key:
                with open(key + ".tmp", "w", encoding="utf-8") as f:
                    json.dump({"url": url, "status": r.status_code, "final_url": r.url, "text": text}, f)
                os.replace(key + ".tmp", key)
            return r.status_code, r.url, text
        return None, url, err


def discover(fx):
    """The pillars' 'Subject areas' links on the OTBI Fusion content page -> [{pillar, book, seed, via}]."""
    status, final, text = fx.get(FA_INDEX)
    if status != 200 or not same(final, FA_INDEX):
        sys.exit(f"[tbi] OTBI content page unavailable: {FA_INDEX} -> {status} {final}")
    soup = BeautifulSoup(text, "lxml")
    found, seen = [], set()
    for h in soup.find_all("h3"):
        links = []
        for el in h.find_all_next():
            if el.name == "h3":
                break
            if el.name == "a" and el.get("href") and norm(el.get_text(" ")).lower() == "subject areas":
                links.append(el["href"])
        if not links:
            continue
        if len(links) > 1:
            sys.exit(f"[tbi] {FA_INDEX}: section {norm(h.get_text(' '))!r} has {len(links)} 'Subject areas' links")
        book = (parse_qs(urlparse(links[0]).query).get("id") or [""])[0].upper()
        if book and book not in seen:
            seen.add(book)
            found.append({"pillar": norm(h.get_text(" ")), "book": book, "seed": urljoin(FA_INDEX, links[0]),
                          "via": "otbi-fa-index"})
    if not found:
        sys.exit(f"[tbi] no 'Subject areas' links on {FA_INDEX} (page layout changed?)")
    return found


def open_index(fx, url, book):
    """-> (index_url, soup) for a valid <book>/index.html, else (None, reason)."""
    status, final, text = fx.get(url)
    final = bare(final)
    if status != 200:
        return None, f"{url} -> HTTP {status}{' ' + text if status is None else ''}"
    p = urlparse(final)
    m = GUIDE_PATH.match(p.path)
    if p.netloc != HOST or not m or m["book"] != book.lower():
        return None, f"{url} -> landed on {final} (not the {book} index)"
    soup = BeautifulSoup(text, "lxml")
    ver = (meta(soup, "dcterms.isVersionOf") or "").upper()
    if ver != book:
        return None, f"{final}: dcterms.isVersionOf={ver!r}, expected {book}"
    return final, soup


def newest(fx, idx, soup, book):
    """A versioned guide moves to the product hub's latest release when the book is published there."""
    m = GUIDE_PATH.match(urlparse(idx).path)
    if not m["rel"]:
        return idx, soup, {"hub_release": None, "note": "unversioned guide"}
    hub = f"{SAAS}{m['product']}/"
    status, final, _ = fx.get(hub)
    h = HUB_PATH.match(urlparse(bare(final)).path) if status == 200 else None
    if not h or h["product"] != m["product"]:
        return idx, soup, {"hub_release": None, "note": f"hub {hub} -> {status} {final}"}
    info = {"hub_release": h["rel"].upper()}
    if rel_key(h["rel"]) > rel_key(m["rel"]):
        u, s2 = open_index(fx, f"{SAAS}{m['product']}/{h['rel']}/{m['book']}/index.html", book)
        if u:
            return u, s2, {**info, "moved_from": m["rel"].upper()}
        info["note"] = f"book not published in {h['rel'].upper()}: {s2}"
    return idx, soup, info


def read_toc(fx, base, book):
    """toc.htm -> ({'sa'|'jr'|'dr': [(toc_text, page_url)]}, None) or (None, reason)."""
    url = base + "toc.htm"
    status, final, text = fx.get(url)
    if status != 200 or not same(final, url):
        return None, f"toc {url} -> {status} {final}"
    soup = BeautifulSoup(text, "lxml")
    if (meta(soup, "dcterms.isVersionOf") or "").upper() != book:
        return None, f"toc {url}: dcterms.isVersionOf={meta(soup, 'dcterms.isVersionOf')!r}"
    chapters = {}
    for sp in soup.select("li > span.wrap"):
        kind = CHAPTERS.get(re.sub(r"^\d+\s+", "", norm(sp.get_text(" "))))
        ul = sp.find_next_sibling("ul")
        if not kind or ul is None:
            continue
        rows = chapters.setdefault(kind, [])
        for a in ul.find_all("a", href=True):
            page = bare(urljoin(url, a["href"]))
            if "-CHAP-" not in page:                      # the chapter's Overview page
                rows.append((norm(a.get_text(" ")), page))
    empty = [t for t, k in CHAPTERS.items() if not chapters.get(k)]
    if empty:
        return None, f"toc {url}: chapters missing or empty: {empty}"
    return chapters, None


def read_page(text):
    """-> (title, isVersionOf, {section title: {'items': [(text, href|None)], 'paras': [text]}})."""
    soup = BeautifulSoup(text, "lxml")
    h1 = soup.find("h1")
    title = norm(h1.get_text(" ")) if h1 else ""
    secs = {}
    for sec in soup.select("section.section"):
        h = sec.find(["h2", "h3"])
        if h is None:
            continue
        s = secs.setdefault(norm(h.get_text(" ")), {"items": [], "paras": []})
        for li in sec.find_all("li"):
            a = li.find("a", href=True)
            s["items"].append((norm(li.get_text(" ")), a["href"] if a else None))
        s["paras"] += [t for t in (norm(p.get_text(" ")) for p in sec.find_all("p") if not p.find_parent("li")) if t]
    return title, (meta(soup, "dcterms.isVersionOf") or "").upper(), secs


def crawl_guide(fx, g):
    """Discovery + toc + every SA/DR/JR page of one guide -> the guide record (parsed pages in _pages)."""
    book = g["book"]
    rec = {"guide": book, "pillar": g["pillar"], "discovered_via": g["via"], "seed": g["seed"], "status": "ok",
           "failed": [], "anomalies": [], "unresolved": []}
    idx, soup = open_index(fx, g["seed"], book)
    if not idx:
        return {**rec, "status": "failed", "reason": soup}
    idx, soup, hub = newest(fx, idx, soup, book)
    m = GUIDE_PATH.match(urlparse(idx).path)
    label = m["rel"].upper() if m["rel"] else meta(soup, "dcterms.release")
    if not label:
        return {**rec, "status": "failed", "reason": f"{idx}: no release label (no release segment, no dcterms.release)"}
    if m["rel"] and (meta(soup, "dcterms.release") or "").upper() != label:
        rec["anomalies"].append({"url": idx, "issue": "dcterms.release differs from the path release",
                                 "dcterms.release": meta(soup, "dcterms.release")})
    rec.update({"title": meta(soup, "dcterms.title"), "product": m["product"], "guide_release": label,
                "versioned": bool(m["rel"]), "doc_id": meta(soup, "dcterms.identifier"),
                "created": meta(soup, "dcterms.created"), "index_url": idx, **hub})
    chapters, err = read_toc(fx, idx.rsplit("/", 1)[0] + "/", book)
    if err:
        return {**rec, "status": "failed", "reason": err}
    toc = {}
    for kind in ("dr", "jr", "sa"):
        for text, url in chapters[kind]:
            toc.setdefault(url, (kind, text))
    rec["toc_pages"] = {k: sum(1 for v in toc.values() if v[0] == k) for k in ("sa", "dr", "jr")}
    pages = {}
    for i, (url, (kind, ttext)) in enumerate(toc.items(), 1):
        status, final, text = fx.get(url)
        if status != 200 or not same(final, url):
            rec["failed"].append({"url": url, "kind": kind, "status": status, "final": bare(final)})
            continue
        title, ver, secs = read_page(text)
        if ver != book:
            rec["failed"].append({"url": url, "kind": kind, "status": status, "reason": f"isVersionOf={ver!r}"})
            continue
        if not title:
            title = ttext
            rec["anomalies"].append({"url": url, "issue": "no h1, toc text used"})
        elif title != ttext:
            rec["anomalies"].append({"url": url, "issue": "h1 differs from toc text", "h1": title, "toc": ttext})
        pages[url] = {"kind": kind, "title": title, "secs": secs}
        if i % 100 == 0:
            print(f"[tbi] {book}: {i}/{len(toc)} pages (sent {fx.sent}, cache {fx.hits})", flush=True)
    rec["pages_fetched"] = len(pages)
    rec["_pages"] = pages
    return rec


def build(guides):
    """Parsed pages of every crawled guide -> (area_duty, duty, job) rows; fills each guide's cross-check."""
    code_by_url, title_by_url, sa_by_url = {}, {}, {}
    for g in guides:
        for url, p in g.get("_pages", {}).items():
            title_by_url[url] = p["title"]
            if p["kind"] == "sa":
                sa_by_url[url] = p["title"]
                continue
            cn = (p["secs"].get("Code Name") or {}).get("paras") or []
            raw = cn[0] if cn else ""
            code = re.sub(r"\s+", "", raw).strip(PUNCT)
            if CODE.match(code):
                code_by_url[url] = code
                if code != raw:
                    g["anomalies"].append({"url": url, "issue": "code repaired", "raw": raw, "code": code})
            else:
                g["anomalies"].append({"url": url, "issue": "no valid Code Name", "code_section": cn[:2]})
    area_duty, duty, job = {}, {}, {}
    for g in guides:
        pages = g.get("_pages")
        if not pages:
            continue
        book, rel = g["guide"], g["guide_release"]
        by_name = {}
        for url, p in pages.items():
            if url in code_by_url:
                by_name.setdefault(p["title"], {})[code_by_url[url]] = url

        def role(text, href, page_url, want):
            """-> (code, role page url), or None (recorded under unresolved)."""
            tgt = bare(urljoin(page_url, href)) if href else None
            if tgt in code_by_url:
                return code_by_url[tgt], tgt
            cands = by_name.get(text, {})
            if len(cands) == 1:
                return next(iter(cands.items()))
            g["unresolved"].append({"page": page_url, "want": want, "text": text, "href": tgt,
                                    "candidates": sorted(cands)})
            return None

        sa_edges, dr_edges, unlinked_areas = set(), set(), 0
        for url, p in sorted(pages.items()):
            secs = p["secs"]
            if p["kind"] == "sa":
                if "Duty Roles" not in secs and "Job Roles" not in secs:
                    g["anomalies"].append({"url": url, "issue": "subject area page without role sections"})
                for text, href in (secs.get("Duty Roles") or {}).get("items", []):
                    hit = role(text, href, url, "duty")
                    if hit:
                        sa_edges.add((p["title"], hit[0]))
                        area_duty.setdefault((book, p["title"], hit[0]), {
                            "subject_area": p["title"], "duty_code": hit[0], "duty_name": title_by_url[hit[1]],
                            "guide": book, "guide_release": rel, "url": url})
                continue
            code = code_by_url.get(url)
            if not code:
                continue
            is_duty = p["kind"] == "dr"
            hits = [role(t, h, url, "job" if is_duty else "duty")
                    for t, h in (secs.get("Job Roles" if is_duty else "Duty Roles") or {}).get("items", [])]
            codes = sorted({hit[0] for hit in hits if hit})
            areas = set()
            for t, h in (secs.get("Subject Areas") or {}).get("items", []):
                tgt = bare(urljoin(url, h)) if h else None
                if tgt in sa_by_url:
                    areas.add(sa_by_url[tgt])
                else:
                    areas.add(t)                          # the listed name itself (no SA page behind it)
                    unlinked_areas += 1
            store, k_code, k_name, k_list = ((duty, "duty_code", "duty_name", "job_codes") if is_duty
                                             else (job, "job_code", "job_name", "duty_codes"))
            row = store.get((book, code))
            if row:
                g["anomalies"].append({"url": url, "issue": f"duplicate code {code} in guide", "first": row["url"]})
                row[k_list] = sorted(set(row[k_list]) | set(codes))
                row["subject_areas"] = sorted(set(row["subject_areas"]) | areas)
            else:
                store[(book, code)] = {k_code: code, k_name: p["title"], k_list: codes,
                                       "subject_areas": sorted(areas), "guide": book, "guide_release": rel,
                                       "url": url}
            if is_duty:
                dr_edges |= {(a, code) for a in areas}
        a_only, d_only = sorted(sa_edges - dr_edges), sorted(dr_edges - sa_edges)
        g["cross_check"] = {"area_duty_edges": len(sa_edges), "duty_area_edges": len(dr_edges),
                            "only_on_area_page": len(a_only), "only_on_duty_page": len(d_only),
                            "role_page_area_refs_without_sa_page": unlinked_areas,
                            "examples_only_on_area_page": [list(e) for e in a_only[:EXAMPLES]],
                            "examples_only_on_duty_page": [list(e) for e in d_only[:EXAMPLES]]}

    def rows(d):
        return [d[k] for k in sorted(d)]

    return rows(area_duty), rows(duty), rows(job)


def write_jsonl(path, rows):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def main():
    ap = argparse.ArgumentParser(description="Crawl Oracle's TBI subject-area guides into area/duty/job JSONL.")
    ap.add_argument("--out", required=True, help="output root; files land in <out>/<release>/")
    ap.add_argument("--guide-index", action="append", default=[], metavar="BOOK=URL",
                    help="index URL of a guide whose Oracle lookup link is broken (repeatable)")
    ap.add_argument("--only", help="comma list of book ids to crawl (every guide on the OTBI page when omitted)")
    ap.add_argument("--cache", help="raw-response cache dir (re-parse without re-fetching; empty dir = fresh crawl)")
    args = ap.parse_args()

    overrides = {}
    for spec in args.guide_index:
        book, sep, url = spec.partition("=")
        if not sep or not book.strip() or not url.strip().startswith("https://"):
            sys.exit(f"[tbi] --guide-index wants BOOK=https://...; got {spec!r}")
        overrides[book.strip().upper()] = url.strip()

    fx = Fetcher(args.cache)
    guides = discover(fx)
    for g in guides:
        if g["book"] in overrides:
            g.update({"seed": overrides.pop(g["book"]), "via": "operator --guide-index"})
    guides += [{"pillar": None, "book": b, "seed": u, "via": "operator --guide-index"} for b, u in overrides.items()]
    if args.only:
        want = {b.strip().upper() for b in args.only.split(",") if b.strip()}
        unknown = want - {g["book"] for g in guides}
        if unknown:
            sys.exit(f"[tbi] --only names books that were not discovered: {sorted(unknown)}")
        guides = [g for g in guides if g["book"] in want]
    print(f"[tbi] guides: {', '.join(g['book'] for g in guides)}", flush=True)

    recs = []
    for g in guides:
        rec = crawl_guide(fx, g)
        print(f"[tbi] {rec['guide']}: {rec['status']} {rec.get('guide_release', '')} "
              f"{rec.get('pages_fetched', 0)} pages, {len(rec['failed'])} failed {rec.get('reason', '')}", flush=True)
        recs.append(rec)

    versioned = [r["guide_release"].lower() for r in recs if r["status"] == "ok" and r.get("versioned")]
    if not versioned:
        sys.exit("[tbi] no versioned guide crawled: cannot name the release directory")
    release = max(versioned, key=rel_key)
    area_duty, duty, job = build(recs)

    outdir = os.path.join(args.out, release)
    os.makedirs(outdir, exist_ok=True)
    write_jsonl(os.path.join(outdir, "area_duty.jsonl"), area_duty)
    write_jsonl(os.path.join(outdir, "duty.jsonl"), duty)
    write_jsonl(os.path.join(outdir, "job.jsonl"), job)
    for r in recs:
        r.pop("_pages", None)
        r["n_unresolved"] = len(r["unresolved"])
        r["n_anomalies"] = len(r["anomalies"])
    write_jsonl(os.path.join(outdir, "guides.jsonl"), recs)

    bad_guides = [r["guide"] for r in recs if r["status"] != "ok"]
    bad_pages = sum(len(r["failed"]) for r in recs)
    print(f"[tbi] release dir {release}: area_duty {len(area_duty)}, duty {len(duty)}, job {len(job)}; "
          f"requests sent {fx.sent}, cache hits {fx.hits}; failed guides {bad_guides or 'none'}, "
          f"failed pages {bad_pages}, unresolved refs {sum(len(r['unresolved']) for r in recs)}", flush=True)
    if bad_guides or bad_pages:
        sys.exit(1)


if __name__ == "__main__":
    main()
