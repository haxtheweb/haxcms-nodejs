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
      const { stdout } = await exec('git --version');
      this.cliVersion = stdout;
    } catch {
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
   * haxtheweb/issues#3191: git-interface's commit() builds a string and its
   * gitExec() splits it, keeping the single quotes it wrapped the message in,
   * so every commit subject was stored as 'message' with literal quotes.
   * Pass the message as one argument instead: the subject is stored exactly
   * as given (so op-code prefixes parse cleanly) and a message can never be
   * split into extra git arguments.
   */
  commit(message, all = false) {
    if (!this.cliVersion) {
      return undefined;
    }
    const args = ["commit", all ? "-am" : "-m", String(message)];
    return new Promise((resolve, reject) => {
      child_process.execFile(
        "git",
        args,
        { cwd: this.dir },
        (error, stdout, stderr) => {
          const out = String(stdout || "") + String(stderr || "");
          if (error) {
            reject(new Error(out || error.message));
            return;
          }
          resolve(out);
        },
      );
    });
  }
}
module.exports = GitPlus;