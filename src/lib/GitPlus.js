const { Git } = require('git-interface');
const util  = require('node:util');
const child_process  = require('child_process');
const exec = util.promisify(child_process.exec);
async function hasGit() {
  let cliOut = true;
  try {
    const { stdout, stderr } = await exec('git --version');
    cliOut = stdout;
  } catch (e) {
    cliOut = false;
  }
  if (cliOut) {
    class GitPlus extends Git {
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
    }
    module.exports = GitPlus;
  }
  else {
    class GitPlus {
      constructor() {
  
      }
    }
    module.exports = GitPlus;
  }
}
hasGit();