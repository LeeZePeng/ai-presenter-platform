import {execFile} from 'node:child_process';
import path from 'node:path';
import {promisify} from 'node:util';
import {describe, it} from 'vitest';

const execFileAsync = promisify(execFile);

describe('GPU path router', () => {
  it('keeps all four GPU worker routes available for presenter generation', async () => {
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
assert module.route_request('/prompt?x=1', ports) == (18188, '/prompt?x=1')
assert module.route_request('/w2/history/abc', ports) == (18190, '/history/abc')
try:
    module.route_request('/w9/history/abc', ports)
    raise AssertionError('unknown GPU worker should fail')
except NotFound:
    pass
`;
    await execFileAsync('python3', ['-c', pythonTest, router]);
  });
});
