# 点睛设计（Dianjing）

AI 驱动的设计编辑器：打开与编辑 `.fig` / `.pen` 设计文件，内置 pi 设计助手——对话驱动画布操作、图像生成、可扩展技能，以 Windows 桌面应用（Electron）形态交付。

> 本项目基于 [OpenPencil](https://github.com/open-pencil/open-pencil)（MIT）fork 自主演进，仓库 = [another-momo/dianjing](https://github.com/another-momo/dianjing)。

## 功能

- **设计编辑**：打开 `.fig` / `.pen`，矢量排版、组件、样式全量画布能力（承自上游）
- **pi 设计助手**：对话改图——render 工具链 + studio 工作流/风格资产（workflows/profiles/references 按需加载）
- **图像生成**：多 provider 生图，设置面板自助配置 API key（凭据本机落盘）
- **技能系统**：内置 layer-splitting 等 studio skill，`/skill:` 显式唤起；chips 触发
- **桌面形态**：Electron Windows 应用，自动化桥 + pi-backend sidecar 随主进程编排

## 安装

Windows 安装包由 electron-builder 产出（`Dianjing-Setup-<version>.exe`，`bun run package:win` 本地打包）；正式发布渠道（GitHub Releases / updater）随发版策略上线。

## 开发

```sh
bun install
bun run dev
```

仓内协作向导（仓库地图 / zone 纪律 / 提交门禁）见 [AGENTS.md](AGENTS.md)。

## License

[MIT](LICENSE)——保留上游 OpenPencil 版权声明。
