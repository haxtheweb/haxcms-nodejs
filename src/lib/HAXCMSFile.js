const path = require('path');
const fs = require('fs-extra');
const Axios = require('axios')
const { HAXCMS } = require('./HAXCMS.js');
const sharp = require('sharp');

const ALLOWED_UPLOAD_EXTENSION_PATTERN = /\.(jpg|jpeg|png|gif|webm|webp|mp4|mp3|mov|csv|ppt|pptx|xlsx|doc|xls|docx|pdf|rtf|txt|vtt|html|md)$/i;
const ALLOWED_MIME_BY_EXTENSION = {
  'jpg': ['image/jpeg'],
  'jpeg': ['image/jpeg'],
  'png': ['image/png'],
  'gif': ['image/gif'],
  'webp': ['image/webp'],
  'webm': ['video/webm', 'audio/webm'],
  'mp4': ['video/mp4'],
  'mp3': ['audio/mpeg', 'audio/mp3'],
  'mov': ['video/quicktime'],
  'csv': ['text/csv', 'text/plain'],
  'ppt': ['application/vnd.ms-powerpoint', 'application/x-ole-storage', 'application/octet-stream'],
  'pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip'],
  'xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'],
  'doc': ['application/msword', 'application/x-ole-storage', 'application/octet-stream'],
  'xls': ['application/vnd.ms-excel', 'application/x-ole-storage', 'application/octet-stream'],
  'docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'],
  'pdf': ['application/pdf'],
  'rtf': ['application/rtf', 'text/rtf', 'text/plain'],
  'txt': ['text/plain'],
  'vtt': ['text/vtt', 'text/plain'],
  'html': ['text/html', 'application/xhtml+xml'],
  'md': ['text/markdown', 'text/plain']
};
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const EXECUTABLE_FILE_EXTENSIONS = [
  'php',
  'php3',
  'php4',
  'php5',
  'php7',
  'php8',
  'phtml',
  'phar',
  'phpt',
  'cgi',
  'pl',
  'py',
  'rb',
  'sh',
  'bash',
  'zsh',
  'ksh',
  'csh',
  'tcsh',
  'asp',
  'aspx',
  'jsp',
  'exe',
  'dll',
  'com',
  'bat',
  'cmd',
  'msi'
];

function stripExecutableExtensionPatterns(fileName) {
  if (!fileName || typeof fileName !== 'string') {
    return '';
  }
  const parsedName = path.parse(fileName);
  const parts = parsedName.base.split('.');
  if (parts.length <= 1) {
    return parsedName.base;
  }
  const safeParts = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) {
      continue;
    }
    if (i > 0) {
      const normalizedPart = part.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (EXECUTABLE_FILE_EXTENSIONS.includes(normalizedPart)) {
        continue;
      }
    }
    safeParts.push(part);
  }
  if (!safeParts.length) {
    return '';
  }
  const sanitizedBaseName = safeParts.join('.');
  if (parsedName.dir && parsedName.dir !== '.') {
    return path.join(parsedName.dir, sanitizedBaseName);
  }
  return sanitizedBaseName;
}

function mimeMatchesAllowed(actualMime, allowedMimes) {
  for (let i = 0; i < allowedMimes.length; i++) {
    const allowedMime = String(allowedMimes[i]).toLowerCase();
    if (allowedMime.endsWith('/*')) {
      const prefix = allowedMime.slice(0, -1);
      if (actualMime.startsWith(prefix)) {
        return true;
      }
    }
    else if (actualMime === allowedMime) {
      return true;
    }
  }
  return false;
}

function readFileSample(filePath, sampleSize = 8192) {
  if (!filePath || !fs.existsSync(filePath)) {
    return Buffer.alloc(0);
  }
  const fileDescriptor = fs.openSync(filePath, 'r');
  const sample = Buffer.alloc(sampleSize);
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fileDescriptor, sample, 0, sampleSize, 0);
  }
  finally {
    fs.closeSync(fileDescriptor);
  }
  return sample.slice(0, bytesRead);
}

function isLikelyTextContent(buffer) {
  if (!buffer || !buffer.length) {
    return false;
  }
  let printableBytes = 0;
  for (let i = 0; i < buffer.length; i++) {
    const value = buffer[i];
    if (value === 0) {
      return false;
    }
    if (value === 9 || value === 10 || value === 13 || value >= 32) {
      printableBytes++;
    }
  }
  return printableBytes / buffer.length >= 0.85;
}

function detectMimeTypeFromContent(filePath) {
  const sample = readFileSample(filePath);
  if (!sample.length) {
    return 'application/octet-stream';
  }
  if (sample.length >= 3 && sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    sample.length >= 8 &&
    sample[0] === 0x89 &&
    sample[1] === 0x50 &&
    sample[2] === 0x4e &&
    sample[3] === 0x47 &&
    sample[4] === 0x0d &&
    sample[5] === 0x0a &&
    sample[6] === 0x1a &&
    sample[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    sample.length >= 6 &&
    sample.toString('ascii', 0, 3) === 'GIF' &&
    (sample.toString('ascii', 3, 6) === '87a' || sample.toString('ascii', 3, 6) === '89a')
  ) {
    return 'image/gif';
  }
  if (
    sample.length >= 12 &&
    sample.toString('ascii', 0, 4) === 'RIFF' &&
    sample.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (
    sample.length >= 4 &&
    sample[0] === 0x1a &&
    sample[1] === 0x45 &&
    sample[2] === 0xdf &&
    sample[3] === 0xa3 &&
    sample.toString('utf8').toLowerCase().indexOf('webm') !== -1
  ) {
    return 'video/webm';
  }
  if (sample.length >= 12 && sample.toString('ascii', 4, 8) === 'ftyp') {
    const majorBrand = sample.toString('ascii', 8, 12);
    if (majorBrand === 'qt  ') {
      return 'video/quicktime';
    }
    return 'video/mp4';
  }
  if (
    sample.length >= 2 &&
    sample[0] === 0xff &&
    (sample[1] & 0xe0) === 0xe0
  ) {
    return 'audio/mpeg';
  }
  if (sample.length >= 3 && sample.toString('ascii', 0, 3) === 'ID3') {
    return 'audio/mpeg';
  }
  if (sample.length >= 5 && sample.toString('ascii', 0, 5) === '%PDF-') {
    return 'application/pdf';
  }
  if (
    sample.length >= 4 &&
    sample[0] === 0x50 &&
    sample[1] === 0x4b &&
    (sample[2] === 0x03 || sample[2] === 0x05 || sample[2] === 0x07) &&
    (sample[3] === 0x04 || sample[3] === 0x06 || sample[3] === 0x08)
  ) {
    return 'application/zip';
  }
  if (
    sample.length >= 8 &&
    sample[0] === 0xd0 &&
    sample[1] === 0xcf &&
    sample[2] === 0x11 &&
    sample[3] === 0xe0 &&
    sample[4] === 0xa1 &&
    sample[5] === 0xb1 &&
    sample[6] === 0x1a &&
    sample[7] === 0xe1
  ) {
    return 'application/x-ole-storage';
  }
  const lowerText = sample.toString('utf8').toLowerCase();
  if (lowerText.indexOf('{\\rtf') === 0 || lowerText.indexOf('{\\rtf') === 1) {
    return 'application/rtf';
  }
  if (
    lowerText.indexOf('<!doctype html') !== -1 ||
    lowerText.indexOf('<html') !== -1 ||
    lowerText.indexOf('<body') !== -1
  ) {
    return 'text/html';
  }
  if (isLikelyTextContent(sample)) {
    return 'text/plain';
  }
  return 'application/octet-stream';
}

async function verifyImageContent(filePath) {
  try {
    const imageData = await sharp(filePath).metadata();
    if (!imageData || !imageData.width || !imageData.height) {
      return false;
    }
    return true;
  }
  catch (e) {
    return false;
  }
}

async function validateUploadMimeAndContent(filePath, fileName) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      valid: false,
      message: 'Uploaded file is missing'
    };
  }
  const extension = path.extname(fileName).replace('.', '').toLowerCase();
  if (!extension || !ALLOWED_MIME_BY_EXTENSION[extension]) {
    return {
      valid: false,
      message: 'File type not allowed'
    };
  }
  const detectedMime = detectMimeTypeFromContent(filePath);
  if (!detectedMime) {
    return {
      valid: false,
      message: 'Unable to determine uploaded file MIME type'
    };
  }
  if (!mimeMatchesAllowed(detectedMime.toLowerCase(), ALLOWED_MIME_BY_EXTENSION[extension])) {
    return {
      valid: false,
      message: 'Detected MIME type ' + detectedMime + ' does not match allowed type for .' + extension
    };
  }
  if (IMAGE_EXTENSIONS.includes(extension)) {
    const isValidImage = await verifyImageContent(filePath);
    if (!isValidImage) {
      return {
        valid: false,
        message: 'Invalid image file content'
      };
    }
  }
  return {
    valid: true,
    detectedMime: detectedMime.toLowerCase()
  };
}
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
      let incomingName = '';
      if (tmpFile.originalname) {
        incomingName = tmpFile.originalname;
      }
      else if (tmpFile.name) {
        incomingName = tmpFile.name;
      }
      let sanitizedIncomingName = stripExecutableExtensionPatterns(incomingName);
      // ensure file is an image, video, docx, pdf, etc. of safe file types to allow uploading
      if (!sanitizedIncomingName || !ALLOWED_UPLOAD_EXTENSION_PATTERN.test(sanitizedIncomingName)) {
        return {
          'status' : 500,
          '__failed' : {
            'status' : 500,
            'message' : 'File type not allowed',
          }
        };
      }
      let newFilename = sanitizedIncomingName.replace(/[\/\\?%*:|"<>]/g, '-').replace(/\s+/g, '-');
      const { name, ext } = path.parse(newFilename);
      let counter = 1;
      while (fs.existsSync(path.join(pathPart, newFilename))) {
        newFilename = `${name}_${counter}${ext}`;
        counter++;
      }
      let sourcePath = filedata;
      let remoteDownloadPath = null;
      if (filedata.startsWith('https://') || filedata.startsWith('http://')) {
        remoteDownloadPath = path.join(
          HAXCMS.configDirectory,
          'tmp',
          'haxcms-upload-' + Date.now() + '-' + Math.floor(Math.random() * 1000000)
        );
        try {
          await downloadAndSaveFile(filedata, remoteDownloadPath);
          sourcePath = remoteDownloadPath;
        }
        catch (err) {
          console.warn(err);
          return {
            'status' : 500,
            '__failed' : {
              'status' : 500,
              'message' : 'Failed to download remote file source',
            }
          };
        }
      }
      const mimeValidation = await validateUploadMimeAndContent(sourcePath, newFilename);
      if (!mimeValidation.valid) {
        if (remoteDownloadPath && fs.existsSync(remoteDownloadPath)) {
          fs.removeSync(remoteDownloadPath);
        }
        return {
          'status' : 500,
          '__failed' : {
            'status' : 500,
            'message' : mimeValidation.message,
          }
        };
      }
      const detectedMimeType = mimeValidation.detectedMime;
      let fullpath = path.join(pathPart, newFilename);
      try {
        fs.moveSync(sourcePath, fullpath);
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
        'image/gif',
        'image/webp'
        ].includes(detectedMimeType)
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
            'type' : detectedMimeType,
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
                    newFilename,
                'url': 'files/' + newFilename,
                'type': detectedMimeType,
                'name': newFilename,
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