# 讲课台鸿蒙版

工程面向 HarmonyOS 5.0（API 12）及以上。应用使用系统 ArkWeb 呈现安装包自带的界面。阅读 PDF、批注、扫描页 OCR 和保存 Word 可以离线使用。DeepSeek 问答和保存飞书时，应用通过系统网络接口连接相应平台，使用「设置」中填写的凭据。

## 安装到自己的平板

1. 在电脑安装 DevEco Studio，解压工程包并打开其中的 `harmony` 目录。工程包已经附带界面、样书和识字模型。若从 Git 获取源码，先在仓库根目录运行 `npm ci` 和 `npm run build:harmony`。[华为下载中心](https://developer.huawei.com/consumer/cn/download/)
2. 在平板开启开发者选项和 USB 调试，用数据线连接电脑。在平板上允许该电脑调试。[华为真机安装说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs/app-debugging-faq-0005/)
3. 在 DevEco Studio 选择平板，进入 `File → Project Structure → Project → Signing Configs`。勾选 `Automatically generate signature` 和 `Support HarmonyOS`，按提示登录华为账号。点击运行，DevEco Studio 会构建、签名并安装 HAP。[华为调试签名说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides-V13/ide-signing-V13/)

使用 DevEco Studio 自带的 SDK 编译。工程的 `compatibleSdkVersion` 是 5.0.0(12)，保留该值可让支持的早期 HarmonyOS 5 平板安装。签名会修改本地构建配置，证书和本地签名配置应保存在个人工作副本中。

## 使用方式

- 点「导入 PDF」打开系统文件选择器。课本、批注和问答保存在应用空间。
- 点「设置」填写 DeepSeek 凭据，展开「飞书云文档 → 如何接入飞书」查看云文档授权步骤。
- 用「问答录 → 保存 Word」选择保存在平板上的位置。

工程 ZIP 用于在 DevEco Studio 构建。个人试用使用设备调试签名；如果要像应用市场里的普通应用一样下载，可通过 AppGallery Connect 的开放式测试向指定用户分发。[华为开放式测试](https://developer.huawei.com/consumer/cn/agconnect/open-test)
