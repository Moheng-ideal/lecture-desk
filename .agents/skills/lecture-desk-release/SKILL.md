---
name: lecture-desk-release
description: 发布讲课台 Android／卓易通正式更新。完成新版开发后，将同一份签名 APK 同步到讲课台下载服务器和 GitHub Releases，校验两条应用内更新路径并清理服务器旧包。
---

# 发布讲课台 Android 更新

在讲课台仓库根目录运行以下流程。若从本机其他目录启动，仓库位于 `D:/讲课台/lecture-desk`。远端为 `Moheng-ideal/lecture-desk`，服务器公网下载前缀为 `http://8.141.106.190/lecture-desk/`。仅发布要交付的正式 Android／卓易通版本。处理功能草稿、诊断包或鸿蒙 HAP 时按对应任务的范围执行。

1. 对照 GitHub 最新正式发布、`package.json` 和 `package-lock.json` 确定版本号。更新 `CHANGELOG.md`，应用内更新日志直接读取此文件。README 的服务器和 GitHub 下载链接都指向本次版本。运行 `npm test`，用 `scripts/build-android.ps1` 构建 `release/lecture-desk-android-X.Y.Z.apk`。脚本需要 `-AndroidJar`、`-BuildTools` 和 `-JavaHome`。当前 Windows 环境的 SDK 位于 `.sites-runtime/android-sdk`，Java 位于 `D:/DevEcoStudio/jbr`。
2. 用 `aapt dump badging` 和 `apksigner verify --print-certs` 核对包名 `cn.lecturedesk.android`、版本号、递增的 versionCode 和签名。正式版本用现有发布密钥，证书 SHA-256 为 `c0b12075fd654bdcb5af18af6de0096192beda2cc9da40e611afbccc506c632c`。首次准备发布环境时要恢复原签名文件。构建脚本也可为开发环境创建新密钥，所以签名校验是正式发布的必要步骤。Git 的提交范围只包含本次要发布的项目改动。
3. 用 SSH 已配置的发布别名运行 `python scripts/android-mirror.py stage <APK> --ssh <发布别名>`，上传并公网校验 APK。也可以用 `--ssh <用户>@8.141.106.190 --identity-file <本机密钥路径> --known-hosts <本机主机校验文件>`。在这台电脑上已有对应的 SSH 文件。用 `ssh-keygen -F 8.141.106.190 -f <文件>` 核对主机配置，对照最近成功的部署记录找到使用的密钥。保持主机校验开启。发布脚本只操作 `/srv/lecture-desk-downloads`。
4. 检查 GitHub 当前认证与分支，把要发布的提交和 `vX.Y.Z-android` 标签推送到远端。使用 `gh release create <标签> <APK> --repo Moheng-ideal/lecture-desk --verify-tag --latest --title "讲课台 vX.Y.Z" --notes-file <UTF-8 日志文件>`。若同名 Release 已经存在，先核对提交及资源摘要。重复发布时沿用 SHA-256 相同的成品，已公开的不同摘要使用新版本号。
5. 运行 `python scripts/android-mirror.py publish <APK> --ssh <发布别名>`，或加上第 3 步所用的 SSH 参数。本机如果没有把 GitHub CLI 加入 PATH，加 `--gh .sites-runtime/github-cli/bin/bin/gh.exe`。脚本用已登录的 GitHub CLI 核对 latest 的标签、APK 大小和摘要，并完整下载服务器 APK 查验。随后原子更新服务器 `latest.json`，公网确认版本信息之后才删除服务器较旧的讲课台 APK、对应的旧校验文件及过期的发布临时文件。保留 GitHub 旧 Release、服务器较新版本和未识别文件。若脚本列出其他保留项，可先确认用途，再按用户的清理范围处理。下载目录之外的服务器内容与此发布无关。
6. 核对 GitHub 正式 Release、服务器 `latest.json` 及新 APK 链接，给出版本、两个下载地址和实际清理结果。两端步骤可以用同一份 APK 重跑。如果任何一端检查失败，保留现有线上更新入口与旧包，继续排查并报告卡在哪一步。
