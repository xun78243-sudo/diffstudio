## DiffStudio 0.1.0

首个公开版本：受 Beyond Compare 启发的桌面文件/文件夹比较、合并与同步工具（Electron）。

### 功能

- **文本比较**：Myers O(ND) 差分（前后缀裁剪）、Beyond Compare 行类型（`same`/`left`/`right`/`change`/`conflict`）、行内字符级高亮、仅看差异、手动对齐。
- **三方合并**：diff3 式 hunk 合并，相同修改自动接受，重叠冲突显式报告。
- **文件夹比较**：同步树形对照，主进程计算相对路径，可导出 HTML 差异报告。
- **文件夹补丁**：按单侧状态铺到另一侧，附带可撤销清单。
- **CSV / 图片比较**：识别表头的列匹配；像素级比较。
- **多语言界面**：菜单语言单选项不变量，全量 UI 文案本地化。
- **安装包**：NSIS x64，可选安装目录，创建桌面与开始菜单快捷方式。

### 验证

- 单元测试 **158/158** 通过（`npm test`）
- 端到端检查 **125/125** 通过（`npm run test:e2e`）

### 安装

下载下方 `DiffStudio-Setup-0.1.0.exe` 运行即可，仅支持 Windows x64。

### 已知限制

- 安装包未做代码签名，首次运行可能出现 SmartScreen 提示。
- 暂无 macOS / Linux 构建。

### 校验值

```
SHA256  DiffStudio-Setup-0.1.0.exe  587F4CFC91F2A099F2F2E0A9450CCD8F49364B82DEB567D0A00912A058082E8F
```
