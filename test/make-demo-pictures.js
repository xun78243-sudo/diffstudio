/**
 * 生成图片比较用的示例图片（demo/pics/pic-left.png / pic-right.png）。
 *
 * 用 Electron 自带的 nativeImage 编码 PNG，不引入额外依赖。
 * 两张图都是 160×120：上半部分浅蓝、下半部分蓝色，各有一个色块，
 * 右侧图把左侧图的绿色块挪到右上并改成红色——一眼能看出两处差异。
 */

const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const W = 160;
const H = 120;

function makeImage(variant) {
  const buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const band = y < 60;
      let r = band ? 200 : 60;
      let g = band ? 210 : 120;
      let b = band ? 235 : 200;
      if (variant === 0 && x > 20 && y > 70 && x < 50 && y < 95) { r = 40; g = 160; b = 80; }
      if (variant === 1 && x > 100 && y > 70 && x < 140 && y < 100) { r = 220; g = 40; b = 40; }
      // nativeImage 的位图是 BGRA
      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: W, height: H });
}

app.whenReady().then(() => {
  const out = path.join(__dirname, '..', 'demo', 'pics');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'pic-left.png'), makeImage(0).toPNG());
  fs.writeFileSync(path.join(out, 'pic-right.png'), makeImage(1).toPNG());
  console.log('demo pictures written to demo/pics');
  app.quit();
});
