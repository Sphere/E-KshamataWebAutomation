/**
 * Interactive Account-page verification.
 *
 * Prompts for the account credentials (and an optional role label) in the
 * terminal, then runs tests/account-verify.spec.ts against them — checking the
 * Account tab is read-only except Language Preference and that every button
 * displays & works.
 *
 *   npm run verify:account
 */
import readline from 'node:readline';
import { spawn } from 'node:child_process';

function ask(query, hide = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hide) {
      // mask typed characters with '*'
      rl._writeToOutput = (str) => {
        if (str.includes(query)) rl.output.write(query);
        else if (str === '\r\n' || str === '\n') rl.output.write('\n');
        else rl.output.write('*');
      };
    }
    rl.question(query, (answer) => {
      rl.close();
      if (hide) process.stdout.write('\n');
      resolve((answer || '').trim());
    });
  });
}

const BASE_URL = process.env.BASE_URL || 'https://ekshamata.aastrika.org';

console.log('\n🔐 Account page verification — enter the credentials to verify.\n');
const email = await ask('  Account email     : ');
if (!email) { console.error('Email is required.'); process.exit(1); }
const password = await ask('  Account password  : ', true);
if (!password) { console.error('Password is required.'); process.exit(1); }
const role = await ask('  Role label (opt.)  : ');

console.log(`\n▶  Verifying Account page for ${email}${role ? ` (${role})` : ''} on ${BASE_URL}\n`);

const child = spawn(
  'npx',
  ['playwright', 'test', 'tests/account-verify.spec.ts', '--project=Chrome', '--headed'],
  {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      BASE_URL,
      ACCOUNT_EMAIL: email,
      ACCOUNT_PASSWORD: password,
      ACCOUNT_ROLE: role,
    },
  },
);
child.on('exit', (code) => process.exit(code ?? 0));
