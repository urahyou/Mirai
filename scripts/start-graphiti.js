const { spawn } = require('child_process');
const path = require('path');

const venvPython = process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python';
const python = process.env.GRAPHITI_PYTHON || path.join(__dirname, '..', 'graphiti-sidecar', '.venv', venvPython);
const script = path.join(__dirname, '..', 'graphiti-sidecar', 'server.py');
const child = spawn(python, [script], { stdio: 'inherit', env: process.env });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
