# 本地功能测试任务

你正在为以下开源项目进行隔离工作区内的本地功能测试。请在工作目录 D:\digquant\数分项目\HotChasing\runner\workspace\6806f695-ce4a-4d98-aa55-bed3c9816d7b\repo 内执行操作，**不要绕过权限限制**。

## 任务
- 仓库：ZhuLinsen/alphasift
- 固定 Commit：9f522747caafd3c0b1ddb7e14d5cf44c8580b6cf
- 建议流程（deployment-plan.json，仅作起点，可依据仓库真实情况调整）：
- [command] install-editable-package: `python -m venv .venv && . .venv/bin/activate && python -m pip install --upgrade pip && python -m pip install -e . && mkdir -p /tmp/alphasift-test-logs /tmp/alphasift-test-data && alphasift --help | tee /tmp/alphasift-test-logs/01-cli-help.log`
- [command] run-repository-tests: `. .venv/bin/activate && export ALPHASIFT_DATA_DIR=/tmp/alphasift-test-data && python -m pytest | tee /tmp/alphasift-test-logs/02-pytest.log`
- [command] verify-cli-strategies-and-audit: `. .venv/bin/activate && export ALPHASIFT_DATA_DIR=/tmp/alphasift-test-data && alphasift strategies && alphasift audit | tee /tmp/alphasift-test-logs/03-strategies-audit.log`
- [command] verify-offline-hotspot-workflow: `. .venv/bin/activate && export ALPHASIFT_DATA_DIR=/tmp/alphasift-test-data && alphasift hotspots --provider none --explain | tee /tmp/alphasift-test-logs/04-hotspots-offline.log`
- [command] verify-no-key-quickstart: `. .venv/bin/activate && export ALPHASIFT_DATA_DIR=/tmp/alphasift-test-data && alphasift quickstart | tee /tmp/alphasift-test-logs/05-quickstart.log`
- [command] verify-python-api-deterministic-call: `. .venv/bin/activate && export ALPHASIFT_DATA_DIR=/tmp/alphasift-test-data && python -c "from alphasift import screen; result = screen('dual_low', use_llm=False); assert hasattr(result, 'picks'); print({'pick_count': len(result.picks), 'result_type': type(result).__name__})" | tee /tmp/alphasift-test-logs/06-python-api.log`
- [command] generate-local-test-report: `python -c "from pathlib import Path; logs=Path('/tmp/alphasift-test-logs'); report=Path('local-test-report.md'); files=sorted(logs.glob('*.log')); report.write_text('# AlphaSift 本地功能测试报告\n\n## 已验证功能与证据\n' + ''.join(f'- `{f.name}`：已执行，完整输出位于 `{f}`。\n' for f in files) + '\n## 未覆盖项\n- 未启用 LLM 排名：需要 GEMINI_API_KEY、OPENAI_API_KEY、DEEPSEEK_API_KEY 或 LiteLLM 兼容配置。\n- 未验证实时市场快照、日线富集及在线热点提供方：默认离线测试不访问 Sina、Eastmoney、AkShare、efinance、Tushare 或其他第三方服务。\n- 未启动 `alphasift serve`：本计划验证 CLI、测试套件和 Python API，不将本地只读 HTTP API 的 HTTP 200 作为替代功能验收。\n- 未验证 DSA 后分析：需要 DSA_API_URL。\n\n## 失败原因\n- 如存在失败，请以对应日志中的 traceback、断言或命令退出信息为准；网络、第三方数据源和凭据相关功能不应在无凭据离线验收中判定为核心功能失败。\n', encoding='utf-8'); print(report)"`

## 目标
1. 阅读 README、测试配置、构建脚本和源码，选择适合该项目类型的本地验证方式；
2. 尽量测试真实功能：优先运行已有测试；并按项目类型验证 CLI 命令、库调用、构建产物、样例、MCP/Agent 能力或安全可启动的服务。不要为了通过校验而虚构 HTTP 服务或端口；
3. 可对源码做最小修复（策略见 input/policy.json），记录所有修改；
4. 完成后必须写入 **D:\digquant\数分项目\HotChasing\runner\workspace\6806f695-ce4a-4d98-aa55-bed3c9816d7b\output/result.json**（绝对路径）：
   ```json
    { "status": "passed|failed", "port": <可选端口号>, "summary": "测试结论", "notes": "关键证据与限制" }
   ```
5. 必须生成 **D:\digquant\数分项目\HotChasing\runner\workspace\6806f695-ce4a-4d98-aa55-bed3c9816d7b\output/report.md**，保持简短，包含：已验证功能、执行命令及结果、未覆盖/受限项、修改内容（如有）。如有修改，再生成 D:\digquant\数分项目\HotChasing\runner\workspace\6806f695-ce4a-4d98-aa55-bed3c9816d7b\output/patch.diff。
6. 不要执行 sudo、不要挂载 Docker Socket、不要访问用户主目录、不要注入真实凭据。

## 验证
Runner 会检查 result.json 与 report.md。仅当建议流程明确包含 http_check 且 result.json 提供端口时，才会额外进行 HTTP 探测。status 必须为 passed 才算成功。
