import { spawn } from 'node:child_process';
import process from 'node:process';

const rootDir = new URL('..', import.meta.url);
const isWindows = process.platform === 'win32';

const services = [
  {
    name: 'backend',
    command: process.env.VELXIO_PYTHON ?? 'python',
    args: ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8001', '--reload'],
    cwd: new URL('backend/', rootDir),
    env: {
      PYTHONUNBUFFERED: '1',
    },
  },
  {
    name: 'frontend',
    command: isWindows ? 'npm.cmd' : 'npm',
    args: ['run', 'dev'],
    cwd: new URL('frontend/', rootDir),
  },
];

const children = [];
let shuttingDown = false;

function prefixOutput(name, stream, output) {
  let buffered = '';

  stream.on('data', (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';

    for (const line of lines) {
      if (line.length > 0) {
        output.write(`[${name}] ${line}\n`);
      }
    }
  });

  stream.on('end', () => {
    if (buffered.length > 0) {
      output.write(`[${name}] ${buffered}\n`);
      buffered = '';
    }
  });
}

function stopAll(signal = 'SIGTERM') {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const child of children) {
    if (!child.killed && child.exitCode === null) {
      if (isWindows) {
        child.kill(signal);
      } else if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (error.code !== 'ESRCH') {
            throw error;
          }
        }
      }
    }
  }
}

for (const service of services) {
  const child = spawn(service.command, service.args, {
    cwd: service.cwd,
    env: {
      ...process.env,
      ...service.env,
    },
    detached: !isWindows,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  children.push(child);
  prefixOutput(service.name, child.stdout, process.stdout);
  prefixOutput(service.name, child.stderr, process.stderr);

  child.on('error', (error) => {
    console.error(`[${service.name}] failed to start: ${error.message}`);
    stopAll();
    process.exitCode = 1;
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }

    const reason = signal ? `signal ${signal}` : `code ${code}`;
    console.error(`[${service.name}] exited with ${reason}`);
    process.exitCode = code ?? 1;
    stopAll();
  });
}

process.on('SIGINT', () => stopAll('SIGINT'));
process.on('SIGTERM', () => stopAll('SIGTERM'));
