import os
import sys
import hashlib
import requests
import cv2
import numpy as np
from fastapi import FastAPI, Header, HTTPException, status
from pydantic import BaseModel, HttpUrl
from typing import List, Optional
from urllib.parse import urlparse
from paddleocr import PaddleOCR

INTERNAL_SECRET = os.getenv("MODERATION_SECRET")
if not INTERNAL_SECRET or len(INTERNAL_SECRET) < 16:
    raise RuntimeError("FATAL: MODERATION_SECRET must be at least 16 characters")

ALLOWED_STORAGE_HOST = os.getenv("ALLOWED_STORAGE_HOST")
if not ALLOWED_STORAGE_HOST:
    raise RuntimeError("FATAL: ALLOWED_STORAGE_HOST is required")

MAX_IMAGE_BYTES = 10 * 1024 * 1024

# Model directory configuration: Fail closed if local model files are absent
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.getenv("MODELS_DIR", os.path.join(BASE_DIR, "models"))
DET_MODEL_DIR = os.path.join(MODELS_DIR, "en_PP-OCRv3_det_infer")
REC_MODEL_DIR = os.path.join(MODELS_DIR, "en_PP-OCRv3_rec_infer")
CLS_MODEL_DIR = os.path.join(MODELS_DIR, "ch_ppocr_mobile_v2.0_cls_infer")

for model_path in [DET_MODEL_DIR, REC_MODEL_DIR, CLS_MODEL_DIR]:
    pdmodel = os.path.join(model_path, "inference.pdmodel")
    pdiparams = os.path.join(model_path, "inference.pdiparams")
    if not os.path.isfile(pdmodel) or not os.path.isfile(pdiparams):
        raise RuntimeError(f"FATAL: Required PaddleOCR model files missing in {model_path}. Offline startup failed.")

# Initialize PaddleOCR with explicit local directories to prevent runtime downloads
ocr_engine = PaddleOCR(
    use_angle_cls=True,
    lang="en",
    det_model_dir=DET_MODEL_DIR,
    rec_model_dir=REC_MODEL_DIR,
    cls_model_dir=CLS_MODEL_DIR,
    use_gpu=False,
    show_log=False
)

# Dedicated OpenCV QR code detector
qr_detector = cv2.QRCodeDetector()

app = FastAPI(title="FairSwap Moderation Python OCR Worker")

class MediaItem(BaseModel):
    id: str
    originalStoragePath: str
    scopedSignedUrl: HttpUrl
    mediaSha256: str

class OcrScanRequest(BaseModel):
    media: List[MediaItem]

@app.get("/healthz")
def healthz():
    return {
        "status": "ready",
        "service": "python-ocr-qr-worker",
        "scope": "english_only_v1",
        "lang": "en"
    }

@app.post("/scan")
def scan_media(request: OcrScanRequest, x_internal_secret: Optional[str] = Header(None)):
    if x_internal_secret != INTERNAL_SECRET:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    extracted_texts = []
    qr_payloads = []
    results = []
    all_success = True

    for item in request.media:
        url_str = str(item.scopedSignedUrl)
        parsed_url = urlparse(url_str)

        # Exact storage host and path verification
        if (
            parsed_url.scheme != "https"
            or parsed_url.netloc.lower() != ALLOWED_STORAGE_HOST.lower()
            or "/storage/v1/object/sign/listing-originals/" not in parsed_url.path
        ):
            results.append({
                "mediaId": item.id,
                "sha256Verified": False,
                "status": "download_failed",
                "error": "STORAGE_ORIGIN_VIOLATION"
            })
            all_success = False
            continue

        try:
            res = requests.get(
                url_str,
                allow_redirects=False,
                timeout=5,
                stream=True
            )
            if res.status_code != 200:
                results.append({
                    "mediaId": item.id,
                    "sha256Verified": False,
                    "status": "download_failed",
                    "error": f"HTTP_{res.status_code}"
                })
                all_success = False
                continue

            content = res.raw.read(MAX_IMAGE_BYTES + 1)
            if len(content) > MAX_IMAGE_BYTES:
                results.append({
                    "mediaId": item.id,
                    "sha256Verified": False,
                    "status": "download_failed",
                    "error": "IMAGE_SIZE_EXCEEDS_LIMIT"
                })
                all_success = False
                continue

            computed_sha = hashlib.sha256(content).hexdigest()
            if computed_sha != item.mediaSha256:
                results.append({
                    "mediaId": item.id,
                    "sha256Verified": False,
                    "status": "hash_mismatch",
                    "error": "COMPUTED_HASH_MISMATCH"
                })
                all_success = False
                continue

            image_array = np.frombuffer(content, np.uint8)
            img = cv2.imdecode(image_array, cv2.IMREAD_COLOR)
            if img is None:
                results.append({
                    "mediaId": item.id,
                    "sha256Verified": True,
                    "status": "decode_failed",
                    "error": "IMAGE_DECODE_ERROR"
                })
                all_success = False
                continue

            # QR Code extraction
            val, points, qrcode = qr_detector.detectAndDecode(img)
            if val:
                qr_payloads.append(val)

            # English PaddleOCR text extraction
            ocr_result = ocr_engine.ocr(img, cls=True)
            if ocr_result and len(ocr_result) > 0 and ocr_result[0] is not None:
                for line in ocr_result[0]:
                    text = line[1][0]
                    confidence = line[1][1]
                    if confidence > 0.6:
                        extracted_texts.append(text)

            results.append({
                "mediaId": item.id,
                "sha256Verified": True,
                "status": "success"
            })

        except Exception as e:
            results.append({
                "mediaId": item.id,
                "sha256Verified": False,
                "status": "timeout",
                "error": "SCAN_EXCEPTION"
            })
            all_success = False

    return {
        "status": "completed" if all_success else "incomplete",
        "scannedCount": len([r for r in results if r["status"] == "success"]),
        "results": results,
        "extractedTexts": extracted_texts,
        "qrPayloads": qr_payloads,
    }
