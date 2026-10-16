const { Git } = require('git-interface');
const util  = require('node:util');
const child_process  = require('child_process');
const exec = util.promisify(child_process.exec);
class GitPlus extends Git {
  constructor(options) {
    super(options);
    this.cliVersion = options.cliVersion || null;
    this.gitTest();
  }
  async gitTest() {
    try {
      const { stdout, stderr } = await exec('git --version');
      this.cliVersion = stdout;
    } catch (e) {
      this.cliVersion = null;
    }
  }
  async revert(count) {
    let counter = 0;
    // sanity check
    if (count < 1) {
        count = 1;
    }
    while (counter != count) {
        await this.gitExec("reset --hard HEAD~1");
        counter++;
    }
    return true;
  }
  gitExec(cmd) {
    if (this.cliVersion) {
      return super.gitExec(cmd);
    }
  }
  /**
   * Security (review 2026-10): git-interface builds `commit -m '<msg>'` as a
   * string and re-tokenizes it on /'[^']+'|[^\s]+/g, so a quote in the message
   * split it into extra git arguments (and every message was stored wrapped
   * in literal quotes). Pass the message as its own argv element instead, no
   * shell, no tokenizing. Mirrors PHP lib/Git.php commit() -> run_args(
   * ['commit', '-v', '-m', $message]) via proc_open with an argv array.
   */
  commit(message, all = false) {
    if (!this.cliVersion) {
      return undefined;
    }
    const args = ['commit', all ? '-am' : '-m', String(message)];
    return new Promise((resolve, reject) => {
      child_process.execFile('git', args, { cwd: this.dir, maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
        const out = String(stdout || '') + String(stderr || '');
        this.emit('out', out);
        if (err) {
          reject(new Error(out || err.message));
          return;
        }
        resolve(out);
      });
    });
  }
}
module.exports = GitPlus;