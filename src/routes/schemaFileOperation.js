const fs = require('fs-extra');
const path = require('path');
const { HAXCMS } = require('../lib/HAXCMS.js');

const SCHEMA_CONFIG = {
  skeleton: {
    directory: 'skeletons',
    extension: 'json',
  },
};

function fail(res, status, message) {
  return res.status(status).json({
    status,
    message,
  });
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeValue(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeSchema(value) {
  const schema = normalizeValue(value);
  if (!Object.prototype.hasOwnProperty.call(SCHEMA_CONFIG, schema)) {
    return '';
  }
  return schema;
}

function normalizeAction(value) {
  const action = normalizeValue(value);
  if (action !== 'upload' && action !== 'rename' && action !== 'delete') {
    return '';
  }
  return action;
}

function normalizeMachineName(value = '') {
  if (typeof value !== 'string') {
    return '';
  }
  const safeValue = path.basename(value).replace(/\.[^/.]+$/g, '').trim();
  if (!safeValue) {
    return '';
  }
  const normalized = HAXCMS.generateMachineName(safeValue);
  if (
    !normalized ||
    (normalized === 'default' && safeValue.toLowerCase() !== 'default')
  ) {
    return '';
  }
  return normalized;
}

function getRequestValue(req, key) {
  if (
    req &&
    req.body &&
    Object.prototype.hasOwnProperty.call(req.body, key) &&
    typeof req.body[key] !== 'undefined' &&
    req.body[key] !== null
  ) {
    return req.body[key];
  }
  if (
    req &&
    req.query &&
    Object.prototype.hasOwnProperty.call(req.query, key) &&
    typeof req.query[key] !== 'undefined' &&
    req.query[key] !== null
  ) {
    return req.query[key];
  }
  return '';
}

function getSchemaDirectory(schema) {
  const config = SCHEMA_CONFIG[schema];
  return path.join(HAXCMS.configDirectory, 'user', config.directory);
}

function getRelativeLocation(schema, fileName) {
  const config = SCHEMA_CONFIG[schema];
  const configDirectoryName = path.basename(HAXCMS.configDirectory);
  return `${configDirectoryName}/user/${config.directory}/${fileName}`;
}

function getUploadFile(req) {
  if (
    req &&
    req.file &&
    req.file.path &&
    typeof req.file.fieldname === 'string' &&
    req.file.fieldname === 'file'
  ) {
    return req.file;
  }
  if (req && Array.isArray(req.files) && req.files.length > 0) {
    for (let i = 0; i < req.files.length; i++) {
      const item = req.files[i];
      if (
        item &&
        item.path &&
        typeof item.fieldname === 'string' &&
        item.fieldname === 'file'
      ) {
        return item;
      }
    }
  }
  return null;
}

function getFileExtension(value = '') {
  if (typeof value !== 'string') {
    return '';
  }
  return path.extname(value).replace('.', '').toLowerCase();
}

async function resolveExistingSchemaFile(schema, name) {
  const schemaDirectory = getSchemaDirectory(schema);
  const config = SCHEMA_CONFIG[schema];
  const machineName = normalizeMachineName(name);
  if (!machineName) {
    return null;
  }
  if (!(await fs.pathExists(schemaDirectory))) {
    return null;
  }
  let files = [];
  try {
    files = await fs.readdir(schemaDirectory);
  }
  catch (e) {
    return null;
  }
  for (let i = 0; i < files.length; i++) {
    const fileName = files[i];
    const filePath = path.join(schemaDirectory, fileName);
    let stats = null;
    try {
      stats = await fs.stat(filePath);
    }
    catch (e) {
      continue;
    }
    if (!stats || !stats.isFile()) {
      continue;
    }
    if (getFileExtension(fileName) !== config.extension) {
      continue;
    }
    const fileMachineName = normalizeMachineName(
      path.basename(fileName, `.${config.extension}`),
    );
    if (fileMachineName === machineName) {
      return {
        machineName,
        fileName,
        filePath,
        schemaDirectory,
      };
    }
  }
  return null;
}

async function normalizeSkeletonUpload(tmpPath, machineName) {
  const raw = await fs.readFile(tmpPath, 'utf8');
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  }
  catch (e) {
    throw new Error('invalid skeleton json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid skeleton json');
  }
  if (
    !Object.prototype.hasOwnProperty.call(parsed, 'meta') ||
    !parsed.meta ||
    typeof parsed.meta !== 'object' ||
    Array.isArray(parsed.meta)
  ) {
    parsed.meta = {};
  }
  parsed.meta.machineName = machineName;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

async function updateSkeletonMetaMachineName(filePath, machineName) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return;
    }
    if (
      !Object.prototype.hasOwnProperty.call(parsed, 'meta') ||
      !parsed.meta ||
      typeof parsed.meta !== 'object' ||
      Array.isArray(parsed.meta)
    ) {
      parsed.meta = {};
    }
    parsed.meta.machineName = machineName;
    await fs.writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  }
  catch (e) {}
}

/**
 * @OA\Post(
 *    path="/schemaFileOperation",
 *    tags={"cms","authenticated","settings"},
 *    @OA\Response(
 *        response="200",
 *        description="Perform skeleton file upload, rename, or delete operations under the user config directory"
 *   )
 * )
 */
async function schemaFileOperation(req, res) {
  if (
    !req.query.user_token ||
    !HAXCMS.validateRequestToken(req.query.user_token, HAXCMS.getActiveUserName())
  ) {
    return fail(res, 403, 'invalid request token');
  }
  const schema = normalizeSchema(getRequestValue(req, 'schema'));
  if (!schema) {
    return fail(res, 400, 'invalid schema');
  }
  const action = normalizeAction(getRequestValue(req, 'action'));
  if (!action) {
    return fail(res, 400, 'invalid action');
  }
  const config = SCHEMA_CONFIG[schema];
  const schemaDirectory = getSchemaDirectory(schema);
  if (action === 'upload') {
    const upload = getUploadFile(req);
    if (!upload) {
      return fail(res, 400, 'missing file upload');
    }
    if (getFileExtension(upload.originalname || '') !== config.extension) {
      if (upload.path && (await fs.pathExists(upload.path))) {
        await fs.remove(upload.path);
      }
      return fail(
        res,
        400,
        `invalid file type for schema ${schema}; expected .${config.extension}`,
      );
    }
    let machineName = normalizeMachineName(getRequestValue(req, 'name'));
    if (!machineName) {
      machineName = normalizeMachineName(upload.originalname || '');
    }
    if (!machineName) {
      if (upload.path && (await fs.pathExists(upload.path))) {
        await fs.remove(upload.path);
      }
      return fail(res, 400, 'invalid upload name');
    }
    await fs.ensureDir(schemaDirectory);
    const fileName = `${machineName}.${config.extension}`;
    const destinationPath = path.join(schemaDirectory, fileName);
    if (await fs.pathExists(destinationPath)) {
      if (upload.path && (await fs.pathExists(upload.path))) {
        await fs.remove(upload.path);
      }
      return fail(res, 409, 'file already exists');
    }
    try {
      const normalizedSkeleton = await normalizeSkeletonUpload(
        upload.path,
        machineName,
      );
      await fs.writeFile(destinationPath, normalizedSkeleton, 'utf8');
    }
    catch (e) {
      if (upload.path && (await fs.pathExists(upload.path))) {
        await fs.remove(upload.path);
      }
      return fail(res, 400, 'invalid skeleton json');
    }
    if (upload.path && (await fs.pathExists(upload.path))) {
      await fs.remove(upload.path);
    }
    return res.json({
      status: 200,
      data: {
        action,
        schema,
        machineName,
        fileName,
        location: getRelativeLocation(schema, fileName),
        path: destinationPath,
      },
    });
  }
  if (action === 'rename') {
    const existing = await resolveExistingSchemaFile(
      schema,
      getRequestValue(req, 'name') || getRequestValue(req, 'oldName'),
    );
    if (!existing) {
      return fail(res, 404, 'file not found');
    }
    const nextMachineName = normalizeMachineName(getRequestValue(req, 'newName'));
    if (!nextMachineName) {
      return fail(res, 400, 'invalid new name');
    }
    if (nextMachineName === existing.machineName) {
      return fail(res, 400, 'new name must be different');
    }
    const nextFileName = `${nextMachineName}.${config.extension}`;
    const nextPath = path.join(existing.schemaDirectory, nextFileName);
    if (await fs.pathExists(nextPath)) {
      return fail(res, 409, 'file already exists');
    }
    await fs.move(existing.filePath, nextPath, { overwrite: false });
    await updateSkeletonMetaMachineName(nextPath, nextMachineName);
    return res.json({
      status: 200,
      data: {
        action,
        schema,
        machineName: nextMachineName,
        fileName: nextFileName,
        location: getRelativeLocation(schema, nextFileName),
        path: nextPath,
      },
    });
  }
  const existing = await resolveExistingSchemaFile(
    schema,
    getRequestValue(req, 'name') || getRequestValue(req, 'oldName'),
  );
  if (!existing) {
    return fail(res, 404, 'file not found');
  }
  await fs.remove(existing.filePath);
  return res.json({
    status: 200,
    data: {
      action,
      schema,
      machineName: existing.machineName,
      fileName: existing.fileName,
      location: getRelativeLocation(schema, existing.fileName),
      path: existing.filePath,
    },
  });
}

module.exports = schemaFileOperation;
