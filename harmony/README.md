# 讲课台鸿蒙版

工程面向 HarmonyOS 5.0（API 12）及以上。应用使用系统 ArkWeb 呈现安装包自带的界面。阅读 PDF、批注、扫描页 OCR 和保存 Word 可以离线使用。DeepSeek 问答和保存飞书时，应用通过系统网络接口连接相应平台，使用「设置」中填写的凭据。

## 安装到自己的平板

1. 在电脑安装 DevEco Studio，把工程包解压到不含中文的路径，例如 `D:\LectureDeskBuild`，然后打开其中的 `harmony` 目录。工程包已经附带界面、样书和识字模型。若从 Git 获取源码，先在仓库根目录运行 `npm ci` 和 `npm run build:harmony`。[华为下载中心](https://developer.huawei.com/consumer/cn/download/)
2. 在平板开启开发者选项和 USB 调试，用数据线连接电脑。在平板上允许该电脑调试。[华为真机安装说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs/app-debugging-faq-0005/)
3. 在 DevEco Studio 选择平板，进入 `File → Project Structure → Project → Signing Configs`。勾选 `Automatically generate signature` 和 `Support HarmonyOS`，登录已完成开发者实名认证的华为账号。点击运行，DevEco Studio 会构建、签名并安装 HAP。[华为调试签名说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides-V13/ide-signing-V13/) [开发者实名认证说明](https://developer.huawei.com/consumer/cn/doc/app/hdc-verification-introduction-0000002752607793/)

使用 DevEco Studio 自带的 SDK 编译。工程的 `compatibleSdkVersion` 是 5.0.0(12)，保留该值可让支持的早期 HarmonyOS 5 平板安装。签名会修改本地构建配置，证书和本地签名配置应保存在个人工作副本中。

## 使用方式

- 横屏拖动中间的分隔线调整课本和问答的宽度，竖屏通过顶部按钮切换。
- 点「导入 PDF」打开系统文件选择器。课本、批注和问答保存在应用空间。
- 导入或从书架打开的课本会出现在标签栏。切换时记住每本课本的阅读位置和缩放，关闭标签后还能从书架重新打开。
- 询问区点「语音」可用鸿蒙本机普通话听写。首次需要麦克风权限，识别结果进入可编辑的提问草稿。
- 横屏点顶部「白板」后，右栏上方是白板、下方是讲解师。上下拖动横向分隔线调整高度，关闭后讲解师恢复整个右栏。左侧课本仍能继续阅读和批注。
- 白板笔迹保存在本机。「设置 → 界面主题」可切换暖纸、雾蓝和深蓝灰。
- 用手指上下滚动连续页面，用触控笔在露出的任意一页批注。点击画笔或橡皮可以调笔触。默认关闭「允许手指书写」，以便手指滚动。
- 点批注栏的「全屏」可收起左侧书名和标签栏，给 PDF 多留空间。右侧白板和讲解师仍可操作。批注、翻页、缩放和导入保存继续可用，「退出全屏」恢复书名和标签栏。
- 「保存 PDF」可把所有页面的批注随 PDF 保存，也可上传到设置的飞书云盘文件夹。应用内单次云盘上传上限为 20 MB，飞书应用需开通 `drive:file:upload`。
- 点「设置」填写 DeepSeek 凭据，展开「飞书云文档 → 如何接入飞书」查看云文档授权步骤。
- 用「问答录 → 保存 Word」选择保存在平板上的位置。

## 分享给其他鸿蒙用户

工程 ZIP 可在 DevEco Studio 打开。调试签名的 HAP 可通过 USB 安装到签名覆盖的设备。

在 DevEco Studio 26.0 或更高版本打开工程，选择 `Build → Build Hap(s)/APP(s) → Build APP(s)` 生成 Release APP，然后选择 `Build → Upload Product → Testing Only`。登录已实名的华为开发者账号，关联或创建讲课台应用，并在上传时使用云管理证书签名。[华为发布应用说明](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/ide-publish-app/)

在 AppGallery Connect 的应用测试中创建邀请测试，勾选生成分享链接。审核通过后即可把邀请链接发给其他华为平板用户。[华为邀请测试说明](https://developer.huawei.com/consumer/cn/doc/app/agc-help-appgallery-release-testapp-0000002258174266/)
