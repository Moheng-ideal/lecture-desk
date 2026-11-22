# 讲课台

讲课台在浏览器里把 PDF 和 DeepSeek 讲解放在同一工作区。横屏时左侧阅读和批注，右侧提问。窄屏通过顶部的「课本」和「问答」切换。

HarmonyOS 5.0 及以上的平板可以使用 [鸿蒙应用工程及真机签名说明](harmony/README.md)。

## 华为平板使用

1. 用华为浏览器打开讲课台。横屏后点「导入 PDF」，在系统文件选择器中选择课本。可通过华为浏览器菜单将此页面添加至桌面。
2. 选择「批注笔」或「荧光笔」，用 M-Pencil 书写。可调颜色和粗细，用橡皮擦除整笔，或撤销及重做。默认触控笔书写，手指拖动滚动。若浏览器将笔识别为手指，在设置中开启「允许手指书写」，用「阅读」模式滚动。
3. 点「选文」，在课本上拖框，再点「引用选文」。也可切换到「系统选区」用浏览器长按选取。扫描页会在设备内运行中英文 OCR。点「讲解本页」直接引用整页并提问，点「下一页开讲」继续。
4. 完整回答会自动收入「问答录」，可以按课本折叠查看。点「仅选本书」可以整本导出，也可以逐条勾选。问答录可保存为 Word 或可编辑的飞书云文档。

浏览器在当前设备、当前网址保存课本、页码、批注和问答。改用另一台设备或清除站点数据会使用不同的书架。DeepSeek 只收到问题、选取的摘录和此书近期对话，不会收到整个 PDF 或批注。飞书会收到你勾选的问答录。

## 配置连接

- **DeepSeek**。在应用、HTTPS 版或当前电脑的 `localhost` 打开「设置」，填入 DeepSeek API Key。密钥加密保存在本机，重新打开后自动读取。清空密钥并应用设置即可移除。 [DeepSeek 平台](https://platform.deepseek.com/)
- **飞书**。在 [飞书开放平台](https://open.feishu.cn/app) 创建企业自建应用，开通「创建及编辑新版文档」权限 `docx:document` 并发布应用。让应用具备目标飞书云空间文件夹的可编辑权限，在「设置」中填入 App ID、App Secret 及 `/drive/folder/…` 文件夹链接。保存成功后，可以打开返回的云文档链接。若提示部分写入失败，保持原有标题和勾选项，再点「继续保存」。

## 本机或同一 Wi-Fi 运行

需要 Node.js 22.12 或更高版本。

```powershell
npm ci
npm run build
npm start
```

电脑访问 `http://127.0.0.1:8787`。要让华为平板通过同一 Wi-Fi 访问，将 [环境变量样例](.env.example) 复制为项目目录下的 `.env`。设置 `TEACH_HOST=0.0.0.0`，填写至少 12 个字符的 `TEACH_PASS`，并把 DeepSeek 和飞书凭据放在电脑的 `.env` 中。重新运行 `npm start`，在平板上访问终端打印的局域网地址，并输入访问口令。局域网 HTTP 用于可信网络。

```powershell
npm test
git log --oneline
git tag --list
```

通过 Git 提交并打版本标签。`.env`、编译产物、课本和个人问答数据均不进入版本库。

Android APK 的「语音」使用应用内离线普通话识别。首次使用需要授予麦克风权限，并等待应用解压随包附带的 Vosk 模型。Android 构建脚本会下载并校验固定版本的识别库和模型，缓存于 `.sites-runtime/voice-sdk`。 [Vosk 模型与许可证](https://alphacephei.com/vosk/models)

工作流参考 [忘砚讲台](https://github.com/queyue-jingge/forgotten-inkstone-pub)。内置示例课本为原创，用 [Noto Sans SC](https://github.com/google/fonts/tree/main/ofl/notosanssc) 字体生成。样书和快捷方式图标可以用 `scripts/sample.py` 重新生成，参数为 Noto Sans SC TrueType 字体路径，需要 ReportLab、Pillow 和 FontTools。
