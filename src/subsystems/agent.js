const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const IPC = require('../contracts/ipc');
const { guarded } = require('../main/ipc-validation');

module.exports = function setup({ ipcMain, app, panels, agentGateway, agentAudit, piExecutionProvider }) {
  if (!agentGateway) return;
  ipcMain.handle(IPC.AgentGetStatus, () => piExecutionProvider?.getStatus?.() || { enabled: false, ready: false });
  ipcMain.handle(IPC.AgentRequestDraft, guarded(IPC.AgentRequestDraft, (description) => agentGateway.request({
    capability: 'draft.create',
    objective: '根据用户描述创建一份本地 Markdown 草稿提案',
    snapshot: { request: description },
  })));
  ipcMain.handle(IPC.AgentListTasks, () => agentGateway.list());
  ipcMain.handle(IPC.AgentApprove, guarded(IPC.AgentApprove, (taskId) => agentGateway.approve(taskId)));
  ipcMain.handle(IPC.AgentReject, guarded(IPC.AgentReject, (taskId) => agentGateway.reject(taskId)));
  ipcMain.handle(IPC.AgentListAudit, () => agentAudit?.list?.() || []);
  ipcMain.handle(IPC.AgentOpenDrafts, () => {
    const directory = path.join(app.getPath('userData'), 'agent-drafts');
    fs.mkdirSync(directory, { recursive: true });
    return shell.openPath(directory);
  });
  ipcMain.handle(IPC.AgentOpenPanel, () => { panels.openAgentPanel(); return true; });
  ipcMain.handle(IPC.AgentClosePanel, () => { panels.closeAgentPanel(); return true; });
};
