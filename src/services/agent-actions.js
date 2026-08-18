const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = function createAgentActions({ getUserData }) {
  async function createDraft({ proposal }) {
    const params = proposal?.parameters;
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('草稿提案不合法');
    if (!Object.keys(params).every((key) => key === 'title' || key === 'body')) throw new TypeError('草稿提案字段不合法');
    const title = typeof params.title === 'string' ? params.title.trim().slice(0, 120) : '';
    const body = typeof params.body === 'string' ? params.body.trim().slice(0, 10_000) : '';
    if (!title || !body) throw new TypeError('草稿标题和正文不能为空');
    const root = path.resolve(getUserData());
    const directory = path.join(root, 'agent-drafts');
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('草稿目录不能是符号链接');
    fs.mkdirSync(directory, { recursive: true });
    const realRoot = fs.realpathSync(root);
    const realDirectory = fs.realpathSync(directory);
    if (realDirectory !== realRoot && !realDirectory.startsWith(`${realRoot}${path.sep}`)) throw new Error('草稿目录越界');
    const file = path.join(realDirectory, `${Date.now()}-${crypto.randomUUID()}.md`);
    fs.writeFileSync(file, `# ${title.replace(/[\r\n]+/g, ' ')}\n\n${body}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return { summary: '本地草稿已创建' };
  }

  return { 'draft.create': createDraft };
};
