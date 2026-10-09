import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

// This opt-in test uses only the local endpoint and fixed harmless prompts in the Rust test.
// The credential is read without terminal echo and exists only in the two test processes.
const mutedOutput = new Writable({
  write(_chunk, _encoding, done) { done(); },
});
const input = createInterface({
  input: process.stdin, output: mutedOutput, terminal: Boolean(process.stdin.isTTY),
});
input.on('SIGINT', () => input.close());
let key;
try {
  process.stdout.write('One-use API key for the authorized local model gateway (hidden): ');
  key = await input.question('');
} catch {
  process.stderr.write('\nModel test cancelled.\n');
  process.exitCode = 1;
} finally {
  input.close();
}

if (key !== undefined) {
  process.stdout.write('\n');
  if (!key || Buffer.byteLength(key, 'utf8') > 2048 || /[^\x21-\x7e]/.test(key)) {
    process.stderr.write('Invalid credential format. No request was sent.\n');
    process.exitCode = 1;
  } else {
    const environment = {
      ...process.env,
      ESCOPE_TEST_MODEL_GATEWAY: '1',
      ESCOPE_TEST_MODEL_API_KEY: key,
    };
    const child = spawn('cargo', [
      'test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked',
      'live_authorized_gateway_stream_and_cancel', '--', '--ignored', '--test-threads=1',
    ], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: environment, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
    });
    key = undefined;
    delete environment.ESCOPE_TEST_MODEL_API_KEY;
    child.once('error', () => {
      process.stderr.write('Could not start the Rust model test.\n');
      process.exitCode = 1;
    });
    child.once('exit', (code) => { process.exitCode = code ?? 1; });
  }
}
