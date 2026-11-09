# 纸质作答答案提取人工评测

本工具衡量视觉模型从**已在系统打印试卷上作答的照片**中提取题目标识和学生答案的能力，不评价 AI 判分或人工复核质量。应用先提取、再逐题建议判分，最终必须由家长复核确认；当前方案无需 Python OCR 服务。

## 样本与隐私

正式人工评测集至少包含 **60 道题**，覆盖数学、语文、英语，以及清晰、潦草、涂改、阴影等不同书写和拍摄质量。记录样本来源、学科、书写质量与模型版本，避免只挑清晰或已调优的题目；同一题的重复照片不得当作独立题目扩大样本数。CI 仅使用合成图片和固定模型响应，不能代替真实样本的人工验收。

图片、manifest、人工标注、凭据和报告放在仓库外的私有目录，**不得提交 Git、附件或公开日志**。儿童姓名、学校、学号等应先裁掉或遮挡；在获得必要授权后才交给所选 Provider。调用会把照片和候选题发送给该 Provider，需自行核对其数据政策。本工具不写业务数据库，不读取应用中的账号密钥，不自动创建样本目录；报告也不包含照片、答案全文、Key 或图片绝对路径，但题目和试卷标识仍应视为私有数据。

## Manifest

UTF-8 JSON 顶层为 `samples`，每项代表一张本地 JPEG、PNG 或 WebP（1 字节～20 MiB）；相对图片路径按 manifest 所在目录解析。`paperId` 是人工标识，无需连接业务数据库；`questions` 是该试卷候选题（每页 1～100 题），`expected` 是这页实际可见题目的人工标准标注。期望题号必须存在于候选题中且不能重复；候选题 ID、短码、连续题号各自唯一。

以下只展示合成文字，图片应由调用者在私有目录提供：

```json
{
  "samples": [
    {
      "image": "photos/synthetic-page-1.png",
      "paperId": "synthetic-math-paper",
      "subject": "数学",
      "handwriting": "清晰",
      "language": "zh",
      "questions": [
        { "id": "synthetic-q1", "displayNumber": 1, "sourceShortId": "SYN001", "questionText": "合成题：计算 3 + 4。" }
      ],
      "expected": [
        { "questionId": "synthetic-q1", "normalizedAnswer": "7" }
      ]
    }
  ]
}
```

`language` 可选 `zh`（默认）或 `en`；`subject`、`handwriting` 可用于人工分层审阅。未作答的标准答案写空字符串。标准化只执行 Unicode NFC、首尾去空白、连续空白合并成一个空格；不忽略大小写、标点或数学符号，也不把语义等价答案当成完全一致。应标注学生**实际书写内容**，而非试题标准解答。

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

两项指标均以 manifest 中人工标注的期望题数为分母：

- **题目匹配正确率** = 找到与人工期望题 ID 一致的唯一候选数 / 期望题数。
- **匹配且答案完全一致率** = 匹配正确且标准化学生答案完全一致的题数 / 期望题数。不是仅在已匹配题中计算。

匹配复用应用规则：短码完全一致优先，短码缺失才按连续题号回退；短码/题号冲突、重复匹配和未匹配均不得猜测。漏检算失败；人工应同时检查额外候选，防止错误题号的结果被标成正确标签。报告包含逐题 `matched`/`exact` 布尔结论、计数、比例、模型标识、`sufficientSampleSize` 和推荐目标结果。

**95%** 指推荐 Provider/视觉模型在不少于 60 道代表性客观题上的“匹配且答案完全一致率”产品目标，**不是所有可配置 Provider 的 CI 硬门槛**。低于目标仍生成报告并退出 0，便于比较；不足 60 题时 `sufficientSampleSize=false`，只能作为工具冒烟，不能宣称达到正式验收。未匹配和低置信度答案必须在产品中进入人工复核。

| 退出码 | 含义 |
| --- | --- |
| 0 | 完成并生成报告（不代表达到 95%） |
| 2 | 参数、manifest、图片路径或 Provider 配置无效 |
| 3 | 图片读取、模型调用或输出解析失败，不生成部分报告 |
| 4 | 报告写入失败 |

错误只显示页序和通用原因，不回显 Key、图片、学生答案或上游原始响应。原始评测报告保留在私有目录，公开交付只记录脱敏的样本组成、总数、模型版本和汇总指标。
