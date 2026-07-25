import {execFile} from 'node:child_process';
import path from 'node:path';
import {promisify} from 'node:util';
import {describe, it} from 'vitest';

const execFileAsync = promisify(execFile);

describe('upscale_presenter_segments.py', () => {
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
    SimpleNamespace(),
)
assert len(receipts) == 5
assert counts == {'slow': 1, 'fast': 4}, counts
assert [receipt['index'] for receipt in receipts] == [1, 2, 3, 4, 5]
`;
    await execFileAsync('python3', ['-c', pythonTest, script]);
  });
});
