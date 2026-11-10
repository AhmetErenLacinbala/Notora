"""Extract the small navigation manifest from the original PDF.

Coordinates sent to the browser are CSS points from the displayed page's
top-left, after CropBox, clockwise Rotate, and UserUnit have been applied.
The original PDF remains untouched so page numbers retain their meaning.
"""

import json
import math
import sys
from urllib.parse import urlsplit

from pypdf import PdfReader


MAX_PAGES = 20_000
MAX_OUTLINE_ITEMS = 20_000
MAX_LINKS_PER_PAGE = 50_000


def finite(value):
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def geometry(page):
    box = page.cropbox
    left, bottom, right, top = map(finite, (box.left, box.bottom, box.right, box.top))
    unit = finite(page.get("/UserUnit", 1))
    rotation = int(page.rotation or 0) % 360
    if None in (left, bottom, right, top, unit) or unit <= 0 or rotation not in (0, 90, 180, 270):
        raise ValueError("Invalid page geometry")
    width, height = (right - left) * unit, (top - bottom) * unit
    if not (0 < width <= 1_000_000 and 0 < height <= 1_000_000):
        raise ValueError("Invalid page dimensions")
    return (left, bottom, right, top, unit, rotation)


def size(geom):
    left, bottom, right, top, unit, rotation = geom
    width, height = (right - left) * unit, (top - bottom) * unit
    return (height, width) if rotation in (90, 270) else (width, height)


def point(geom, x, y):
    left, bottom, right, top, unit, rotation = geom
    if rotation == 0:
        return ((x - left) * unit, (top - y) * unit)
    if rotation == 90:
        return ((y - bottom) * unit, (x - left) * unit)
    if rotation == 180:
        return ((right - x) * unit, (y - bottom) * unit)
    return ((top - y) * unit, (right - x) * unit)


def rectangle(geom, values):
    if not isinstance(values, (list, tuple)) or len(values) != 4:
        return None
    coords = [finite(value) for value in values]
    if any(value is None for value in coords):
        return None
    x1, y1, x2, y2 = coords
    corners = [point(geom, x, y) for x in (x1, x2) for y in (y1, y2)]
    width, height = size(geom)
    left = max(0, min(width, min(x for x, _ in corners)))
    right = max(0, min(width, max(x for x, _ in corners)))
    top = max(0, min(height, min(y for _, y in corners)))
    bottom = max(0, min(height, max(y for _, y in corners)))
    if right <= left or bottom <= top:
        return None
    return [left, top, right, bottom]


def safe_url(raw):
    url = str(raw)
    if len(url) > 4096 or any(ord(ch) < 32 or ord(ch) == 127 for ch in url):
        return None
    parsed = urlsplit(url)
    if parsed.scheme.lower() in ("http", "https") and parsed.netloc:
        return url
    if parsed.scheme.lower() == "mailto" and parsed.path:
        return url
    return None


def main(source, output):
    reader = PdfReader(source, strict=False)
    if reader.is_encrypted:
        raise ValueError("Encrypted PDFs are not supported")
    count = len(reader.pages)
    if not 0 < count <= MAX_PAGES:
        raise ValueError("PDF page count is outside supported range")

    geometries = [geometry(page) for page in reader.pages]
    pages = [
        {"number": index + 1, "width": size(geom)[0], "height": size(geom)[1]}
        for index, geom in enumerate(geometries)
    ]
    reference_pages = {}
    for index, page in enumerate(reader.pages):
        reference = page.indirect_reference
        if reference is not None:
            reference_pages[(reference.idnum, reference.generation)] = index

    def destination(raw):
        if raw is None:
            return None
        if isinstance(raw, (str, bytes)):
            raw = reader.named_destinations.get(str(raw)) or reader.named_destinations.get(str(raw).lstrip("/"))
            if raw is None:
                return None
        if hasattr(raw, "page"):
            try:
                index = reader.get_destination_page_number(raw)
            except Exception:
                return None
            x, y = finite(getattr(raw, "left", None)), finite(getattr(raw, "top", None))
        elif isinstance(raw, (list, tuple)) and raw:
            first = raw[0]
            if hasattr(first, "idnum"):
                index = reference_pages.get((first.idnum, first.generation), -1)
            elif isinstance(first, int):
                index = int(first)
            else:
                return None
            fit = str(raw[1]) if len(raw) > 1 else ""
            if fit == "/XYZ":
                x = finite(raw[2]) if len(raw) > 2 else None
                y = finite(raw[3]) if len(raw) > 3 else None
            elif fit in ("/FitH", "/FitBH"):
                x = None
                y = finite(raw[2]) if len(raw) > 2 else None
            elif fit in ("/FitV", "/FitBV"):
                x = finite(raw[2]) if len(raw) > 2 else None
                y = None
            else:
                x = y = None
        else:
            return None
        if index is None or not 0 <= index < count:
            return None
        result = {"page": index + 1}
        if x is not None or y is not None:
            geom = geometries[index]
            left, bottom, right, top, _, _ = geom
            px, py = point(geom, x if x is not None else left, y if y is not None else top)
            width, height = size(geom)
            result["x"] = max(0, min(width, px))
            result["y"] = max(0, min(height, py))
        return result

    def outlines(items, counter):
        result = []
        for item in items:
            if isinstance(item, list):
                if result:
                    result[-1]["items"] = outlines(item, counter)
                continue
            counter[0] += 1
            if counter[0] > MAX_OUTLINE_ITEMS:
                raise ValueError("Too many outline entries")
            result.append({
                "title": str(getattr(item, "title", ""))[:1024],
                "destination": destination(item),
                "items": [],
            })
        return result

    outline = outlines(reader.outline, [0])
    links = []
    for index, page in enumerate(reader.pages):
        page_links = []
        annotations = page.get("/Annots", [])
        if hasattr(annotations, "get_object"):
            annotations = annotations.get_object()
        for ref in annotations or []:
            try:
                annot = ref.get_object()
                if str(annot.get("/Subtype", "")) != "/Link":
                    continue
                rect = rectangle(geometries[index], annot.get("/Rect"))
                if rect is None:
                    continue
                target = destination(annot.get("/Dest"))
                action = annot.get("/A")
                url = None
                if action is not None:
                    action = action.get_object()
                    action_type = str(action.get("/S", ""))
                    if action_type == "/GoTo":
                        target = destination(action.get("/D"))
                    elif action_type == "/URI":
                        url = safe_url(action.get("/URI", ""))
                if target is not None:
                    page_links.append({"rect": rect, "destination": target})
                elif url is not None:
                    page_links.append({"rect": rect, "url": url})
                if len(page_links) > MAX_LINKS_PER_PAGE:
                    raise ValueError("Too many page links")
            except (KeyError, TypeError, ValueError):
                continue
        links.append(page_links)

    with open(output, "w", encoding="utf-8") as target:
        json.dump({"pages": pages, "outline": outline, "links": links}, target, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: pdf_manifest.py source.pdf output.json")
    try:
        main(sys.argv[1], sys.argv[2])
    except Exception as exc:
        print(f"PDF extraction failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
