export const IMGSEARCH_PY = String.raw`#!/usr/bin/env python3
import sys
import os
import json
import base64
import urllib.request
import urllib.parse
import urllib.error
import concurrent.futures
import argparse
import time

def main():
    start_time = time.time()
    parser = argparse.ArgumentParser(description="Image search via Serper and router fast filtering")
    parser.add_argument("--query", action="append", required=True, help="Search query (can specify multiple)")
    parser.add_argument("--want", required=True, help="Description of what images we are looking for")
    parser.add_argument("--per-query", type=int, default=20, help="Number of results per query from Serper")
    parser.add_argument("--max-select", type=int, default=0, help="Max selected images (0 = unlimited)")
    parser.add_argument("--out", required=True, help="Output directory path")
    parser.add_argument("--batch", type=int, default=6, help="Batch size for filtering")
    parser.add_argument("--concurrency", type=int, default=4, help="Concurrency for filtering")
    parser.add_argument("--model", default="fast", help="Model name for router filtering")
    parser.add_argument("--dry-run", action="store_true", help="Dry run mode")
    args = parser.parse_args()

    serper_api_key = os.environ.get("SERPER_API_KEY")
    ai_router_base_url = os.environ.get("AI_ROUTER_BASE_URL")
    ai_router_proxy_token = os.environ.get("AI_ROUTER_PROXY_TOKEN")

    if not serper_api_key or not ai_router_base_url or not ai_router_proxy_token:
        err_msg = "Missing required environment variables (SERPER_API_KEY, AI_ROUTER_BASE_URL, AI_ROUTER_PROXY_TOKEN)."
        print(json.dumps({"ok": False, "error": err_msg, "errors": [err_msg]}))
        sys.exit(1)

    if args.dry_run:
        print(json.dumps({
            "ok": True,
            "queries": args.query,
            "found": 0,
            "downloaded": 0,
            "selected": 0,
            "out_dir": args.out,
            "files": [],
            "errors": [],
            "elapsed_sec": 0.0
        }))
        sys.exit(0)

    errors = []
    candidates = []
    seen_urls = set()
    img_idx = 0

    # 1. Fetch search results from Serper
    for q in args.query:
        try:
            req_data = json.dumps({"q": q, "num": args.per_query}).encode("utf-8")
            req = urllib.request.Request(
                "https://google.serper.dev/images",
                data=req_data,
                headers={"X-API-KEY": serper_api_key, "Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                images = data.get("images", [])
                for img in images:
                    url = img.get("imageUrl")
                    if url and url not in seen_urls:
                        seen_urls.add(url)
                        candidates.append({"id": f"img{img_idx}", "url": url})
                        img_idx += 1
        except Exception as e:
            msg = f"Serper search failed for query '{q}': {e}"
            sys.stderr.write(msg + "\n")
            errors.append(msg)

    if not candidates:
        print(json.dumps({
            "ok": True,
            "queries": args.query,
            "found": 0,
            "downloaded": 0,
            "selected": 0,
            "out_dir": args.out,
            "files": [],
            "errors": errors,
            "elapsed_sec": 0.0
        }))
        sys.exit(0)

    # 2. Download candidates in parallel
    downloaded = []
    def download_img(item):
        try:
            req = urllib.request.Request(
                item["url"],
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
            )
            with urllib.request.urlopen(req, timeout=25) as resp:
                content_type = resp.headers.get("Content-Type", "")
                if not content_type.startswith("image/"):
                    return None, f"Non-image content type '{content_type}' for {item['url']}"
                data = resp.read()
                if len(data) > 8 * 1024 * 1024:
                    return None, f"Image exceeds 8MB for {item['url']}"
                b64 = base64.b64encode(data).decode("utf-8")
                mime = content_type.split(";")[0].strip() or "image/jpeg"
                return {
                    "id": item["id"],
                    "url": item["url"],
                    "mime": mime,
                    "b64": b64,
                    "bytes": data
                }, None
        except Exception as e:
            return None, f"Download failed for {item['url']}: {e}"

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(download_img, item) for item in candidates]
        for fut in concurrent.futures.as_completed(futures):
            res, err = fut.result()
            if res:
                downloaded.append(res)
            elif err:
                sys.stderr.write(err + "\n")
                errors.append(err)

    if not downloaded:
        print(json.dumps({
            "ok": True,
            "queries": args.query,
            "found": len(candidates),
            "downloaded": 0,
            "selected": 0,
            "out_dir": args.out,
            "files": [],
            "errors": errors,
            "elapsed_sec": 0.0
        }))
        sys.exit(0)

    # 3. Batch filtering with AI router
    batches = [downloaded[i:i + args.batch] for i in range(0, len(downloaded), args.batch)]
    selected_ids = set()

    def process_batch(batch):
        filter_prompt = (
            f"توضیح تصویر مورد نیاز: {args.want}\n\n"
            "معیارهای رد کردن (این تصاویر را انتخاب نکن):\n"
            "- تصاویر دارای واترمارک یا لوگوی سایت‌های استوک (مثل Shutterstock, Getty, iStock, Alamy, Adobe Stock)\n"
            "- بندانگشتی‌های بسیار تار، پیکسلی، بیش از حد برش‌خورده یا با کیفیت خیلی پایین\n"
            "- کلاژهای بی‌ربط چندعکسی یا اسکرین‌شات‌های پر از متن/منو/تبلیغ، وقتی عکس تمیز و واقعی خواسته شده\n"
            "- تصاویری که فقط متن یا میم هستند و با سوژه‌ی اصلی مطابقت دقیق ندارند\n\n"
            "فقط آیدی تصاویری را برگردان که کاملاً واضح، باکیفیت و منطبق با توضیح بالا هستند.\n"
            'خروجی باید دقیقاً یک JSON معتبر با کلید selected_ids باشد، مثل: {"selected_ids": ["img0"]} یا اگر هیچ‌کدام مناسب نبود: {"selected_ids": []}.'
        )
        content = [
            {"type": "text", "text": filter_prompt}
        ]
        for img in batch:
            content.append({"type": "text", "text": f"id: {img['id']}"})
            content.append({"type": "image_url", "image_url": {"url": f"data:{img['mime']};base64,{img['b64']}"}})

        req_body = json.dumps({
            "model": args.model,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "user", "content": content}]
        }).encode("utf-8")

        router_url = f"{ai_router_base_url.rstrip('/')}/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {ai_router_proxy_token}",
            "Content-Type": "application/json"
        }

        import time
        for attempt in range(3):
            try:
                req = urllib.request.Request(router_url, data=req_body, headers=headers)
                with urllib.request.urlopen(req, timeout=45) as resp:
                    res_json = json.loads(resp.read().decode("utf-8"))
                    text_res = res_json.get("choices", [{}])[0].get("message", {}).get("content", "")
                    parsed = json.loads(text_res)
                    return parsed.get("selected_ids", [])
            except Exception as e:
                sys.stderr.write(f"Batch filter attempt {attempt+1} failed: {e}\n")
                if attempt < 2:
                    time.sleep(2 ** attempt)
                else:
                    errors.append(f"Batch filter failed: {e}")
        return []

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        futures = [executor.submit(process_batch, b) for b in batches]
        for fut in concurrent.futures.as_completed(futures):
            res_ids = fut.result()
            for rid in res_ids:
                selected_ids.add(rid)

    selected_items = [d for d in downloaded if d["id"] in selected_ids]
    if args.max_select > 0 and len(selected_items) > args.max_select:
        selected_items = selected_items[:args.max_select]

    # 4. Save selected files to output directory
    os.makedirs(args.out, exist_ok=True)
    out_files = []
    slug = os.path.basename(args.out.rstrip("/")) or "image"

    for item in selected_items:
        ext = "jpg"
        if "png" in item["mime"]: ext = "png"
        elif "webp" in item["mime"]: ext = "webp"
        elif "gif" in item["mime"]: ext = "gif"
        
        filename = f"{item['id']}_{slug}.{ext}"
        filepath = os.path.join(args.out, filename)
        with open(filepath, "wb") as f:
            f.write(item["bytes"])
        out_files.append(filepath)

    print(json.dumps({
        "ok": True,
        "queries": args.query,
        "found": len(candidates),
        "downloaded": len(downloaded),
        "selected": len(out_files),
        "out_dir": args.out,
        "files": out_files,
        "errors": errors,
        "elapsed_sec": round(time.time() - start_time, 2)
    }))

if __name__ == "__main__":
    main()
`;
