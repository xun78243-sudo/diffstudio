// 文件夹式补丁复制：按一侧的文件状态把差异"铺"到另一侧，并给出可撤销清单。
//
// 与 folderSync.js 的区别：这里只做一次性的"打补丁"预览与执行，不维护同步
// 计划表；每一步都记下撤销需要的信息（新建的删掉，覆盖的恢复原状）。

import { formatBytes } from './ui.js';

/**
 * 文件夹比较视图的条目状态（`views/folderCompare.js` 的 S）。
 * 这里按字符串判断，避免 core 反向依赖视图。
 */
const LEFT_ONLY = ['left-orphan', 'LEFT_ONLY', 'LEFT_ORPHAN'];
const RIGHT_ONLY = ['right-orphan', 'RIGHT_ONLY', 'RIGHT_ORPHAN'];
const SIDE_ONLY = { left: LEFT_ONLY, right: RIGHT_ONLY };

/** 可以安全参与复制的状态；`?`、`error` 之类一律跳过。 */
const CLEAN = ['same', 'diff', 'left-orphan', 'right-orphan', 'LEFT_ONLY', 'RIGHT_ONLY', 'DIFF'];

function sameStatus(a, b) {
  return String(a).toLowerCase() === b;
}

/**
 * 生成复制计划。
 *
 * @param {Array<{rel:string,name:string,type:string,status:string,size:number}>} entries
 * @param {'left'|'right'} target 目标侧（把另一侧的内容补到这一侧）
 * @param {'tree'|'content'} mode
 *   tree    = 只补目标侧缺失的文件/目录（覆盖不碰）
 *   content = 内容也不同的文件一并覆盖
 *   mirror  = 目标侧独有的文件删除，使两侧一致
 * @returns {Array<{rel,name,type,action:'copy'|'overwrite'|'delete',from:string,to:string,size:number}>}
 */
export function planFolderPatch(entries, target, mode = 'tree') {
  const other = target === 'left' ? 'right' : 'left';
  const ops = [];
  for (const e of entries || []) {
    if (!e || !e.rel) continue;
    const base = { rel: e.rel, name: e.name || e.rel, size: e.size || 0, from: other, to: target };
    // 这一轮没找到 / 判断不了的状态（有开放句柄等）不进计划：
    // 复制与删除是同一件事的两面，猜错就会删掉用户的数据。
    const clean = CLEAN.some((st) => sameStatus(e.status, st));
    if (SIDE_ONLY[other].includes(e.status) && clean) {
      // 目录里的文件会在计划里单独列出，届时父目录会被顺带创建；
      // 只有空目录才作为一条「新建目录」保留。
      ops.push({ ...base, type: e.type || 'file', action: e.type === 'dir' ? 'mkdir' : 'copy' });
    } else if (mode === 'content' && clean && sameStatus(e.status, 'diff') && e.type !== 'dir') {
      ops.push({ ...base, type: 'file', action: 'overwrite' });
    } else if (mode === 'mirror' && clean && SIDE_ONLY[target].includes(e.status) && e.type !== 'dir') {
      ops.push({ ...base, type: 'file', action: 'delete' });
    }
  }
  return ops;
}

/** 计划摘要：`{ copy, overwrite, delete }` 三种操作各多少项（建目录不计）。 */
export function describePlan(ops) {
  const count = { copy: 0, overwrite: 0, delete: 0 };
  for (const op of ops || []) {
    if (op.action === 'mkdir') continue;
    count[op.action] = (count[op.action] || 0) + 1;
  }
  return count;
}

/** 单个操作的人话描述，状态栏与报告共用。 */
export function describeOp(op) {
  const dir = op.from === 'left' ? '左 → 右' : '右 → 左';
  const size = formatBytes(op.size || 0);
  if (op.action === 'delete') return `删除 ${op.rel}（${size}）`;
  if (op.action === 'mkdir') return `新建目录 ${op.rel}`;
  return `${op.action === 'overwrite' ? '覆盖' : '复制'} ${op.rel}（${size}，${dir}）`;
}

/** 报告模型：交给 core/patch.js 的 buildReport 渲染成 HTML / 文本。 */
export function patchReportModel(ops, leftName, rightName, generated, title = 'DiffStudio 文件夹补丁') {
  return {
    title,
    leftName,
    rightName,
    generated,
    sections: [
      {
        title: '待执行的复制',
        rows: (ops || []).map((op) => ({
          status: op.action === 'delete' ? 'left' : op.action === 'overwrite' ? 'change' : 'right',
          left: op.action === 'delete' ? op.rel : '',
          right: op.action === 'delete' ? '' : op.rel,
        })),
      },
    ],
  };
}
