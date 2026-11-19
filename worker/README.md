# Cinematic AI Studio — Open-Source Stage 4 GPU Worker

Run genuine mask-conditioned and reference-conditioned Stage 4 character replacement on your own NVIDIA GPU or free Google Colab GPU with **$0 third-party API fees**.

## Hardware Requirements
- **Face Replacement (`insightface-inswapper-128`)**: NVIDIA GPU with **8 GB VRAM** (e.g. RTX 3060 / 4060 / Colab T4).
- **Full-Body & Wardrobe Replacement (`flux-controlnet-ipadapter`)**: NVIDIA GPU with **12–16 GB VRAM** (e.g. RTX 3080 12GB / 4070 / Colab L4 / RunPod).

## Setup (Local Linux/Windows or Google Colab)

```bash
cd worker
pip install -r requirements.txt
mkdir -p models
# Place insightface swapper weights in models/inswapper_128.onnx
uvicorn gpu_worker:app --host 0.0.0.0 --port 8000
```

If running on Google Colab or a remote GPU server, expose port `8000` via Cloudflare Tunnel (`cloudflared tunnel --url http://127.0.0.1:8000`) or ngrok and paste the public HTTPS URL into **API Settings -> Open-Source Local / External GPU Worker**.

## Endpoints Implemented
- `GET /health`: Reports GPU model, VRAM, and loaded Stage 4 weights.
- `POST /segment`: Generates/refines feathered person/face masks.
- `POST /edit-frame`: Performs reference-conditioned character replacement on extracted video frames with mask & previous-frame temporal conditioning.
