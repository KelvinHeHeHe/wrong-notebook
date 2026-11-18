# 纸质作答答案提取人工评测

本工具衡量视觉模型从**已在系统打印试卷上作答的照片**中提取题目标识和学生答案的能力，不评价 AI 判分或人工复核质量。应用先提取、再逐题建议判分，最终必须由家长复核确认；当前方案无需 Python OCR 服务。

## 样本与隐私

正式人工评测集至少包含 **60 道题**，覆盖数学、语文、英语，以及清晰、潦草、涂改、阴影等不同书写和拍摄质量。记录样本来源、学科、书写质量与模型版本，避免只挑清晰或已调优的题目；同一题的重复照片不得当作独立题目扩大样本数。CI 仅使用合成图片和固定模型响应，不能代替真实样本的人工验收。

图片、manifest、人工标注、凭据和报告放在仓库外的私有目录，**不得提交 Git、附件或公开日志**。儿童姓名、学校、学号等应先裁掉或遮挡；在获得必要授权后才交给所选 Provider。调用会把照片和候选题发送给该 Provider，需自行核对其数据政策。本工具不写业务数据库，不读取应用中的账号密钥，不自动创建样本目录；报告也不包含照片、答案全文、Key 或图片绝对路径，但题目和试卷标识仍应视为私有数据。

先在仓库和所有 Git 工作树之外准备目录；工具不会自动复制或删除照片：

```text
/private/exam-evaluation/
└── photos/
    ├── page-001.jpg
    └── page-002.webp
```

在源码目录启动仅监听 `127.0.0.1` 的标注器。必须保留 `--silent`，否则 npm 会把私有绝对路径回显到终端日志：

```bash
npm run --silent eval:label -- --dataset /private/exam-evaluation
```

用终端打印的一次性链接打开浏览器，逐页填写年级、学科、书写质量、拍摄质量、候选题和学生实际答案，再在原照片上为每个答案框选 1～4 个区域。草稿以 `0600` 权限自动保存在同一私有目录；两个标签页同时修改时，后保存者会进入只读冲突状态，避免静默覆盖。全部页面通过完成度检查后显式导出 `manifest.json`，既有清单会备份为 `manifest.previous.json`。标注器不读取 `.env`、不调用模型，也不写入 SQLite。

## Manifest

UTF-8 JSON 顶层为 `samples`，每项代表一张本地 JPEG、PNG 或 WebP（1 字节～20 MiB）；相对图片路径按 manifest 所在目录解析。`paperId` 是人工标识，无需连接业务数据库；`questions` 是该试卷候选题（每页 1～100 题），`expected` 是这页实际可见题目的人工标准标注。每个期望答案必须附带独立人工标注的 `regions`，用来确认模型究竟识别了哪道题的书写；不能从模型声称的短码、题号或 ID 反推人工归属。期望题号必须存在于候选题中且不能重复；候选题 ID、短码、连续题号各自唯一。

以下只展示合成文字，图片应由调用者在私有目录提供：

```json
{
  "samples": [
    {
      "image": "photos/synthetic-page-1.png",
      "paperId": "synthetic-math-paper",
      "grade": 3,
      "subject": "数学",
      "handwriting": "清晰",
      "photoQuality": "清晰",
      "language": "zh",
      "questions": [
        { "id": "synthetic-q1", "displayNumber": 1, "sourceShortId": "SYN001", "questionText": "合成题：计算 3 + 4。" }
      ],
      "expected": [
        { "questionId": "synthetic-q1", "normalizedAnswer": "7", "questionType": "calculation", "regions": [{ "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.1 }] }
      ]
    }
  ]
}
```

`regions` 必填 1～4 个框：`x`、`y` 是左上角位置，`width`、`height` 必须为正，均为有限数且完整位于 0～1 内。人工应在与输入照片相同的方向和裁切范围内，框紧实际书写答案或明确空白的作答区域，不要框整道题或整页；多行/分散作答可标多个框。缺少区域的旧 manifest 必须补标后再评测，脚本不会退回依赖模型题号的旧算法。

正式清单要求 `grade` 为 1～6，`subject` 为数学/语文/英语，`handwriting` 为清晰/潦草/涂改/混合，`photoQuality` 为清晰/阴影/倾斜/模糊/混合；`questionType` 使用应用既有的 10 个标准题型 key。`language` 可选 `zh`（默认）或 `en`。未作答的标准答案写空字符串。标准化只执行 Unicode NFC、首尾去空白、连续空白合并成一个空格；不忽略大小写、标点或数学符号，也不把语义等价答案当成完全一致。应标注学生**实际书写内容**，而非试题标准解答。

## 配置与运行

在已安装项目开发依赖的源码目录运行，Node.js 22 及以上。复用现有 `BaseAIProvider.extractExamPageAnswers`、输出解析器及确定性匹配函数，不复制提取提示词，也不硬编码 `max_tokens`；OpenAI 兼容渠道继续使用现有模型输出限制与降级机制。

从私有终端环境设置 `EVALUATION_API_KEY`（不要把真实 Key 放到命令示例、manifest 或版本库），并显式指定 Provider 和模型：

```bash
export EVALUATION_PROVIDER=openai
export EVALUATION_MODEL='<待评测的视觉模型>'
# 可选：OpenAI 兼容接口，含 /v1；也用于其他 Provider 的自定义地址
export EVALUATION_BASE_URL='https://api.openai.com/v1'
node --conditions=react-server scripts/evaluate-exam-answer-extraction.mjs \
  --manifest /private/path/exam-evaluation/manifest.json \
  --output /private/path/exam-evaluation/report-new.json
```

支持 `openai`、`gemini`、`anthropic`、`azure`；均使用 `EVALUATION_API_KEY` 与 `EVALUATION_MODEL`。Azure 还需将 `EVALUATION_BASE_URL` 设为资源 endpoint，并设置 `EVALUATION_AZURE_DEPLOYMENT`，可选 `EVALUATION_AZURE_API_VERSION`。原生 Gemini/Anthropic 默认使用现有适配器的官方地址；国产 OpenAI 兼容渠道选 `openai` 并填写其地址与视觉模型。脚本不加载 `.env`，使用调用者显式导出的环境变量；`--conditions=react-server` 供独立 Node 进程加载项目服务端模块。

输出路径必须位于仓库外，父目录须已存在；工具拒绝覆盖已有报告，并以 `0600` 权限创建新 JSON。所有输入先校验，再开始逐页调用。不要用真实儿童数据运行 CI；没有真实配置时可用 `npx vitest run src/__tests__/unit/exam-answer-evaluation.test.ts` 验证合成样本与回环 Mock AI。

## 指标与退出码

先按照片位置独立确认“这个模型候选属于哪条人工标注”，再评价题目匹配：

1. 对每个人工答案与模型候选，计算所有人工框与候选框两两之间的 IoU（交集面积 / 并集面积），取最大值作为区域对应分数。
2. 只有分数 **≥0.50** 且双方**互为唯一最高分**时配成一对；按 `1e-9` 容差处理同分。此步不读取候选短码、题号、答案文字或数组顺序，也不让同一个候选计入两道题。缺框、漏提、同分、多个标注竞争同一候选等无法独立确定的情况记为失败，不猜测替补配对。
3. 对独立配对成功的候选，复用应用的确定性规则计算模型实际匹配到的试卷题 ID，再与人工 `questionId` 比较。短码完全一致优先，短码缺失才按连续题号回退；短码/题号冲突、重复匹配和未匹配均不能算正确。

两项指标均以 **全部人工标注的期望答案数** 为分母：

- **题目匹配正确率** = 独立区域配对成功，且模型实际匹配的题 ID 等于人工归属的题数 / 期望答案数。
- **匹配且答案完全一致率** = 上述题目匹配正确，且该同一候选的标准化学生答案完全一致的题数 / 期望答案数。不是仅在已匹配题中计算。

例如两题的候选都提取到了，但短码和题号互换，即使答案文字都对，两个指标也都是 0%；4 题中 1 题完全正确、1 题匹配对但文字错、1 题匹配到别题、1 题漏提，指标为 50% 和 25%。框位置本身不足以区分的结果会保守记错，因此应同时审阅额外候选和人工框质量；这两项指标包含区域可定位性，不是独立的 OCR 字符准确率。

报告 **version=3**，保留 `pairing.method=mutual-best-region-iou`、`pairing.minIoU=0.5`、逐题 `matched`/`exact` 布尔结论、计数、比例、模型标识和 `sufficientSampleSize`，并按年级、学科、题型、书写质量和拍摄质量输出固定顺序的完整分层汇总；未覆盖的桶仍会出现，计数与准确率均为 0。旧 manifest 缺少分层字段或包含旧版自由文本学科/书写质量时仍可评测并归入 `unlabeled`；新标注器导出时要求分层字段完整。不写入框坐标、照片或学生答案全文。version=1 只按模型标识检查候选存在性，version=2 没有完整分层，两者均不应与 v3 的分层结论直接混用。

**95%** 指推荐 Provider/视觉模型在不少于 60 道代表性客观题上的“匹配且答案完全一致率”产品目标，**不是所有可配置 Provider 的 CI 硬门槛**。低于目标仍生成报告并退出 0，便于比较；不足 60 题时 `sufficientSampleSize=false`，只能作为工具冒烟，不能宣称达到正式验收。未匹配和低置信度答案必须在产品中进入人工复核。

| 退出码 | 含义 |
| --- | --- |
| 0 | 完成并生成报告（不代表达到 95%） |
| 2 | 参数、manifest、图片路径或 Provider 配置无效 |
| 3 | 图片读取、模型调用或输出解析失败，不生成部分报告 |
| 4 | 报告写入失败 |

错误只显示页序和通用原因，不回显 Key、图片、学生答案或上游原始响应。原始评测报告保留在私有目录，公开交付只记录脱敏的样本组成、总数、模型版本和汇总指标。
