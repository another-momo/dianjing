# 点睛（Dianjing）安装说明

> 随 GitHub Release / workflow artifact 分发。当前版本未购买代码签名证书：
> Windows 走 SmartScreen 放行、macOS 走 Gatekeeper 放行——首次安装各需一次
> 手动确认，之后正常使用。

## Windows（Dianjing-Setup-x.y.z.exe）

1. 下载 `Dianjing-Setup-x.y.z.exe`，双击运行。
2. SmartScreen 拦截（蓝色「Windows 已保护你的电脑」）：
   点 **「更多信息」** → **「仍要运行」**。
   > 截图占位：SmartScreen 拦截 → 更多信息 → 仍要运行（3 张）
3. 安装向导：可选安装目录，等待进度条完成。
4. 卸载：向导会询问是否删除用户数据，**默认「否」保留**
   （`%APPDATA%/Dianjing` 内含 AI 凭据/会话/工作区，删前确认）。

## macOS（Dianjing-x.y.z-arm64.dmg / Dianjing-x.y.z-x64.dmg）

选架构：Apple 芯片（M 系列）→ arm64；Intel → x64。
（Apple 菜单 → 关于本机 → 芯片/处理器一栏可辨。）

1. 下载对应 dmg，双击挂载，把 **Dianjing** 拖进 **Applications**。
2. 首次打开会被 Gatekeeper 拦截（应用无 Apple 开发者证书签名），按系统
   版本二选一：

   **macOS 14 及以下**：在 Applications 里 **右键（或 Control+点按）
   Dianjing → 打开**，弹窗中点 **「打开」**。
   > 截图占位：右键菜单 → 确认打开弹窗（2 张）

   **macOS 15 Sequoia / macOS 26 Tahoe**：右键绕过已取消。双击被拦后：
   **系统设置 → 隐私与安全性 → 页面底部「仍要打开」**（拦截后约一小时
   内出现）→ 输入管理员密码确认。
   > 截图占位：拦截弹窗 → 隐私与安全性「仍要打开」按钮 → 密码确认（3 张）

3. 放行一次后，双击正常启动。

### 若提示「已损坏，无法打开」

ad-hoc 签名的 .app 内容被改动过会触发此报错。正确包不应出现——请删除后
重新从 Release 下载；仍复现请提 issue。

## 数据位置（两平台一致）

- Windows：`%APPDATA%\Dianjing`
- macOS：`~/Library/Application Support/Dianjing`

AI 凭据、会话与工作区都在其中；卸载默认保留。
