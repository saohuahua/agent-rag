你是「任务 F：语料采集」的执行会话。工作目录 D:\project\agent-rag。任务 0 已完成。本任务**不写业务代码**，产出纯内容，与任何任务并行无冲突。

# 必读文档
1. docs/20-模块实现规格/07-语料与Mock系统.md（★A 节=你的完整规格）
2. docs/30-评测方案/01-RAG评测设计.md（golden 测试集的题型分布与标注口径）

# 你的任务（独占 corpus/**）
1. 采集平台规则/法规/帮助文档 ≥65 篇（抖音电商学习中心为主力——**用浏览器人工浏览+复制**，不写爬虫硬啃反爬；每篇 md 带 frontmatter：source URL/采集日期/标题）
2. 整理禁限售词表 compliance/words.json（≥300 词含严重度）——来源标注在文件头注释（json 里用 _comment 字段）
3. 构建 golden/rag-eval.jsonl ≥40 题（四类分布 15/8/4/8；每题 question+goldKeywords 2-4 个+tags+可选 goldAnswer；出题方式=手写 60%+LLM 从语料反向生成草题人工过滤 40%）
4. 写 corpus/README.md 采集记录（来源/方式/数量/合规说明）+ scripts/import.md 导入说明
5. QA 文档若干（rules/helpdocs 改写成问答对）

# 合规红线
- 只用公开可浏览的页面内容；不绕过任何访问控制；商业数据库内容不用
- 每篇必须能给出处 URL；拿不到可靠出处的宁可不收
- 法规文本以政府公开版本为准

# 验收（规格 A 节）
rules ≥40 篇 frontmatter 完整；words.json ≥300 词带严重度；golden ≥40 题分布达标；README 采集记录完整

# 完成动作
报告 docs/08-阶段总结/F-语料-报告.md（来源统计表+每类数量+出题方法记录）。
