#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {CompshareInstanceController} from '../server/compshare.js';

const command = process.argv.slice(2);
if (!command.length) throw new Error('Usage: compshare-ssh.ts <command> [args...] | --upload <local> <remote>');

const options = {
  publicKey: process.env.COMPSHARE_PUBLIC_KEY ?? '',
  privateKey: process.env.COMPSHARE_PRIVATE_KEY ?? '',
  instanceId: process.env.COMPSHARE_INSTANCE_ID ?? '',
  region: process.env.COMPSHARE_REGION || 'cn-sh2',
  zone: process.env.COMPSHARE_ZONE || 'cn-sh2-02',
  baseUrl: process.env.COMPSHARE_BASE_URL || 'https://api.compshare.cn',
};
const controller = new CompshareInstanceController(options);
const response = await (controller as unknown as {
  invoke(action: string, extra: Record<string, unknown>): Promise<Record<string, unknown>>;
}).invoke('DescribeCompShareInstance', {UHostIds: [options.instanceId], Limit: 1, Offset: 0});
const instance = ((response.UHostSet as Array<Record<string, unknown>> | undefined) ?? [])[0];
if (!instance) throw new Error('CompShare instance not found');

const login = String(instance.SshLoginCommand ?? '');
const match = login.match(/^ssh\s+-p\s+(\d+)\s+root@([0-9.]+)$/);
if (!match) throw new Error('Unexpected CompShare SSH command');
const [, port, host] = match;
const password = Buffer.from(String(instance.Password ?? ''), 'base64').toString('utf8');
if (!password) throw new Error('CompShare did not return an SSH password');
const upload = command[0] === '--upload';
if (upload && command.length !== 3) throw new Error('Usage: compshare-ssh.ts --upload <local> <remote>');
const remoteArgs = upload
  ? ['scp', '-o', 'StrictHostKeyChecking=accept-new', '-P', port, command[1], `root@${host}:${command[2]}`]
  : ['ssh', '-o', 'StrictHostKeyChecking=accept-new', '-p', port, `root@${host}`, ...command];
const tclCommand = remoteArgs.map((value) => `{${value.replaceAll('\\', '\\\\').replaceAll('}', '\\}')}}`).join(' ');

const expectScript = `
set timeout 120
log_user 1
spawn ${tclCommand}
expect {
  -re {yes/no} { send -- "yes\\r"; exp_continue }
  -re {[Pp]assword:} { send -- "$env(GPU_SSH_PASSWORD)\\r"; exp_continue }
  eof {}
  timeout { exit 124 }
}
catch wait result
exit [lindex $result 3]
`;
const result = spawnSync('/usr/bin/expect', ['-c', expectScript], {
  env: {...process.env, GPU_SSH_PASSWORD: password},
  encoding: 'utf8',
  timeout: 180_000,
  maxBuffer: 16 * 1024 * 1024,
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exitCode = result.status ?? 1;
