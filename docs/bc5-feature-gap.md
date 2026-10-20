# DiffStudio 与 Beyond Compare 5 的功能差距（第三轮复核）

对比基准：`C:\Program Files\Beyond Compare 5`（`BCompare.exe` 与 `BCompare.chm`）。
对比对象：`0.1.1` 分支（`4ffd5b4`）。
复核方法：对 `src/`、`main.js`、`preload.js` 做关键词扫描，并对每条命中人工甄别，
排除变量名、i18n 文案、扩展名列表造成的误报。

> 本轮修正了上一版文档的三处错误：重复编号、把已实现的「镜像同步」记为缺失、
> 把已实现的「语法高亮」同时列为已实现和缺失。

## 一、已实现（经代码与测试双重核实）

| 能力 | 模块 | 核实方式 |
| --- | --- | --- |
| 压缩包当文件夹比较 | `core/archive.js` | zip / tar / tgz / gz 解压后按目录比较 |
| 文件夹三路合并 | `core/folderMerge.js` + `views/folderMerge.js` | 冲突不自动覆盖，支持撤销 |
| 文件夹镜像同步 | `core/folderPatch.js`（`mode: 'mirror'`） | 目标侧独有文件删除，使两侧一致 |
| 文件操作 | `main.js` + `core/fileOps.js` | 重命名 / 新建目录 / 改时间 / 移动 |
| 查找文件内文本 | `core/search.js` + `views/folderCompare.js` | 正则 / 全字 / 区分大小写，查找栏已接入 UI |
| 文件夹「不重要文件」筛选 | `core/unimportant.js` 的 `isUnimportantPath` | 按相对路径正则隐藏条目，不改变比较结果 |
| 重要 / 不重要规则 | `core/unimportant.js` | 差异降级为「不重要」，导航跳过 |
| 替换规则 | `core/replacement.js` | 比较前改写，文件不动，显示走原文 |
| 表格列规则 | `core/columnRules.js` | ignore / case / trim / numeric / regex |
| 语法高亮 | `core/syntax.js` | 9 种语言，与行内差异底纹共存 |

## 二、仍然缺失（扫描命中为 0，或命中经甄别为误报）

| 能力 | 扫描关键词 | 结论 |
| --- | --- | --- |
| 自定义文件格式 | `fileFormat` / `customFormat` | 无格式插件体系 |
| 多工作表（xlsx） | `sheet` | 命中仅为 zip 扩展名列表，不解析 Sheet |
| 注册表比较 | `registry` | 无独立会话类型 |
| 媒体比较 | `media compare` | 无波形 / 视频比较 |
| 版本比较 | `version compare` | 无文件版本信息比较 |
| 远程 / 云存储 | `ftp` / `sftp` / `s3` / `webdav` | 命中全部为 i18n 文案误报，仅本地文件系统 |
| 脚本引擎 | `scripting` / `.bcs` | 无脚本 API |
| 打印 | `print(` | 只能导出 HTML 报告 |
| 深色主题 | `darkTheme` | 仅浅色主题 |
| Shell 扩展 | `shellExt` | 无资源管理器右键入口 |
| 复制后校验 | `verifyAfterCopy` | 复制后不比对内容 |

## 三、已实现但功能受限（打磨项，不是功能缺失）

| 能力 | 现状 |
| --- | --- |
| 压缩包格式 | 仅 zip / tar / tgz / gz，无 rar / 7z / xz / bz2 |
| 压缩包内文件查看 | 双击仍解压到临时目录，未做虚拟文件系统 |
| 表格比较 | 仅 CSV，不支持多工作表 xlsx |

## 四、会话类型对照

| BC5 | DiffStudio |
| --- | --- |
| 文本比较 | ✅ |
| 十六进制比较 | ✅ |
| 文件夹比较 | ✅ |
| 文件夹同步（含镜像） | ✅ |
| 文件夹合并（三路） | ✅ |
| 文本合并（三路） | ✅ |
| 文本补丁 | ✅ |
| 图片比较 | ✅ |
| 表格比较 | ✅（仅 CSV） |
| 注册表比较 | ❌ |
| 媒体比较 | ❌ |
| 版本比较 | ❌ |

**会话类型：9 / 11。**

## 五、测试基线

| 套件 | 数量 |
| --- | --- |
| 单元测试（`npm test`） | 348 |
| E2E（`npm run test:e2e`） | 125 |
| P0 专项（`npm run test:p0`） | 28 |
| UI 专项（不重要 / 替换 / 列规则 / 语法高亮） | 7 / 9 / 6 / 10 |
| 文件夹筛选专项（`npm run test:folder-ui`） | 18 |

## 六、结论

- 规则/格式体系（不重要、替换、列规则、语法高亮）已补齐，与 BC5 的差距主要在
  **自定义格式插件**这一层，属于架构级投入。
- 剩余最大空白是 **远程/云存储** 与 **脚本引擎**，两者都要求把"本地文件系统"抽象成
  可插拔层，改动面大，不宜零散实现。
- 「不重要文件筛选」与「查找的正则 / 全字 / 大小写」已接入文件夹视图，本轮收尾完成。
