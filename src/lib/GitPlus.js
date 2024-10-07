const { Git } = require('git-interface');
const util  = require('node:util');
const child_process  = require('child_process');
const exec = util.promisify(child_process.exec);
var hasGit = true;
exec('git --version', error => {
  if (error) {
    hasGit = false;
  }
});
console.log(hasGit);

if (hasGit) {
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