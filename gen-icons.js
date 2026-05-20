const fs = require('fs');
const zlib = require('zlib');

function createPNG(w, h, pixels) {
  function crc32(buf) {
    let c, table = [];
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
    c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  }
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8]=8; ihdr[9]=2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 3;
      const di = y * (1 + w * 3) + 1 + x * 3;
      raw[di] = pixels[si]; raw[di+1] = pixels[si+1]; raw[di+2] = pixels[si+2];
    }
  }
  const compressed = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function mix(c1, c2, t) { return [lerp(c1[0],c2[0],t), lerp(c1[1],c2[1],t), lerp(c1[2],c2[2],t)]; }

function genIcon(size) {
  const pixels = Buffer.alloc(size * size * 3);
  const bg = [8, 8, 10];
  const gold = [212, 168, 83];
  const goldLight = [240, 223, 160];
  const goldDark = [168, 138, 62];
  const cx = size / 2, cy = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      // Dark background with subtle radial gradient
      const dist = Math.sqrt((x-cx)**2 + (y-cy)**2);
      const maxDist = size * 0.7;
      const bgT = Math.min(1, dist / maxDist) * 0.3;
      const bgColor = mix([14,14,18], bg, bgT);
      pixels[i] = bgColor[0]; pixels[i+1] = bgColor[1]; pixels[i+2] = bgColor[2];

      // Shield shape
      const shieldW = size * 0.32;
      const shieldH = size * 0.38;
      const shieldTop = cy - shieldH * 0.55;
      const dx = Math.abs(x - cx);
      const relY = (y - shieldTop) / (shieldH * 1.1);

      let inShield = false;
      if (relY >= 0 && relY <= 1) {
        // Top half: rectangle with rounded top
        if (relY < 0.45) {
          inShield = dx < shieldW * (1 - relY * 0.1);
        }
        // Bottom half: tapers to point
        else {
          const taper = 1 - ((relY - 0.45) / 0.55);
          inShield = dx < shieldW * taper * 0.95;
        }
      }

      if (inShield) {
        // Shield border (gold gradient based on y position)
        let edgeDist;
        if (relY < 0.45) {
          edgeDist = shieldW * (1 - relY * 0.1) - dx;
        } else {
          const taper = 1 - ((relY - 0.45) / 0.55);
          edgeDist = shieldW * taper * 0.95 - dx;
        }
        // Top edge
        const topDist = y - shieldTop;

        const borderW = size * 0.018;
        const isBorder = edgeDist < borderW || topDist < borderW;

        if (isBorder) {
          // Gold gradient on border (lighter at top, darker at bottom)
          const gradT = relY;
          const borderColor = mix(goldLight, goldDark, gradT);
          pixels[i] = borderColor[0]; pixels[i+1] = borderColor[1]; pixels[i+2] = borderColor[2];
        } else {
          // Inner fill: very dark with subtle gold tint
          const inner = mix([12,12,16], gold, 0.03);
          pixels[i] = inner[0]; pixels[i+1] = inner[1]; pixels[i+2] = inner[2];
        }
      }

      // Checkmark inside shield
      const checkCx = cx, checkCy = cy + size * 0.02;
      const checkScale = size * 0.0028;
      // Three points of checkmark: start(-5,0), corner(-1,4), end(6,-5)
      const p1 = {x: checkCx - 5*checkScale*3, y: checkCy};
      const p2 = {x: checkCx - 1*checkScale*3, y: checkCy + 4*checkScale*3};
      const p3 = {x: checkCx + 6*checkScale*3, y: checkCy - 5*checkScale*3};

      // Distance to line segments
      function distToSeg(px, py, ax, ay, bx, by) {
        const dx = bx-ax, dy = by-ay;
        const len2 = dx*dx+dy*dy;
        let t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px-ax)*dx+(py-ay)*dy)/len2));
        const projX = ax + t*dx, projY = ay + t*dy;
        return Math.sqrt((px-projX)**2 + (py-projY)**2);
      }

      const d1 = distToSeg(x, y, p1.x, p1.y, p2.x, p2.y);
      const d2 = distToSeg(x, y, p2.x, p2.y, p3.x, p3.y);
      const checkDist = Math.min(d1, d2);
      const checkW = size * 0.022;

      if (checkDist < checkW && inShield) {
        const t = 1 - checkDist / checkW;
        const gc = mix(gold, goldLight, 0.3 + t * 0.3);
        pixels[i] = gc[0]; pixels[i+1] = gc[1]; pixels[i+2] = gc[2];
      }

      // Subtle outer glow
      if (!inShield) {
        const glowR = size * 0.42;
        const glowDist = Math.abs(dist - glowR);
        if (glowDist < size * 0.04) {
          const gt = 1 - glowDist / (size * 0.04);
          const intensity = gt * 0.08;
          pixels[i] = Math.min(255, pixels[i] + Math.round(gold[0] * intensity));
          pixels[i+1] = Math.min(255, pixels[i+1] + Math.round(gold[1] * intensity));
          pixels[i+2] = Math.min(255, pixels[i+2] + Math.round(gold[2] * intensity));
        }
      }
    }
  }
  return createPNG(size, size, pixels);
}

fs.writeFileSync('icon-512.png', genIcon(512));
fs.writeFileSync('icon-192.png', genIcon(192));
console.log('Gold luxury icons generated!');
