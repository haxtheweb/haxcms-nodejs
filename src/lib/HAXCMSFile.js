const path = require('path');
const fs = require('fs-extra');
const Axios = require('axios')
const { HAXCMS } = require('./HAXCMS.js');
const mime = require('mime');
const sharp = require('sharp');
// a site object
class HAXCMSFile
{
  /**
   * Save file into this site, optionally updating reference inside the page
   */
  async save(tmpFile, site, page = null, imageOps = null)
  { 
    var returnData = {};
    // check for a file upload
    if (tmpFile['path']) {
      // get contents of the file if it was uploaded into a variable
      let filedata = tmpFile['path'];
      let pathPart = site.siteDirectory + '/files/';
      // ensure this path exists
      if (!fs.existsSync(pathPart)) {
        fs.mkdirSync(pathPart);
      }
      let newFilename = tmpFile.originalname.replace(/[/\\?%*:|"<>\s]/g, '-');
      const { name, ext } = path.parse(newFilename);
      let counter = 1;
      while (fs.existsSync(path.join(pathPart, newFilename))) {
        newFilename = `${name}_${counter}${ext}`;
        counter++;
      }

      // ensure file is an image, video, docx, pdf, etc. of safe file types to allow uploading
      if (!tmpFile.name.match(/.(jpg|jpeg|png|gif|webm|webp|mp4|mp3|mov|csv|ppt|pptx|xlsx|doc|xls|docx|pdf|rtf|txt|vtt|html|md)$/i)) {
        return {
          'status' : 500,
          '__failed' : {
            'status' : 500,
            'message' : 'File type not allowed',
          }
        };
      }
      let fullpath = path.join(pathPart, newFilename);
      try {
        // support file saves from remote sources
        if (filedata.startsWith('https://') || filedata.startsWith('http://')) {
          downloadAndSaveFile(filedata, fullpath);
        }
        else {
          fs.moveSync(filedata, fullpath);
        }
      }
      catch(err) {
        console.warn(err);
        return {
          status: 500
        };
      }
      //@todo make a way of defining these as returns as well as number to take
      // specialized support for images to do scale and crop stuff automatically
      if (['image/png',
        'image/jpeg',
        'image/gif'
        ].includes(mime.getType(fullpath))
      ) {
        // ensure folders exist
        // @todo comment this all in once we have a better way of doing it
        // front end should dictate stuff like this happening and probably
        // can actually accomplish much of it on its own
        /*try {
            fs.mkdir(path + 'scale-50');
            fs.mkdir(path + 'crop-sm');
        } catch (IOExceptionInterface exopenapiception) {
            echo "An error occurred while creating your directory at " +
                exception.getPath();
        }
        image = new ImageResize(fullpath);
        image
            .scale(50)
            .save(path + 'scale-50/' + upload['name'])
            .crop(100, 100)
            .save(path + 'crop-sm/' + upload['name']);*/
        // fake the file object creation stuff from CMS land
        returnData = {
          'file': {
            'path': fullpath,
            'fullUrl':
                HAXCMS.basePath +
                pathPart +
                newFilename,
            'url' : 'files/' + newFilename,
            'type' : mime.getType(fullpath),
            'name' : newFilename,
            'size' : tmpFile['size']
          }
        };
      }
      else {
        // fake the file object creation stuff from CMS land
        returnData = {
            'file':{
                'path': fullpath,
                'fullUrl' :
                    HAXCMS.basePath +
                    pathPart +
                    tmpFile['name'],
                'url': 'files/' + tmpFile['name'],
                'type': mime.getType(fullpath),
                'name': tmpFile['name'],
                'size': tmpFile['size']
            }
        };
      }
      // perform page level reference saving if available
      if (page != null) {
        // now update the page's metadata to suggest it uses this file. FTW!
        if (!(page.metadata.files)) {
          page.metadata.files = [];
        }
        page.metadata.files.push(returnData['file']);
        await site.updateNode(page);
      }
      // perform scale / crop operations if requested
      if (imageOps != null) {
        switch (imageOps) {
          case 'thumbnail':
            const image = await sharp(fullpath)
            .metadata()
            .then(({ width }) => sharp(fullpath)
              .resize({
                width: 250,
                height: 250,
                fit: sharp.fit.cover,
                position: sharp.strategy.entropy
              })
              .toFile(fullpath)
            );
          break;
        }
      }
      return {
          'status': 200,
          'data': returnData
      };
    }
  }
}

async function downloadAndSaveFile(url, filepath) {
  const response = await Axios({
      url,
      method: 'GET',
      responseType: 'stream'
  });
  return new Promise((resolve, reject) => {
      response.data.pipe(fs.createWriteStream(filepath))
          .on('error', reject)
          .once('close', () => resolve(filepath)); 
  });
}

module.exports = HAXCMSFile;