# FairSwap Node Vision Offline Models Manifest & Checksums

This directory contains configuration, scripts, provenance records, and license documentation for offline operation of the Node Vision service.

To avoid storing large binary model weights in source control, model assets are fetched from pinned, immutable sources and validated against canonical SHA-256 checksums during Docker image build (`scripts/download-models.sh`). At runtime, both models are loaded strictly from the local filesystem (`file://`) within the container image.

---

## 1. NSFWJS (MobileNetV2 Quantized)
- **Source:** https://raw.githubusercontent.com/infinitered/nsfwjs/master/models/mobilenet_v2
- **Upstream Repository:** https://github.com/infinitered/nsfwjs
- **Model Topology:** MobileNetV2 architecture fine-tuned for NSFW classification
- **Input Size:** 224x224 RGB [0, 255]
- **Output Classes:** `Drawing`, `Hentai`, `Neutral`, `Porn`, `Sexy`
- **Files & SHA-256 Checksums:**
  - `model.json`: `11846416217e68bf1eb7b0e651bcfd305973566453c63275bbd16766ab089979`
  - `group1-shard1of1`: `8e7dddbb16acacc1bf1601b1b8a761e730ff934b7f2d7771312b2f000e5f5f13`
- **Redistribution & License Terms:**
  - **License:** MIT License (Copyright (c) 2019 Infinite Red, Inc.)
  - **Redistribution Requirements:** Preservation of copyright notice and permission notice in all copies or substantial portions of the software. Commercial use, modification, distribution, and private use are permitted without royalty.

---

## 2. MobileNetV2 (1.00 Multiplier, 224x224)
- **Source:** https://storage.googleapis.com/tfjs-models/savedmodel/mobilenet_v2_1.0_224/
- **Upstream Repository:** https://github.com/tensorflow/models/tree/master/research/slim/nets/mobilenet
- **Model Topology:** MobileNetV2 ImageNet GraphModel (`mobilenet_v2_1.0_224`)
- **Input Size:** 224x224 RGB normalized [-1, 1]
- **Output Classes:** 1001 ImageNet categories
- **Files & SHA-256 Checksums:**
  - `model.json`: `12e180771864a87473ae06988b8564d9fd077b11c1854030e90509917203cf6f`
  - `group1-shard1of4`: `b837ab72b76b59e217750e0afed94b8f877fce7fff71b8d9cead71fc11612d8c`
  - `group1-shard2of4`: `4b9b02a59ecfea1a698a576f1400e876170ef78abe0e06b16195ebfe2983f6d5`
  - `group1-shard3of4`: `fab6533531d17b78ad67223c82d9a452263ccc4d309a20db91a5de3714aa6a00`
  - `group1-shard4of4`: `617fd3639ac5cfb94a971bef032fcdfa7690816d524117f54a9cc693d0b2c5f4`
- **Redistribution & License Terms:**
  - **License:** Apache License, Version 2.0 (Copyright Google LLC)
  - **Redistribution Requirements:** Retention of copyright, patent, trademark, and attribution notices. Permitted for commercial use, modification, distribution, and sublicensing in source or binary form under Apache-2.0 terms.

---

## 3. Image Fixture
- **File:** `test_fixture.jpg` (located in node-vision service root)
- **Format:** 24-bit Truecolor RGB JPEG image
- **SHA-256:** `599f17163dd99a2882fffa4472cd4fa7186609f3903206dabfc29428e0a0325d`
