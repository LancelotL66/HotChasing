import { useState } from 'react';
import { Bot, CheckCircle2 } from 'lucide-react';
import { getLocalAgentConfig, saveLocalAgentConfig, type LocalAgentConfig } from '../../services/localAgentConfig';

export function LocalAgentSettingsPanel({ t }: { t: (zh: string, en: string) => string }) {
  const [config, setConfig] = useState<LocalAgentConfig>(getLocalAgentConfig);
  const [message, setMessage] = useState('');
  const [testing, setTesting] = useState(false);
  const save = () => { saveLocalAgentConfig(config); setMessage(t('本地 Agent 配置已保存。账号与密钥始终由本机 CLI 管理。', 'Local Agent settings saved. Credentials remain managed by the local CLI.')); };
  const testModel = async () => {
    if (config.agent === 'manual') { setMessage(t('手动模式没有可测试的 CLI。', 'Manual mode has no CLI to test.')); return; }
    if (!window.electronAPI?.runner) { await navigator.clipboard.writeText(config.agent === 'opencode' ? `opencode --model "${config.model}" run "Reply with exactly: HOTCHASING_MODEL_OK"` : config.agent === 'claude-code' ? `claude -p --model "${config.model}" "Reply with exactly: HOTCHASING_MODEL_OK"` : `codex exec --full-auto --model "${config.model}" "Reply with exactly: HOTCHASING_MODEL_OK"`); setMessage(t('测试命令已复制。浏览器无法直接启动本机 CLI。', 'Test command copied. Browsers cannot start local CLIs.')); return; }
    setTesting(true); const result = await window.electronAPI.runner.testModel({ agent: config.agent, model: config.model }); setTesting(false);
    setMessage(result.success ? t(`模型测试通过：${result.output ?? ''}`, `Model test passed: ${result.output ?? ''}`) : `${t('模型测试失败', 'Model test failed')}: ${result.error ?? result.output ?? ''}`);
  };
  return <div className="space-y-5">
    <div className="flex items-center gap-3"><Bot className="h-6 w-6" /><h3 className="text-lg font-semibold">{t('本地 Agent', 'Local Agent')}</h3></div>
    <p className="text-sm text-gray-600 dark:text-text-tertiary">{t('用于 Fork 本地测试。保存后在 Fork 实验室选择项目并点击「开始测试」即可启动本机 CLI；HotChasing 不保存或下发 Agent 账号、API Key 或登录态。', 'Used for Fork local tests. Save settings, then select projects and click Start Test in Fork Lab. HotChasing never stores or distributes CLI accounts, API keys, or sessions.')}</p>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm">{t('执行 Agent', 'Execution Agent')}<select value={config.agent} onChange={(e) => setConfig({ ...config, agent: e.target.value as LocalAgentConfig['agent'] })} className="mt-1 w-full rounded-lg border p-2 dark:bg-white/5"><option value="opencode">OpenCode</option><option value="claude-code">Claude Code</option><option value="codex">Codex CLI</option><option value="manual">{t('手动', 'Manual')}</option></select></label>
      <label className="text-sm">{t('Runner 名称', 'Runner Name')}<input value={config.runnerName} onChange={(e) => setConfig({ ...config, runnerName: e.target.value })} placeholder="My-PC-runner" className="mt-1 w-full rounded-lg border p-2 dark:bg-white/5" /></label>
      <label className="text-sm sm:col-span-2">{t('工作区路径（可选）', 'Workspace Path (optional)')}<input value={config.workspaceRoot} onChange={(e) => setConfig({ ...config, workspaceRoot: e.target.value })} placeholder="D:\\HotChasingRunner" className="mt-1 w-full rounded-lg border p-2 dark:bg-white/5" /></label>
      <label className="text-sm sm:col-span-2">{t('模型（可选）', 'Model (optional)')}<input value={config.model} onChange={(e) => setConfig({ ...config, model: e.target.value })} placeholder="provider/model" className="mt-1 w-full rounded-lg border p-2 dark:bg-white/5" /></label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={config.autoApprove} onChange={(e) => setConfig({ ...config, autoApprove: e.target.checked })} />{t('自动批准测试工作区内的 Agent 权限', 'Auto-approve Agent permissions in the test workspace')}</label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={config.pureMode} onChange={(e) => setConfig({ ...config, pureMode: e.target.checked })} />{t('OpenCode 纯模式（禁用项目外部插件）', 'OpenCode pure mode (disable external project plugins)')}</label>
    </div>
    <div className="flex flex-wrap gap-2"><button onClick={save} className="inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-sm"><CheckCircle2 className="h-4 w-4" />{t('保存配置', 'Save')}</button><button onClick={() => void testModel()} disabled={testing} className="inline-flex items-center gap-1 rounded-lg border border-emerald-600 px-3 py-2 text-sm text-emerald-700 disabled:opacity-50">{testing ? t('测试中…', 'Testing…') : t('测试模型', 'Test Model')}</button></div>
    {config.agent === 'opencode' && !config.autoApprove && <p className="text-xs text-amber-700 dark:text-amber-300">{t('OpenCode 非交互测试需要开启自动批准，否则权限确认无法在 Runner 中回答。', 'OpenCode non-interactive tests require auto-approve; otherwise Runner cannot answer permission prompts.')}</p>}
    {message && <p className="text-sm text-indigo-700 dark:text-indigo-300">{message}</p>}
  </div>;
}
