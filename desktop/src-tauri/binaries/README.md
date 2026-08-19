# Syncthing Sidecar 二进制文件

本目录用于存放 Syncthing 可执行文件，Tauri 构建时会自动将其打包到安装包中。

## 下载步骤

1. 前往 [Syncthing 官方发布页](https://github.com/syncthing/syncthing/releases/latest)
2. 下载对应平台的压缩包：
   - **macOS ARM (M 系列)**：`syncthing-macos-arm64-v*.zip`
   - **macOS x64 (Intel)**：`syncthing-macos-amd64-v*.zip`
   - **Windows x64**：`syncthing-windows-amd64-v*.zip`
3. 解压后得到可执行文件
4. 将文件重命名为下表对应名称并放入本目录

## 命名规则

Tauri sidecar 要求二进制文件以 **目标平台三元组** 为后缀：

| 平台 | 文件名 |
|------|--------|
| Windows x64 (MSVC) | `syncthing-x86_64-pc-windows-msvc.exe` |
| Windows x64 (GNU)  | `syncthing-x86_64-pc-windows-gnu.exe` |
| macOS x64          | `syncthing-x86_64-apple-darwin` |
| macOS ARM (M 系列) | `syncthing-aarch64-apple-darwin` |
| Linux x64          | `syncthing-x86_64-unknown-linux-gnu` |

> 开发阶段只需放置当前平台对应的文件即可。

## 验证

放置完成后运行：

```bash
# macOS / Linux
cd desktop
npm run tauri:dev:mac

# Windows (PowerShell)
cd desktop
npm run tauri:dev
```

打开 **设置 → 多设备同步**，点击「开启同步」，若显示设备码则说明集成成功。
