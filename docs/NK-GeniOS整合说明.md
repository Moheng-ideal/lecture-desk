# NK-GeniOS + GLM-4V 视觉整合说明（0.8.6 基线）

> 整理时间：2026-11-26
> 基线：v0.8.6（提交 046c841）
> 目的：让讲课台在保持原有 DeepSeek 能力的同时，可使用南开 NK-GeniOS 智能体（校园免费）和智谱 GLM-4V-Flash（免费视觉）完成文字讲解与截图读图。

---

## 一、行为变化（用户可见）

| 场景 | 之前 | 现在 |
|---|---|---|
| 纯文字提问 | DeepSeek | **NK-GeniOS**（密钥不以 `sk-` 开头时自动路由）；`sk-` 开头的 DeepSeek 密钥仍走 DeepSeek |
| 带截图提问 + 填了视觉模型 Key | DeepSeek 多模态 | **智谱 GLM-4V-Flash** 直接识图（能看公式、图表） |
| 带截图提问 + 未填视觉 Key | DeepSeek 多模态 | **本机 OCR** 转文字后交给 NK-GeniOS（仅文字，公式/图表会丢失） |
| 设置页 | 只有 DeepSeek Key | 多一行「视觉模型 API Key（可选）」 |

---

## 二、改动文件清单

| 文件 | 改动 |
|---|---|
| `server/api.mjs` | 新增 `GENIOS`/`ZHIPU` 常量、`ocrImages()`、`askGenIOS()`（HiAgent SSE → DeepSeek SSE 转换）、`askVision()`（智谱适配）；`ask()` 增加 `visionKey` 参数与分派逻辑；`handleApi()` 读取 `credentials.vision` / `VISION_API_KEY`，`/api/config` 返回 `vision` 字段 |
| `server/ocr.mjs` | 新增：Windows 自带 OCR 封装（base64 → 临时文件 → PowerShell → 文字） |
| `server/ocr.ps1` | 新增：WinRT `Windows.Media.Ocr` 脚本（英文脚本避免编码问题） |
| `server/upload_helper.py` | 新增（备用）：平台 up-upload 脚本，待网络策略开通后使用 |
| `src/api.js` | `settings` 增加 `vision` 字段，请求时传给服务端 |
| `src/main.js` | 加载/保存视觉 Key；连接状态显示「NK-GeniOS + 视觉模型 · 已配置」 |
| `index.html` | 密钥框改名 `DeepSeek / NK-GeniOS API Key`；新增「视觉模型 API Key（可选）」 |
| `android/src/cn/lecturedesk/android/DeskNetwork.java` | 白名单放行 `coze.nankai.edu.cn/api/proxy/api/v1/*`（create_conversation、chat_query_v2）和 `open.bigmodel.cn/api/paas/v4/chat/completions`；NK-GeniOS 请求使用 `Apikey` 头（其余仍为 `Authorization`） |
| `scripts/build-android.ps1` | 适配 Windows PowerShell 5.1（`GetRelativePath` 替换、`Invoke-Native` 检查退出码、程序集加载）；assets 缺失时用 `node scripts/harmony.mjs android` 生成 |
| `test/api.test.mjs` | 测试环境改用 `sk-test-key` 走 DeepSeek 路径，新增 `VISION_API_KEY` 让截图用例走视觉分支 |
| `test/harmony.test.mjs` | 测试密钥改为 `sk-fixture`，匹配新的分派逻辑 |

---

## 三、配置方法

在应用「设置」中：

| 输入框 | 填什么 |
|---|---|
| DeepSeek / NK-GeniOS API Key | NK-GeniOS 教学智能体密钥（如 `<NK-GeniOS 教学智能体密钥>`），或 `sk-` 开头的 DeepSeek Key |
| 视觉模型 API Key（可选） | 智谱密钥（如 `90d16792...`），不填则截图走 OCR |

或服务端 `.env`（隐藏凭据，平板端只填访问口令）：

```ini
TEACH_HOST=0.0.0.0
TEACH_PASS=至少12个字符
VISION_API_KEY=智谱密钥
DEEPSEEK_API_KEY=NK-GeniOS密钥
```

---

## 四、已知限制

1. **GLM-4V-Flash 的 `max_tokens` 上限是 1024**（传 4096 会返回 `1210 参数非法`），代码已固定为 1024。
2. **免费视觉模型有限流**：并发个位数，高峰期返回 429，前端提示「请求过于频繁」。
3. **OCR 仅 Windows 可用**：Android 端没有本机 OCR，APK 内截图提问需要填视觉模型 Key，否则提示「请先填写视觉模型 Key」。
4. **NK-GeniOS 图片能力依赖平台**：平台 `QueryExtends.Files` 目前返回「大模型接口调用出错」（平台侧 bug），因此截图路径选择智谱/OCR 绕过。
5. **平台 up-upload 服务网络未开通**：校园网 10.1.x.x 访问 `192.168.160.104:31010` 超时，需学校网络中心放行；`server/upload_helper.py` 已就绪待用。

---

## 五、验证记录（2026-11-26）

- `npm test`：17 项全部通过
- 浏览器版 `http://127.0.0.1:8787`：启动正常，`/api/config` 返回 `vision` 字段
- E2E（`tools/e2e_chat.mjs`）：
  - NK-GeniOS 文字：返回 379 字符讲解，流式正常
  - 智谱视觉：返回「图中文字：识图测试 OK，图形：红色圆形」，识图准确
- Android APK：一次构建通过（8.98 MB，v2+v3 签名），按要求暂不交付打包产物

