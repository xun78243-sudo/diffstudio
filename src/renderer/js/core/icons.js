/**
 * 菜单图标：一组 16×16 的内联 SVG 路径，仅用于菜单里最常用的几项操作，
 * 让"新建 / 打开 / 保存 / 关闭"等动作一眼可辨（Beyond Compare 的菜单同样带图标）。
 *
 * 约定：只画描边（stroke），颜色跟随 CSS 的 currentColor，
 * 因此菜单项悬停、禁用时图标会自动跟着变灰或变色，无需另做一套图标。
 */

const PATHS = {
  // 新建文本比较：文档 + 加号
  text: 'M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z M9 1.5v4h4 M8 8.5v4 M6 10.5h4',
  // 文件夹
  folder: 'M1.5 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5h6.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z',
  // 文件夹同步：两个文件夹 + 双向箭头
  sync: 'M1.5 4.5a1 1 0 0 1 1-1h2.7l1.1 1.4h3.2v3 M8 12.5a1 1 0 0 0 1 1h2.7l1.1-1.4h1.7V5 M5.5 8.5l1.5 1.5 1.5-1.5 M11 7.5l-1.5-1.5-1.5 1.5',
  // 三方合并：三个分支汇合到一点
  merge: 'M8 1.5v5 M3.5 14.5v-3.2l3-2.5 M12.5 14.5v-3.2l-3-2.5 M5.5 14.5h5',
  folderMerge: 'M1.5 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5h6.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z M8 6.2v4.3 M6.1 8.4 8 10.3l1.9-1.9 M4.6 12.6v-1.4 M11.4 12.6v-1.4',
  // 十六进制：网格
  hex: 'M2.5 2.5h11v11h-11z M2.5 6h11 M2.5 9.5h11 M7 2.5v11 M10 2.5v11',
  // 表格：表格框 + 表头
  table: 'M2.5 2.5h11v11h-11z M2.5 6h11 M6.5 6v7.5 M9.5 6v7.5',
  // 图片比较：一幅画
  image: 'M2 2.5h12v11H2z M2 11l3.5-3.5 2.5 2.5 2-2 3 3 M10.5 5.2a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8z',
  // 补丁：一块创可贴
  patch: 'M4.4 1.9 1.9 4.4l9.7 9.7 2.5-2.5z M6 6.3 9.7 10 M6.6 5l2.1 2.1 M8.1 9.6l2.1 2.1',
  // 关闭：叉
  close: 'M4 4l8 8 M12 4l-8 8',
  // 首页：房子
  home: 'M1.8 7.5 8 2l6.2 5.5 M3.5 6.5v7h9v-7 M6.3 13.5v-4h3.4v4',
  // 语言：地球
  language: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z M1.5 8h13 M8 1.5c1.8 1.7 2.8 4 2.8 6.5S9.8 12.8 8 14.5c-1.8-1.7-2.8-4-2.8-6.5S6.2 3.2 8 1.5z',
  // 关于：问号
  help: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z M6.1 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.7.6-.7 1.1v.4 M8 11.6v.9',
};

/** 返回一个内联 SVG 元素；未知图标返回 null（调用方据此跳过）。 */
export function icon(name) {
  const d = PATHS[name];
  if (!d) return null;
  const wrap = document.createElement('span');
  wrap.className = 'mi-icon';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML =
    `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" ` +
    `stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  return wrap;
}
