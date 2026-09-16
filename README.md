# 点睛设计（Dianjing）

**基于 OpenPencil 矢量画布与 pi agent 的设计工作台**——把 AI 生图的像素操作能力，装进类 Figma 的矢量排版能力里；同一块画布，人与 AI 协作编辑。

- **双基座**：OpenPencil 矢量画布（原生打开 `.fig` / `.pen`，组件/样式/排版全量能力）+ pi agent 设计助手（对话驱动画布，render 工具链实时落图）
- **像素 × 矢量**：AI 生图产出直接成为设计素材，与矢量排版无缝混排——生成即设计
- **人 + AI 协作**：自然语言下达意图，agent 经工具链改图落画布，人随时接管精修
- **可扩展**：workflow/profile 自定义工作流与风格资产（studio 声明式配置）；agent skill 技能系统（`/skill:` 唤起，内置 layer-splitting 等）

> 基于 [OpenPencil](https://github.com/open-pencil/open-pencil)（MIT）fork 自主演进，仓库 = [another-momo/dianjing](https://github.com/another-momo/dianjing)。

## 安装

Windows 安装包（`Dianjing-Setup-<version>.exe`）：`bun run package:win` 本地打包产出。

## 开发

```sh
bun install
bun run dev
```

仓内协作向导（仓库地图 / zone 纪律 / 提交门禁）见 [AGENTS.md](AGENTS.md)。

## License

[MIT](LICENSE)。
