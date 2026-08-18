const RISK = Object.freeze({
  AUTO: 'auto',
  CONFIRM: 'confirm',
  FORCED_CONFIRM: 'forced-confirm',
  FORBIDDEN: 'forbidden',
});

const CAPABILITIES = Object.freeze({
  'context.time': Object.freeze({ risk: RISK.AUTO, description: '读取任务快照中的当前时间' }),
  'context.weather': Object.freeze({ risk: RISK.AUTO, description: '读取已授权的天气摘要' }),
  'life.virtual_activity': Object.freeze({ risk: RISK.AUTO, description: '提出虚拟生活活动建议' }),
  'web.open': Object.freeze({ risk: RISK.CONFIRM, description: '打开外部网页' }),
  'draft.create': Object.freeze({ risk: RISK.CONFIRM, description: '创建本地草稿' }),
  'external.call': Object.freeze({ risk: RISK.CONFIRM, description: '调用外部服务' }),
  'terminal.command': Object.freeze({ risk: RISK.FORCED_CONFIRM, description: '执行终端命令' }),
  'file.write': Object.freeze({ risk: RISK.FORCED_CONFIRM, description: '修改本地文件' }),
  'message.send': Object.freeze({ risk: RISK.FORCED_CONFIRM, description: '发送消息' }),
  'purchase.real': Object.freeze({ risk: RISK.FORBIDDEN, description: '产生真实消费' }),
  'secret.read': Object.freeze({ risk: RISK.FORBIDDEN, description: '读取密钥或凭据' }),
  'permission.bypass': Object.freeze({ risk: RISK.FORBIDDEN, description: '绕过系统权限' }),
  'sensitive.upload': Object.freeze({ risk: RISK.FORBIDDEN, description: '上传高敏感数据' }),
});

function getCapability(id) {
  return typeof id === 'string' && Object.hasOwn(CAPABILITIES, id) ? { id, ...CAPABILITIES[id] } : null;
}

module.exports = { RISK, CAPABILITIES, getCapability };
