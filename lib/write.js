'use strict';

// Node.js built-ins

const path = require('path');

// foreign modules

const loadJson = require('load-json-file');
const pify = require('pify');
const fsp = require('@jokeyrhyme/pify-fs');
const isEqual = require('lodash.isequal');
const isString = require('lodash.isstring');
const mkdirpp = pify(require('mkdirp'));
const traverse = require('traverse');
const writeJson = require('write-json-file');

// local modules

const callbackify = require('./callbackify.js').callbackify;
const findReferences = require('./refs.js').findReferences;

// this module

function getPathValue (data, dataPath) {
  const firstStep = data[dataPath[0]];
  if (dataPath.length === 1 || typeof firstStep === 'undefined') {
    return firstStep;
  }
  return getPathValue(firstStep, dataPath.slice(1));
}

function isExtractableValue (value /* : any */) /* : boolean */ {
  return isString(value);
}

/**
returns a copy of the input data,
but checks available references to external files,
and replaces values with matching references (if any)
*/
function pruneReferencedValues (options) { // { data, originPath, refs }
  return new Promise((resolve) => {
    let result;
    /* eslint-disable no-invalid-this */ // traverse module's API
    result = traverse(options.data).map(function () {
      const matchingRefs = options.refs.filter((ref) => {
        return isEqual(ref.path, this.path);
      });
      if (matchingRefs.length) {
        const matchingRef = matchingRefs[0];
        const value = getPathValue(options.data, matchingRef.path);
        if (isExtractableValue(value)) {
          this.update({ $file: matchingRef.target }, true);
        }
      }
    });
    /* eslint-enable no-invalid-this */
    resolve(result);
  });
}

function buildPlan (options) { // { data, originPath, refs, template }
  const writeOps = options.refs
    .map((ref) => { // convert to [ { targetPath, value }, ... ]
      const value = getPathValue(options.data, ref.path);
      const targetPath = path.join(path.dirname(options.originPath), ref.target);
      return { targetPath, value };
    })
    .filter((writeOp) => isExtractableValue(writeOp.value));

  return pruneReferencedValues(options)
    .then((result) => {
      writeOps.push({ targetPath: options.originPath, value: result });
      return writeOps;
    });
}

function getTemplate (options) { // { filePath, template }
  if (options.template) {
    return Promise.resolve(options.template);
  }

  return fsp.access(options.filePath, fsp.F_OK)
    .then(() => loadJson(options.filePath))
    .catch((err) => {
      if (err.code === 'ENOENT') {
        // if file doesn't yet exist, just return an empty template
        return {};
      }
      throw err;
    });
}

function planWriteData (options) { // { data, filePath, template }
  let template;
  return getTemplate(options)
    .then((t) => {
      template = t;
      return findReferences(template);
    })
    .then((refs) => buildPlan({
      data: options.data,
      originPath: options.filePath,
      refs,
      template
    }));
}

function writePlan (options) { // { plan: [ { targetPath, value }, ... ] }
  return Promise.all(options.plan.map((writeOp) => {
    const targetPath = writeOp.targetPath;
    const value = writeOp.value;
    if (typeof value === 'string') {
      return mkdirpp(path.dirname(targetPath))
        .then(() => fsp.writeFile(targetPath, value, 'utf8'));
    }
    return writeJson(targetPath, value, {
      indent: 2,
      sortKeys: true
    });
  }));
}

function writeData (options) { // { data, filePath, template }
  return planWriteData(options)
    .then((plan) => writePlan({ plan }));
}

module.exports = {
  planWriteData: callbackify(planWriteData),
  writeData: callbackify(writeData),
  writePlan: callbackify(writePlan)
};
