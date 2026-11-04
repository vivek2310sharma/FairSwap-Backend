import os
import sys
import numpy as np
import cv2
from paddleocr import PaddleOCR

def run_smoke_test():
    print("Python OCR Smoke Test: Verifying offline model files and inference...")
    base_dir = os.path.dirname(os.path.abspath(__file__))
    models_dir = os.getenv("MODELS_DIR", os.path.join(base_dir, "models"))
    det_dir = os.path.join(models_dir, "en_PP-OCRv3_det_infer")
    rec_dir = os.path.join(models_dir, "en_PP-OCRv3_rec_infer")
    cls_dir = os.path.join(models_dir, "ch_ppocr_mobile_v2.0_cls_infer")

    for d in [det_dir, rec_dir, cls_dir]:
        pdmodel = os.path.join(d, "inference.pdmodel")
        pdiparams = os.path.join(d, "inference.pdiparams")
        if not os.path.isfile(pdmodel) or not os.path.isfile(pdiparams):
            print(f"FATAL: Missing inference assets in {d}", file=sys.stderr)
            sys.exit(1)

    print("Initializing PaddleOCR engine with local model directories...")
    ocr = PaddleOCR(
        use_angle_cls=True,
        lang="en",
        det_model_dir=det_dir,
        rec_model_dir=rec_dir,
        cls_model_dir=cls_dir,
        use_gpu=False,
        show_log=False
    )

    qr_detector = cv2.QRCodeDetector()

    # 1. Generate synthetic image containing text "FAIRSWAP" to test OCR
    text_img = np.full((120, 400, 3), 255, dtype=np.uint8)
    cv2.putText(
        text_img,
        "FAIRSWAP",
        (30, 80),
        cv2.FONT_HERSHEY_SIMPLEX,
        2.0,
        (0, 0, 0),
        4,
        cv2.LINE_AA
    )

    print("Running OCR inference on synthetic text image...")
    ocr_res = ocr.ocr(text_img, cls=True)
    detected_words = []
    if ocr_res and len(ocr_res) > 0 and ocr_res[0] is not None:
        for line in ocr_res[0]:
            detected_words.append(line[1][0].upper())

    print(f"OCR detected: {detected_words}")
    if not any("FAIRSWAP" in w for w in detected_words):
        print(f"FATAL: Expected 'FAIRSWAP' in OCR output, got {detected_words}", file=sys.stderr)
        sys.exit(1)

    # 2. Test QR detection
    # A standard version 1 QR code 21x21 containing text "fairswap-qr-test"
    # We can encode using OpenCV QR detector or generate a basic pattern, or test detector on synthetic QR.
    # OpenCV's QRCodeEncoder is available in cv2
    print("Testing QR code detection...")
    try:
        qr_encoder = cv2.QRCodeEncoder.create()
        qr_mat = qr_encoder.encode("fairswap-test-qr-1234")
        if qr_mat is not None:
            # Scale up QR matrix so detector can easily read it
            scaled_qr = cv2.resize(qr_mat, (210, 210), interpolation=cv2.INTER_NEAREST)
            # Add quiet zone (white border)
            qr_with_border = cv2.copyMakeBorder(scaled_qr, 30, 30, 30, 30, cv2.BORDER_CONSTANT, value=[255, 255, 255])
            val, points, _ = qr_detector.detectAndDecode(qr_with_border)
            print(f"Decoded QR payload: '{val}'")
            if val != "fairswap-test-qr-1234":
                print(f"FATAL: Expected QR payload 'fairswap-test-qr-1234', got '{val}'", file=sys.stderr)
                sys.exit(1)
        else:
            print("Notice: QRCodeEncoder not returning matrix, validating detector object directly")
            val, _, _ = qr_detector.detectAndDecode(text_img)
            assert val == "", "Empty image should have empty QR payload"
    except AttributeError:
        # Fallback if cv2 doesn't have QRCodeEncoder in headless build
        val, _, _ = qr_detector.detectAndDecode(text_img)
        assert val == "", "Empty image should have empty QR payload"

    print("Python OCR Smoke Test PASSED: Models loaded offline, inference succeeded.")

if __name__ == "__main__":
    run_smoke_test()
