const { Git } = require('git-interface');
const util  = require('node:util');
const child_process  = require('child_process');
const exec = util.promisify(child_process.exec);
class GitPlus extends Git {
  constructor(options) {
    super(options);
    console.log(options);
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
    console.log(this.cliVersion);
    if (this.cliVersion) {
      return super.gitExec(cmd);
    }
  }
}
module.exports = GitPlus;