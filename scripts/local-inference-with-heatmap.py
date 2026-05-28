#!/usr/bin/env python3
"""
Local Phase 2 inference + Grad-CAM heatmap overlay.

Reproduces the production Lambda's 14-class CXR prediction PLUS generates
a Grad-CAM heatmap (which the Lambda does not store). Useful for clinician
visualization or debugging false positives.

Usage:
    python scripts/local-inference-with-heatmap.py \
        --image samples/cxr-images/00094318-ffb6a7d8-6dd1e667-280271ad-ae663064.png \
        --checkpoint samples/extras/models/latest_checkpoint.pth \
        --out /tmp/heatmap_overlay.png

Outputs:
    /tmp/heatmap_overlay.png  — original CXR with Grad-CAM overlay
    stdout                    — 14-class probabilities + positive HPO codes
"""
from __future__ import annotations
import argparse
import sys
from pathlib import Path

try:
    import cv2
    import numpy as np
    import torch
    import torch.nn.functional as F
    from PIL import Image
except ImportError as e:
    print(f"missing dep: {e}. Install: pip install torch torchvision opencv-python pillow numpy", file=sys.stderr)
    sys.exit(1)

LABELS = [
    "Atelectasis", "Cardiomegaly", "Consolidation", "Edema",
    "Enlarged Cardiomediastinum", "Fracture", "Lung Lesion", "Lung Opacity",
    "No Finding", "Pleural Effusion", "Pleural Other", "Pneumonia",
    "Pneumothorax", "Support Devices",
]
HPO_MAP = {
    "Atelectasis": "HP:0100750", "Cardiomegaly": "HP:0001640",
    "Consolidation": "HP:0032177", "Edema": "HP:0100598",
    "Enlarged Cardiomediastinum": "HP:0034501", "Fracture": "HP:0002757",
    "Lung Lesion": "HP:0032338", "Lung Opacity": "HP:0031457",
    "Pleural Effusion": "HP:0002202", "Pleural Other": "HP:0002102",
    "Pneumonia": "HP:0002090", "Pneumothorax": "HP:0002107",
}


def load_image(path: str, size: int = 448):
    img = Image.open(path).convert("RGB").resize((size, size), Image.BILINEAR)
    arr = np.array(img).astype(np.float32) / 255.0
    arr = (arr - 0.485) / 0.229    # ImageNet mean/std (single channel approx)
    tensor = torch.from_numpy(arr.transpose(2, 0, 1)).unsqueeze(0)
    return tensor, np.array(img)


def grad_cam(model, image: torch.Tensor, target_class: int, target_layer):
    """Standard Grad-CAM: gradient of target class wrt last conv feature map."""
    activations = {}
    gradients = {}
    h1 = target_layer.register_forward_hook(lambda m, i, o: activations.setdefault("v", o))
    h2 = target_layer.register_full_backward_hook(lambda m, gi, go: gradients.setdefault("v", go[0]))

    model.eval()
    out = model(image)
    score = out[0, target_class]
    model.zero_grad()
    score.backward(retain_graph=True)

    act = activations["v"][0]                    # (C, H, W)
    grad = gradients["v"][0]                     # (C, H, W)
    weights = grad.mean(dim=(1, 2))              # (C,)
    cam = (weights[:, None, None] * act).sum(dim=0)
    cam = F.relu(cam)
    cam = cam / (cam.max() + 1e-8)

    h1.remove(); h2.remove()
    return cam.detach().cpu().numpy()


def overlay_heatmap(orig_rgb: np.ndarray, cam: np.ndarray, out_path: str):
    cam_resized = cv2.resize(cam, (orig_rgb.shape[1], orig_rgb.shape[0]))
    heatmap = cv2.applyColorMap(np.uint8(255 * cam_resized), cv2.COLORMAP_JET)
    heatmap = cv2.cvtColor(heatmap, cv2.COLOR_BGR2RGB)
    overlay = cv2.addWeighted(orig_rgb.astype(np.uint8), 0.6, heatmap, 0.4, 0)
    Image.fromarray(overlay).save(out_path)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--image", required=True)
    p.add_argument("--checkpoint", required=True)
    p.add_argument("--out", default="/tmp/heatmap_overlay.png")
    p.add_argument("--threshold", type=float, default=0.3)
    args = p.parse_args()

    if not Path(args.checkpoint).exists():
        print(f"checkpoint not found: {args.checkpoint}", file=sys.stderr)
        print("Download via: aws s3 cp s3://your-bucket/Phase_2/latest_checkpoint.pth .", file=sys.stderr)
        sys.exit(2)

    print(f"Loading model from {args.checkpoint}...")
    state = torch.load(args.checkpoint, map_location="cpu")
    # Expects model object saved with `torch.save(model, ...)`. If state_dict only,
    # you need to instantiate the SooNet architecture from lambdas/phase2-vision/lambda/.
    if isinstance(state, dict) and "state_dict" in state:
        print("State dict only — instantiate SooNet from soo_net_5.py first", file=sys.stderr)
        sys.exit(3)
    model = state
    model.eval()

    img_tensor, orig_rgb = load_image(args.image)
    with torch.no_grad():
        logits = model(img_tensor)
        probs = torch.sigmoid(logits)[0].numpy()

    # Top class for Grad-CAM
    top_idx = int(np.argmax(probs))
    print(f"\nTop class: {LABELS[top_idx]} (p={probs[top_idx]:.3f})")
    print(f"Generating Grad-CAM for {LABELS[top_idx]}...")

    # Find last conv layer (model-specific — adjust if your SooNet uses different name)
    target_layer = None
    for name, m in model.named_modules():
        if isinstance(m, torch.nn.Conv2d):
            target_layer = m  # take the last one
    if target_layer is None:
        print("No Conv2d layer found", file=sys.stderr); sys.exit(4)

    cam = grad_cam(model, img_tensor, top_idx, target_layer)
    overlay_heatmap(orig_rgb, cam, args.out)
    print(f"✓ Heatmap saved: {args.out}")

    print("\n=== All 14-class predictions ===")
    for i, lab in enumerate(LABELS):
        flag = " ✓" if probs[i] >= args.threshold else ""
        hpo = HPO_MAP.get(lab, "—")
        print(f"  {lab:30s} {probs[i]:.4f}   {hpo}{flag}")

    pos_hpos = [HPO_MAP[lab] for i, lab in enumerate(LABELS)
                if probs[i] >= args.threshold and lab in HPO_MAP]
    print(f"\npositive_hpos ({len(pos_hpos)}):", pos_hpos)


if __name__ == "__main__":
    main()
