import {execFile} from 'node:child_process';
import path from 'node:path';
import {promisify} from 'node:util';
import {describe, it} from 'vitest';

const execFileAsync = promisify(execFile);

describe('upscale_presenter_segments.py', () => {
  it('rejects a second process for the same checkpoint directory', async () => {
    const script = path.resolve('deploy/ai-presenter-video-replica/scripts/upscale_presenter_segments.py');
    const pythonTest = `
import importlib.util, pathlib, sys, tempfile

spec = importlib.util.spec_from_file_location('upscale_presenter_segments', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as temporary:
    checkpoint = pathlib.Path(temporary)
    first = module.acquire_run_lock(checkpoint)
    try:
        try:
            module.acquire_run_lock(checkpoint)
            raise AssertionError('second lock unexpectedly succeeded')
        except RuntimeError as error:
            assert 'already running' in str(error), error
    finally:
        module.fcntl.flock(first.fileno(), module.fcntl.LOCK_UN)
        first.close()
`;
    await execFileAsync('python3', ['-c', pythonTest, script]);
  });

  it('gives the next segment to the first available GPU instead of fixed modulo assignment', async () => {
    const script = path.resolve('deploy/ai-presenter-video-replica/scripts/upscale_presenter_segments.py');
    const pythonTest = `
import importlib.util, pathlib, sys, time
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('upscale_presenter_segments', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
counts = {'slow': 0, 'fast': 0}

def fake_upscale(source, index, server, args):
    counts[server] += 1
    time.sleep(0.20 if server == 'slow' else 0.02)
    return {'outputPath': str(source), 'server': server, 'index': index}

module.upscale_one = fake_upscale
receipts = module.run_upscale_jobs(
    [pathlib.Path(str(index)) for index in range(5)],
    ['slow', 'fast'],
    SimpleNamespace(segment_retries=0, retry_backoff_seconds=0),
)
assert len(receipts) == 5
assert counts == {'slow': 1, 'fast': 4}, counts
assert [receipt['index'] for receipt in receipts] == [1, 2, 3, 4, 5]
`;
    await execFileAsync('python3', ['-c', pythonTest, script]);
  });

  it('retries a failed segment without discarding completed segment results', async () => {
    const script = path.resolve('deploy/ai-presenter-video-replica/scripts/upscale_presenter_segments.py');
    const pythonTest = `
import importlib.util, pathlib, sys
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('upscale_presenter_segments', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
attempts = {}

def flaky_upscale(source, index, server, args):
    attempts[index] = attempts.get(index, 0) + 1
    if index == 3 and attempts[index] == 1:
        raise RuntimeError('temporary provider disconnect')
    return {'outputPath': str(source), 'server': server, 'index': index}

module.upscale_one = flaky_upscale
receipts = module.run_upscale_jobs(
    [pathlib.Path(str(index)) for index in range(4)],
    ['gpu-0', 'gpu-1'],
    SimpleNamespace(segment_retries=2, retry_backoff_seconds=0),
)
assert [receipt['index'] for receipt in receipts] == [1, 2, 3, 4]
assert attempts == {1: 1, 2: 1, 3: 2, 4: 1}, attempts
`;
    await execFileAsync('python3', ['-c', pythonTest, script]);
  });

  it('keeps polling the same ComfyUI prompt across transient history errors', async () => {
    const script = path.resolve('deploy/ai-presenter-video-replica/scripts/upscale_presenter_segments.py');
    const pythonTest = `
import importlib.util, io, sys, urllib.error

spec = importlib.util.spec_from_file_location('upscale_presenter_segments', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
responses = [
    urllib.error.HTTPError('http://gpu/history/prompt-1', 500, 'temporary', {}, io.BytesIO()),
    {},
    {'prompt-1': {'status': {'completed': True}, 'outputs': {}}},
]
calls = []

def fake_http_json(base, route, payload=None, timeout=120):
    calls.append(route)
    response = responses.pop(0)
    if isinstance(response, Exception):
        raise response
    return response

module.http_json = fake_http_json
module.time.sleep = lambda _: None
entry = module.wait_for_output('http://gpu', 'prompt-1', 0, 3)
assert entry['status']['completed'] is True
assert calls == ['/history/prompt-1'] * 3, calls
`;
    await execFileAsync('python3', ['-c', pythonTest, script]);
  });
});
