import {execFile} from 'node:child_process';
import path from 'node:path';
import {promisify} from 'node:util';
import {describe, it} from 'vitest';

const execFileAsync = promisify(execFile);

describe('GPU path router', () => {
  it('keeps worker routing and strips the private Qwen prefix', async () => {
    const router = path.resolve('deploy/gpu/path_router.py');
    const pythonTest = `
import importlib.util
import sys
import types

class NotFound(Exception):
    def __init__(self, text=''):
        self.text = text

web = types.SimpleNamespace(HTTPNotFound=NotFound, Request=object, StreamResponse=object, Application=object)
aiohttp = types.ModuleType('aiohttp')
aiohttp.ClientSession = object
aiohttp.ClientTimeout = object
aiohttp.web = web
sys.modules['aiohttp'] = aiohttp

spec = importlib.util.spec_from_file_location('path_router', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

ports = [18188, 18189, 18190, 18191]
assert module.route_request('/prompt?x=1', ports, 18787) == (18188, '/prompt?x=1')
assert module.route_request('/w2/history/abc', ports, 18787) == (18190, '/history/abc')
assert module.route_request('/qwen-tts/v1/health', ports, 18787) == (18787, '/v1/health')
assert module.route_request('/qwen-tts/v1/audio/voice-clone?preview=1', ports, 18787) == (18787, '/v1/audio/voice-clone?preview=1')
try:
    module.route_request('/qwen-tts/v1/health', ports, None)
    raise AssertionError('missing Qwen port should fail')
except NotFound:
    pass
`;
    await execFileAsync('python3', ['-c', pythonTest, router]);
  });
});
