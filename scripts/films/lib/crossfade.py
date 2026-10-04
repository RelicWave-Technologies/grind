#!/usr/bin/env python3
"""Dissolve every recorded screen change in a plate: frames/ + cuts.json -> final/.

A plate is not encoded on its own; the composer reads final/ frame by frame. This is the
crossfade half of the skill's finish.py, without the loop and the encode."""
import json, os, shutil, sys
from PIL import Image

def smooth(t): return t * t * (3 - 2 * t)

d = sys.argv[1]
meta = json.load(open(os.path.join(d, 'cuts.json')))
n = meta['frames']
blend = {}
for c in meta.get('cuts', []):
    for k in range(1, c['len'] + 1):
        if c['at'] + k < n:
            blend[c['at'] + k] = (c['at'], 1 - smooth(k / (c['len'] + 1)))
src, out = os.path.join(d, 'frames'), os.path.join(d, 'final')
shutil.rmtree(out, ignore_errors=True); os.makedirs(out)
cache = {}
for f in range(n):
    a, b = os.path.join(src, f'{f:05d}.jpg'), os.path.join(out, f'{f:05d}.jpg')
    if f in blend:
        ai, alpha = blend[f]
        if ai not in cache: cache[ai] = Image.open(os.path.join(src, f'{ai:05d}.jpg')).convert('RGB')
        Image.blend(Image.open(a).convert('RGB'), cache[ai], alpha).save(b, quality=93)
    else:
        shutil.copyfile(a, b)
print(f'{d}: {n} frames, {len(blend)} crossfaded')
