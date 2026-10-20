/**
 * 图片比较的纯计算部分：逐像素差异判定、差异边界、可见区域裁切。
 *
 * 渲染进程拿不到 Node 的 Buffer/canvas 解码器，所以解码由主进程完成
 * （Electron 的 nativeImage），这里只处理已经解好的 RGBA 像素数组。
 * 把计算独立出来是为了能在 Node 里直接单测，不必启动界面。
 */

/** 判断两个像素是否视为"相同"：颜色距离在容差内即相同。 */
export function pixelDiffers(a, b, tolerance = 0) {
  const dr = Math.abs(a[0] - b[0]);
  const dg = Math.abs(a[1] - b[1]);
  const db = Math.abs(a[2] - b[2]);
  const da = Math.abs(a[3] - b[3]);
  const d = Math.max(dr, dg, db, da);
  return d > tolerance;
}

/**
 * 逐字节比较两个 RGBA 缓冲区。
 *
 * 尺寸不同时，按"重叠区域 + 多出来的部分都算差异"处理：一张图比另一张
 * 高 10 像素，那 10 行整行都是差异，而不是被判成整体不匹配。
 *
 * @returns {{sameSize:boolean, differing:number, box:null|{x:number,y:number,w:number,h:number}}}
 *   differing 为差异像素数；box 是差异的外接矩形（坐标为"并集画布"像素，原点在左上角）。
 */
export function comparePixels(left, right, tolerance = 0) {
  const sameSize = left.width === right.width && left.height === right.height;
  const w = Math.max(left.width, right.width);
  const h = Math.max(left.height, right.height);
  let differing = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inL = x < left.width && y < left.height;
      const inR = x < right.width && y < right.height;
      let differs;
      if (inL && inR) {
        const i = (y * left.width + x) * 4;
        const j = (y * right.width + x) * 4;
        differs = pixelDiffers(
          [left.data[i], left.data[i + 1], left.data[i + 2], left.data[i + 3]],
          [right.data[j], right.data[j + 1], right.data[j + 2], right.data[j + 3]],
          tolerance,
        );
      } else {
        // 只在一侧存在的区域：如果该像素完全透明，视觉上没有区别。
        differs = true;
        if (inL) {
          const i = (y * left.width + x) * 4;
          if (left.data[i + 3] === 0) differs = false;
        } else {
          const j = (y * right.width + x) * 4;
          if (right.data[j + 3] === 0) differs = false;
        }
      }
      if (!differs) continue;
      differing++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  return {
    sameSize,
    differing,
    box: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

/**
 * 计算让整张图落在视口内的缩放比例（不放大超过 100%，图片小的时候按原尺寸居中）。
 */
export function fitScale(imgW, imgH, viewW, viewH) {
  if (!imgW || !imgH || !viewW || !viewH) return 1;
  return Math.min(1, viewW / imgW, viewH / imgH);
}

/**
 * 以某个像素为中心、按给定缩放取可见区域（用于"放大后跟随差异位置"）。
 * 返回画布内的像素矩形，自动夹紧到图片边界。
 */
export function visibleRect(imgW, imgH, scale, centerX, centerY, viewW, viewH) {
  const s = scale > 0 ? scale : 1;
  const w = Math.min(imgW, Math.max(1, Math.round(viewW / s)));
  const h = Math.min(imgH, Math.max(1, Math.round(viewH / s)));
  let x = Math.round(centerX - w / 2);
  let y = Math.round(centerY - h / 2);
  x = Math.max(0, Math.min(imgW - w, x));
  y = Math.max(0, Math.min(imgH - h, y));
  return { x, y, w, h };
}

/** 在若干个差异点之间循环移动（上一处 / 下一处）。 */
export function stepIndex(index, count, dir) {
  if (!count) return -1;
  if (index < 0) return dir > 0 ? 0 : count - 1;
  return (index + dir + count) % count;
}

/**
 * 把差异像素按 4 连通聚成区域，供"上一处 / 下一处"和差异框使用。
 *
 * @param {number} width 画布宽度
 * @param {number} height 画布高度
 * @param {Uint8Array} differs 长度 width*height，1 表示该像素有差异
 * @returns {Array<{x,y,w,h,cx,cy,pixels}>} 按从上到下、从左到右排序
 */
export function findRegions(width, height, differs) {
  const total = width * height;
  const seen = new Uint8Array(total);
  const regions = [];
  const stack = [];
  for (let start = 0; start < total; start++) {
    if (!differs[start] || seen[start]) continue;
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    while (stack.length) {
      const p = stack.pop();
      const x = p % width;
      const y = (p - x) / width;
      count++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      const neighbors = [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y < height - 1 ? p + width : -1,
      ];
      for (const q of neighbors) {
        if (q < 0 || seen[q] || !differs[q]) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    regions.push({
      x: minX,
      y: minY,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
      cx: Math.round((minX + maxX) / 2),
      cy: Math.round((minY + maxY) / 2),
      pixels: count,
    });
  }
  regions.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return regions;
}
